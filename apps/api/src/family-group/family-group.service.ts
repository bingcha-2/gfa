import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { FamilyGroup } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { QUEUE_NAMES } from "@gfa/shared";

@Injectable()
export class FamilyGroupService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.sync)
    private readonly syncQueue: Queue
  ) {}

  async findAll(accountId?: string) {
    const where = accountId ? { accountId } : {};
    const groups = await this.prisma.familyGroup.findMany({
      where,
      include: {
        _count: { select: { members: true, invites: true } }
      },
      orderBy: { createdAt: "desc" }
    });

    return this.attachAccounts(groups);
  }

  async findOne(id: string) {
    const group = await this.prisma.familyGroup.findUnique({
      where: { id },
      include: {
        members: { orderBy: { createdAt: "desc" } },
        invites: { orderBy: { createdAt: "desc" }, take: 20 }
      }
    });

    if (!group) throw new NotFoundException("Family group not found");

    const [withAccount] = await this.attachAccounts([group]);

    return withAccount;
  }

  async create(data: {
    accountId: string;
    groupName: string;
    maxMembers?: number;
  }) {
    return this.prisma.familyGroup.create({
      data: {
        accountId: data.accountId,
        groupName: data.groupName,
        maxMembers: data.maxMembers ?? 6,
        availableSlots: data.maxMembers ?? 6
      }
    });
  }

  async getMembers(groupId: string) {
    await this.findOne(groupId);

    return this.prisma.familyMember.findMany({
      where: { familyGroupId: groupId },
      orderBy: { createdAt: "desc" }
    });
  }

  async triggerSync(groupId: string) {
    const group = await this.findOne(groupId);

    if (!group.account) {
      throw new NotFoundException("Account not found for family group");
    }

    const job = await this.syncQueue.add(
      "sync-family-group",
      {
        familyGroupId: groupId,
        accountId: group.accountId
      },
      { removeOnComplete: 100, removeOnFail: 500 }
    );

    return { queued: true, jobId: job.id };
  }

  async findAvailableGroup(): Promise<string | null> {
    // Strategy: available slots > 0, lowest risk score first
    const groups = await this.prisma.familyGroup.findMany({
      where: {
        status: "ACTIVE",
        availableSlots: { gt: 0 }
      },
      select: {
        id: true,
        accountId: true
      },
      orderBy: [{ riskScore: "asc" }, { availableSlots: "desc" }]
    });

    for (const group of groups) {
      const account = await this.prisma.account.findUnique({
        where: { id: group.accountId },
        select: { id: true }
      });

      if (account) {
        return group.id;
      }
    }

    return null;
  }

  private async attachAccounts<T extends Pick<FamilyGroup, "accountId">>(groups: T[]) {
    if (!groups.length) {
      return groups.map((group) => ({ ...group, account: null }));
    }

    const accountIds = Array.from(new Set(groups.map((group) => group.accountId)));
    const accounts = await this.prisma.account.findMany({
      where: { id: { in: accountIds } },
      select: {
        id: true,
        name: true,
        loginEmail: true
      }
    });
    const accountMap = new Map(accounts.map((account) => [account.id, account]));

    return groups.map((group) => ({
      ...group,
      account: accountMap.get(group.accountId) ?? null
    }));
  }
}
