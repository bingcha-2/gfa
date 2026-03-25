import { Injectable, NotFoundException, BadRequestException } from "@nestjs/common";
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
    private readonly syncQueue: Queue,
    @InjectQueue(QUEUE_NAMES.remove)
    private readonly removeQueue: Queue
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
        maxMembers: data.maxMembers ?? 5,
        availableSlots: data.maxMembers ?? 5
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

    // Create a Task record first so TaskLogger can write TaskLog rows (avoids P2003)
    const task = await this.prisma.task.create({
      data: {
        type: "SYNC_FAMILY_GROUP",
        familyGroupId: groupId,
        accountId: group.accountId,
        payload: JSON.stringify({ familyGroupId: groupId, accountId: group.accountId })
      }
    });

    try {
      const job = await this.syncQueue.add(
        "sync-family-group",
        { taskId: task.id, familyGroupId: groupId, accountId: group.accountId },
        { removeOnComplete: 100, removeOnFail: 500 }
      );
      return { queued: true, jobId: job.id, taskId: task.id };
    } catch (queueError) {
      await this.prisma.task.delete({ where: { id: task.id } }).catch(() => {});
      throw queueError;
    }
  }

  /**
   * Remove a member from the family group.
   * Creates a REMOVE_MEMBER task and enqueues it to the remove queue.
   */
  async removeMember(groupId: string, memberEmail: string) {
    const group = await this.findOne(groupId);

    if (!group.account) {
      throw new NotFoundException("Account not found for family group");
    }

    // Use transaction to atomically check + mark member as PENDING
    const result = await this.prisma.$transaction(async (tx) => {
      // Verify member exists in the group and is ACTIVE
      const member = await tx.familyMember.findFirst({
        where: {
          familyGroupId: groupId,
          email: memberEmail,
          status: "ACTIVE"
        }
      });

      if (!member) {
        return null; // Signal: not found or already in progress
      }

      // Optimistic lock: mark as PENDING to prevent double-remove race
      await tx.familyMember.update({
        where: { id: member.id },
        data: { status: "PENDING" }
      });

      const task = await tx.task.create({
        data: {
          type: "REMOVE_MEMBER",
          familyGroupId: groupId,
          accountId: group.accountId,
          payload: JSON.stringify({
            familyGroupId: groupId,
            accountId: group.accountId,
            memberEmail
          })
        }
      });

      return task;
    });

    if (!result) {
      throw new BadRequestException(
        `Member ${memberEmail} not found in group or already being removed`
      );
    }

    try {
      await this.removeQueue.add(
        "remove-member",
        {
          taskId: result.id,
          familyGroupId: groupId,
          accountId: group.accountId,
          memberEmail
        },
        { removeOnComplete: 100, removeOnFail: 500 }
      );
    } catch (queueError) {
      // Queue add failed (e.g. Redis down) — rollback PENDING to ACTIVE
      await this.prisma.familyMember.updateMany({
        where: { familyGroupId: groupId, email: memberEmail, status: "PENDING" },
        data: { status: "ACTIVE" }
      }).catch(() => {});

      // Clean up orphaned task
      await this.prisma.task.delete({ where: { id: result.id } }).catch(() => {});

      throw queueError;
    }

    return { queued: true, taskId: result.id };
  }

  /**
   * Find an available family group for a new member.
   * Strategy: earliest created group with available slots first.
   */
  async findAvailableGroup(): Promise<string | null> {
    // Single query with JOIN — no N+1
    const groups = await this.prisma.familyGroup.findMany({
      where: {
        status: "ACTIVE",
        availableSlots: { gt: 0 },
        account: { status: "HEALTHY" },
      },
      select: { id: true },
      orderBy: [{ createdAt: "asc" }],
      take: 1,
    });

    return groups[0]?.id ?? null;
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
