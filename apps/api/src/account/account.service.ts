import { Injectable, NotFoundException } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service";
import { CreateAccountDto, UpdateAccountDto } from "./dto/account.dto";

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
}

