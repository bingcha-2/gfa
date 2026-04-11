import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";

import { PrismaService } from "../prisma/prisma.service";
import { CreateAccountDto, UpdateAccountDto, BulkImportDto } from "./dto/account.dto";
import { QUEUE_NAMES, TASK_TYPES, JOB_DEFAULTS, SyncFamilyGroupPayload } from "@gfa/shared";

function addConvenience<T extends Record<string, unknown>>(account: T): T & { hasTotpSecret: boolean } {
  return { ...account, hasTotpSecret: !!(account as any).totpSecret } as any;
}

@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.sync) private readonly syncQueue: Queue
  ) {}

  private validateLoginPassword(loginPassword: string | undefined, action: "create" | "update") {
    if (loginPassword === undefined) {
      if (action === "create") {
        throw new BadRequestException("loginPassword is required for automated account operations");
      }
      return;
    }

    if (!loginPassword.trim()) {
      throw new BadRequestException("loginPassword cannot be empty");
    }
  }

  async findAll(status?: string) {
    const where = status ? { status: status as any } : {};

    const accounts = await this.prisma.account.findMany({
      where,
      include: {
        _count: { select: { familyGroups: true, tasks: true } }
      },
    });

    // Sort: active subscription first (by expiry desc), suspended last (by suspension time desc)
    const SUB_STATUS_ORDER: Record<string, number> = { ACTIVE: 0, EXPIRED: 1, SUSPENDED: 2 };
    accounts.sort((a, b) => {
      const aOrder = SUB_STATUS_ORDER[a.subscriptionStatus ?? "ACTIVE"] ?? 0;
      const bOrder = SUB_STATUS_ORDER[b.subscriptionStatus ?? "ACTIVE"] ?? 0;
      if (aOrder !== bOrder) return aOrder - bOrder;

      if (a.subscriptionStatus === "SUSPENDED") {
        // Among suspended: more recently suspended first
        const aTime = a.subscriptionStatusUpdatedAt?.getTime() ?? 0;
        const bTime = b.subscriptionStatusUpdatedAt?.getTime() ?? 0;
        return bTime - aTime;
      }

      // Among active / others: longer subscription (later expiry) first
      const aExp = a.subscriptionExpiresAt?.getTime() ?? 0;
      const bExp = b.subscriptionExpiresAt?.getTime() ?? 0;
      return bExp - aExp;
    });

    return accounts.map(addConvenience);
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

    return addConvenience(account);
  }

  /** Return account WITH credentials — only for admin edit forms */
  async findOneWithCredentials(id: string) {
    const account = await this.prisma.account.findUnique({
      where: { id },
      select: {
        loginPassword: true,
        totpSecret: true,
      },
    });

    if (!account) throw new NotFoundException("Account not found");

    return account;
  }

  async create(dto: CreateAccountDto) {
    this.validateLoginPassword(dto.loginPassword, "create");

    const account = await this.prisma.account.create({
      data: {
        name: dto.name,
        loginEmail: dto.loginEmail,
        // Browser pool architecture: adspowerProfileId is no longer bound to a specific account.
        // Use a unique placeholder; the pool selects a free profile dynamically at task time.
        adspowerProfileId: dto.adspowerProfileId || `pending-${randomUUID()}`,
        loginPassword: dto.loginPassword,
        totpSecret: dto.totpSecret,
        notes: dto.notes
      }
    });

    return addConvenience(account);
  }


  async update(id: string, dto: UpdateAccountDto) {
    await this.findOne(id);
    this.validateLoginPassword(dto.loginPassword, "update");

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
        ...(dto.notes !== undefined && { notes: dto.notes }),
        ...(dto.subscriptionExpiresAt !== undefined && {
          subscriptionExpiresAt: dto.subscriptionExpiresAt
            ? new Date(dto.subscriptionExpiresAt)
            : null
        }),
        ...(dto.subscriptionPlan !== undefined && {
          subscriptionPlan: dto.subscriptionPlan || null
        })
      }
    });

    return addConvenience(account);
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
   * Extract TOTP secret from a value that might be a raw key or a 2fa.live URL.
   * - https://2fa.live/tok/fg5nxcsrruy4pser6gidnmuhlqkw2uga → fg5nxcsrruy4pser6gidnmuhlqkw2uga
   * - "2syt gltv 4kxh l37f" → "2SYTGLTV4KXHL37F" (strip spaces, uppercase)
   * - raw key → strip spaces, uppercase
   */
  private extractTotp(raw: string): string {
    const trimmed = raw.trim();
    // Handle 2fa.live URL format
    const urlMatch = trimmed.match(/2fa\.live\/tok\/([a-z0-9]+)/i);
    if (urlMatch) return urlMatch[1].toUpperCase();
    // Strip spaces, hyphens, and padding chars; uppercase for raw TOTP secrets
    return trimmed.replace(/[\s\-=]/g, "").toUpperCase();
  }

  /**
   * Classify a field as recovery email or TOTP secret based on content heuristics.
   */
  private classifyField(value: string): "email" | "totp" {
    const trimmed = value.trim();
    if (trimmed.includes("@")) return "email";
    return "totp";
  }

  /**
   * Bulk import accounts from multi-line text.
   *
   * Supported formats (auto-detected per line):
   *   ---- separator (fields 3+4 auto-detected by content):
   *     email----password----recoveryEmail----totpSecret
   *     email----password----totpSecret----recoveryEmail
   *     email----password----recoveryEmail----https://2fa.live/tok/XXXXX
   *     email----password----recoveryEmail  (no TOTP)
   *   —— separator:
   *     email——password——totpSecret
   *
   * Generates placeholder adspowerProfileId for each account.
   */
  async bulkImport(dto: BulkImportDto) {
    const rawLines = dto.lines.map((l) => l.trim()).filter(Boolean);

    const created: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    // Pre-parse all valid lines before hitting the DB
    type ParsedLine = {
      lineIndex: number;
      loginEmail: string;
      loginPassword: string;
      totpSecret?: string;
      recoveryEmail?: string;
      appPassword?: string;
      notes?: string;
    };

    const parsed: ParsedLine[] = [];

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];

      let loginEmail: string;
      let loginPassword: string;
      let totpSecret: string | undefined;
      let recoveryEmail: string | undefined;
      let appPassword: string | undefined;
      let notes: string | undefined;

      if (line.includes("---")) {
        // Format A: --- or ---- separator, fields 3+4 auto-detected
        const parts = line.split(/-{3,}/).map((p) => p.trim());
        if (parts.length < 2) {
          errors.push(`Line ${i + 1}: not enough fields (need at least email---password)`);
          continue;
        }
        loginEmail = parts[0];
        loginPassword = parts[1];

        // Auto-detect fields 3 and 4 by content (email vs totp/url)
        const extra = parts.slice(2).filter(Boolean);
        for (const field of extra) {
          const kind = this.classifyField(field);
          if (kind === "email" && !recoveryEmail) {
            recoveryEmail = field;
          } else if (kind === "totp" && !totpSecret) {
            totpSecret = this.extractTotp(field);
          } else {
            // Fallback: store extra unclassified field in notes
            notes = notes ? `${notes}; ${field}` : field;
          }
        }
      } else if (line.includes("——")) {
        // Format B: email——password——totpSecret
        const parts = line.split("——").map((p) => p.trim());
        if (parts.length < 2) {
          errors.push(`Line ${i + 1}: not enough fields (need at least email——password)`);
          continue;
        }
        loginEmail = parts[0];
        loginPassword = parts[1];
        totpSecret = parts[2] ? this.extractTotp(parts[2]) : undefined;
      } else {
        errors.push(`Line ${i + 1}: unrecognized format (expected ---, ---- or —— separator)`);
        continue;
      }

      if (!loginEmail.includes("@")) {
        errors.push(`Line ${i + 1}: invalid email "${loginEmail}"`);
        continue;
      }

      if (!loginPassword.trim()) {
        errors.push(`Line ${i + 1}: password cannot be empty`);
        continue;
      }

      parsed.push({ lineIndex: i, loginEmail, loginPassword, totpSecret, recoveryEmail, appPassword, notes });
    }

    // Batch-check duplicates: one query instead of N queries
    const candidateEmails = parsed.map((p) => p.loginEmail);
    const existingAccounts = await this.prisma.account.findMany({
      where: { loginEmail: { in: candidateEmails } },
      select: { loginEmail: true }
    });
    const existingEmailSet = new Set(existingAccounts.map((a) => a.loginEmail));

    for (const item of parsed) {
      const { lineIndex, loginEmail, loginPassword, totpSecret, recoveryEmail, appPassword, notes } = item;

      if (existingEmailSet.has(loginEmail)) {
        skipped.push(loginEmail);
        continue;
      }

      try {
        const placeholderProfileId = `pending-${randomUUID()}`;

        let newAccount: { id: string };
        try {
          // Use select to get id back — avoids a second findUnique call
          newAccount = await this.prisma.account.create({
            data: {
              name: loginEmail.split("@")[0],
              loginEmail,
              loginPassword,
              totpSecret,
              recoveryEmail,
              appPassword,
              adspowerProfileId: placeholderProfileId,
              notes,
              subscriptionExpiresAt: dto.subscriptionExpiresAt ? new Date(dto.subscriptionExpiresAt) : undefined,
            },
            select: { id: true }
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

        // Auto-create a default family group — use id from create() directly, no extra query
        try {
          await this.prisma.familyGroup.create({
            data: {
              groupName: loginEmail.split("@")[0],
              accountId: newAccount.id,
              maxMembers: 5,
              memberCount: 0,
              availableSlots: 5
            }
          });
        } catch {
          // Non-fatal: account was created, group creation failed
          errors.push(`Line ${lineIndex + 1}: account created but group creation failed`);
        }
      } catch (err) {
        // Sanitize error messages to prevent credential leakage
        let msg: string;
        if (err instanceof Error && "code" in err) {
          msg = `database error (code: ${(err as any).code})`;
        } else {
          msg = err instanceof Error ? err.message : String(err);
        }
        errors.push(`Line ${lineIndex + 1}: ${msg}`);
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

  /**
   * Operator confirms manual login has been completed for MANUAL_REVIEW account.
   * Resets account status to HEALTHY and re-queues stuck MANUAL_REVIEW tasks to PENDING
   * so BullMQ will pick them up again on next poll.
   */
  async confirmLogin(id: string): Promise<{ previousStatus: string; tasksRequeued: number }> {
    const account = await this.prisma.account.findUnique({ where: { id } });
    if (!account) throw new NotFoundException("Account not found");

    const previousStatus = account.status;

    // 1. Reset account to HEALTHY
    await this.prisma.account.update({
      where: { id },
      data: { status: "HEALTHY", lastHealthCheckAt: new Date() }
    });

    // 2. Reset any stuck tasks for this account back to PENDING
    // Includes: MANUAL_REVIEW (login challenge), RUNNING (worker crash), FAILED_RETRYABLE (transient error)
    const { count } = await this.prisma.task.updateMany({
      where: {
        accountId: id,
        status: { in: ["MANUAL_REVIEW", "RUNNING", "FAILED_RETRYABLE"] }
      },
      data: {
        status: "PENDING",
        lastErrorCode: null,
        lastErrorMessage: null
      }
    });

    return { previousStatus, tasksRequeued: count };
  }

  /**
   * Triggers a sync task for all family groups under this account.
   * Uses ignoreCooldown to push through any existing login restrictions.
   */
  async syncAccountGroups(id: string): Promise<{ groupsSynced: number }> {
    const account = await this.prisma.account.findUnique({
      where: { id },
      include: { familyGroups: true },
    });

    if (!account) throw new NotFoundException("Account not found");

    if (account.familyGroups.length === 0) {
      throw new BadRequestException("Account has no family groups to sync");
    }

    let groupsSynced = 0;
    for (const group of account.familyGroups) {
      // Create a Task record first so the worker's TaskLogger can write logs/status
      const task = await this.prisma.task.create({
        data: {
          type: "SYNC_FAMILY_GROUP",
          familyGroupId: group.id,
          accountId: id,
          payload: JSON.stringify({
            familyGroupId: group.id,
            accountId: id,
            ignoreCooldown: true,
          }),
        },
      });

      const payload: SyncFamilyGroupPayload = {
        taskId: task.id,
        familyGroupId: group.id,
        accountId: id,
        ignoreCooldown: true,
      };

      try {
        await this.syncQueue.add(TASK_TYPES.syncFamilyGroup, payload, {
          ...JOB_DEFAULTS,
          jobId: `sync-${group.id}-${Date.now()}-manual`,
        });
        groupsSynced++;
      } catch (queueError) {
        // Clean up orphaned task if queue add fails
        await this.prisma.task.delete({ where: { id: task.id } }).catch(() => {});
        throw queueError;
      }
    }

    return { groupsSynced };
  }
}

