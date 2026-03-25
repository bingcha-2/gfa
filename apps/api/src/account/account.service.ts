import { Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";

import { PrismaService } from "../prisma/prisma.service";
import { CreateAccountDto, UpdateAccountDto, BulkImportDto } from "./dto/account.dto";

// Strip sensitive credentials from API responses, add hasTotp flag
function stripSensitive<T extends Record<string, unknown>>(account: T): Omit<T, "loginPassword" | "totpSecret"> & { hasTotpSecret: boolean } {
  const { loginPassword, totpSecret, ...safe } = account;
  return { ...safe, hasTotpSecret: !!totpSecret } as any;
}

@Injectable()
export class AccountService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(status?: string) {
    const where = status ? { status: status as any } : {};

    const accounts = await this.prisma.account.findMany({
      where,
      include: {
        _count: { select: { familyGroups: true, tasks: true } }
      },
      orderBy: { createdAt: "desc" }
    });

    return accounts.map(stripSensitive);
  }

  async findOne(id: string) {
    const account = await this.prisma.account.findUnique({
      where: { id },
      include: {
        familyGroups: {
          select: {
            id: true,
            groupName: true,
            memberCount: true,
            availableSlots: true,
            status: true,
            riskScore: true
          }
        },
        _count: { select: { tasks: true } }
      }
    });

    if (!account) throw new NotFoundException("Account not found");

    return stripSensitive(account);
  }

  async create(dto: CreateAccountDto) {
    const account = await this.prisma.account.create({
      data: {
        name: dto.name,
        loginEmail: dto.loginEmail,
        adspowerProfileId: dto.adspowerProfileId,
        loginPassword: dto.loginPassword,
        totpSecret: dto.totpSecret,
        notes: dto.notes
      }
    });

    return stripSensitive(account);
  }

  async update(id: string, dto: UpdateAccountDto) {
    await this.findOne(id);

    const account = await this.prisma.account.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.adspowerProfileId !== undefined && {
          adspowerProfileId: dto.adspowerProfileId
        }),
        ...(dto.status !== undefined && { status: dto.status as any }),
        ...(dto.loginPassword !== undefined && { loginPassword: dto.loginPassword }),
        ...(dto.totpSecret !== undefined && { totpSecret: dto.totpSecret }),
        ...(dto.notes !== undefined && { notes: dto.notes })
      }
    });

    return stripSensitive(account);
  }

  async delete(id: string) {
    const account = await this.prisma.account.findUnique({
      where: { id },
      select: { id: true, loginEmail: true }
    });

    if (!account) throw new NotFoundException("Account not found");

    // Cascade deletes FamilyGroups + FamilyMembers; Tasks get accountId=null
    await this.prisma.account.delete({ where: { id } });

    return { deleted: true, loginEmail: account.loginEmail };
  }

  /**
   * Bulk import accounts from multi-line text.
   *
   * Supported formats (auto-detected per line):
   *   Format A (---- separator): loginEmail----password----recoveryEmail----appPassword
   *   Format B (—— separator):   loginEmail——password——totpSecret
   *
   * Generates placeholder adspowerProfileId for each account.
   */
  async bulkImport(dto: BulkImportDto) {
    const rawLines = dto.lines.map((l) => l.trim()).filter(Boolean);

    const created: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];

      try {
        let loginEmail: string;
        let loginPassword: string;
        let totpSecret: string | undefined;
        let recoveryEmail: string | undefined;
        let appPassword: string | undefined;

        if (line.includes("----")) {
          // Format A: email----password----recoveryEmail----totpSecret
          const parts = line.split("----").map((p) => p.trim());
          if (parts.length < 2) {
            errors.push(`Line ${i + 1}: not enough fields (need at least email----password)`);
            continue;
          }
          loginEmail = parts[0];
          loginPassword = parts[1];
          recoveryEmail = parts[2] || undefined;
          totpSecret = parts[3] || undefined;
        } else if (line.includes("——")) {
          // Format B: email——password——totpSecret
          const parts = line.split("——").map((p) => p.trim());
          if (parts.length < 2) {
            errors.push(`Line ${i + 1}: not enough fields (need at least email——password)`);
            continue;
          }
          loginEmail = parts[0];
          loginPassword = parts[1];
          totpSecret = parts[2] || undefined;
        } else {
          errors.push(`Line ${i + 1}: unrecognized format (expected ---- or —— separator)`);
          continue;
        }

        // Validate email-like format
        if (!loginEmail.includes("@")) {
          errors.push(`Line ${i + 1}: invalid email "${loginEmail}"`);
          continue;
        }

        // Check duplicate
        const existing = await this.prisma.account.findUnique({
          where: { loginEmail },
          select: { id: true }
        });

        if (existing) {
          skipped.push(loginEmail);
          continue;
        }

        // Generate unique placeholder AdsPower profile ID
        const placeholderProfileId = `pending-${randomUUID()}`;

        try {
          await this.prisma.account.create({
            data: {
              name: loginEmail.split("@")[0],
              loginEmail,
              loginPassword,
              totpSecret,
              recoveryEmail,
              appPassword,
              adspowerProfileId: placeholderProfileId
            }
          });
        } catch (createErr: any) {
          // Handle race condition: another import created the same email concurrently
          if (createErr?.code === "P2002") {
            skipped.push(loginEmail);
            continue;
          }
          throw createErr;
        }

        created.push(loginEmail);

        // Auto-create a default family group for this account
        try {
          const newAccount = await this.prisma.account.findUnique({
            where: { loginEmail },
            select: { id: true }
          });
          if (newAccount) {
            await this.prisma.familyGroup.create({
              data: {
                groupName: loginEmail.split("@")[0],
                accountId: newAccount.id,
                maxMembers: 5,
                memberCount: 0,
                availableSlots: 5
              }
            });
          }
        } catch (groupErr) {
          // Non-fatal: account was created, group creation failed
          errors.push(`Line ${i + 1}: account created but group creation failed`);
        }
      } catch (err) {
        // Sanitize error messages to prevent credential leakage
        let msg: string;
        if (err instanceof Error && 'code' in err) {
          // Prisma error — don't expose full message which may contain field values
          msg = `database error (code: ${(err as any).code})`;
        } else {
          msg = err instanceof Error ? err.message : String(err);
        }
        errors.push(`Line ${i + 1}: ${msg}`);
      }
    }

    return {
      total: rawLines.length,
      created: created.length,
      skipped: skipped.length,
      errorCount: errors.length,
      createdEmails: created,
      skippedEmails: skipped,
      errors
    };
  }
}

