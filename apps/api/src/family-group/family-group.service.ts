import { Injectable, NotFoundException, BadRequestException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { FamilyGroup } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { QUEUE_NAMES, TASK_TYPES, JOB_DEFAULTS } from "@gfa/shared";


@Injectable()
export class FamilyGroupService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.sync)
    private readonly syncQueue: Queue,
    @InjectQueue(QUEUE_NAMES.remove)
    private readonly removeQueue: Queue,
    @InjectQueue(QUEUE_NAMES.invite)
    private readonly inviteQueue: Queue,
    @InjectQueue(QUEUE_NAMES.replace)
    private readonly replaceQueue: Queue
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
        // Exclude REMOVED members from the list — they are audit records, not active slots
        members: {
          where: { status: { not: "REMOVED" } },
          orderBy: { createdAt: "desc" }
        },
        invites: { orderBy: { createdAt: "desc" }, take: 20 }
      }
    });

    if (!group) throw new NotFoundException("Family group not found");

    const [withAccount] = await this.attachAccounts([group]);

    // Attach derived isInGroup field to each member
    return {
      ...withAccount,
      members: withAccount.members.map((m) => ({
        ...m,
        isInGroup: m.status === "ACTIVE",
      })),
    };
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

    const members = await this.prisma.familyMember.findMany({
      where: {
        familyGroupId: groupId,
        status: { not: "REMOVED" }, // REMOVED = audit history, not shown in active list
      },
      orderBy: { createdAt: "desc" }
    });

    // Attach derived isInGroup field
    return members.map((m) => ({ ...m, isInGroup: m.status === "ACTIVE" }));
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
        { ...JOB_DEFAULTS }
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

    // Use transaction to atomically check + mark member as removing
    const result = await this.prisma.$transaction(async (tx) => {
      // Verify member exists in the group and is removable (ACTIVE or PENDING invite)
      const member = await tx.familyMember.findFirst({
        where: {
          familyGroupId: groupId,
          email: memberEmail,
          status: { in: ["ACTIVE", "PENDING"] }
        }
      });

      if (!member) {
        return null; // Signal: not found or already in progress
      }

      // Remember original status for potential rollback
      const originalStatus = member.status;

      // Optimistic lock: mark as REMOVING to prevent double-remove race
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

      return { task, originalStatus, memberId: member.id };
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
          taskId: result.task.id,
          familyGroupId: groupId,
          accountId: group.accountId,
          memberEmail,
          originalMemberStatus: result.originalStatus
        },
        { ...JOB_DEFAULTS }
      );
    } catch (queueError) {
      // Queue add failed — rollback to original status
      await this.prisma.familyMember.updateMany({
        where: { familyGroupId: groupId, email: memberEmail, status: "PENDING" },
        data: { status: result.originalStatus }
      }).catch(() => {});

      // Clean up orphaned task
      await this.prisma.task.delete({ where: { id: result.task.id } }).catch(() => {});

      throw queueError;
    }

    return { queued: true, taskId: result.task.id };
  }

  /**
   * Bulk-remove up to BULK_MAX members in a single request.
   * Each email is processed independently; partial success is allowed.
   */
  async bulkRemove(
    groupId: string,
    memberEmails: string[]
  ): Promise<{
    queued: string[];
    notFound: string[];
    alreadyRemoved: string[];
    failed: string[];
  }> {
    const group = await this.findOne(groupId);
    if (!group.account) throw new NotFoundException("Account not found for family group");

    const result = {
      queued: [] as string[],
      notFound: [] as string[],
      alreadyRemoved: [] as string[],
      failed: [] as string[]
    };

    // R3-B: deduplicate emails at entry to avoid confusing alreadyRemoved false-positives
    const uniqueEmails = [...new Set(memberEmails.map((e) => e.trim().toLowerCase()))];

    for (const normEmail of uniqueEmails) {

      const outcome = await this.prisma.$transaction(async (tx) => {
        const member = await tx.familyMember.findFirst({
          where: { familyGroupId: groupId, email: normEmail }
        });

        if (!member) return "notFound" as const;
        // Only ACTIVE and PENDING (invited-not-yet-accepted) can be removed
        if (member.status !== "ACTIVE" && member.status !== "PENDING") return "alreadyRemoved" as const;

        // Optimistic lock: mark PENDING to prevent concurrent double-remove
        await tx.familyMember.update({ where: { id: member.id }, data: { status: "PENDING" } });

        const task = await tx.task.create({
          data: {
            type: "REMOVE_MEMBER",
            familyGroupId: groupId,
            accountId: group.accountId,
            payload: JSON.stringify({ familyGroupId: groupId, accountId: group.accountId, memberEmail: normEmail })
          }
        });

        return { outcome: "queued" as const, taskId: task.id, memberId: member.id };
      });

      if (outcome === "notFound") {
        result.notFound.push(normEmail);
      } else if (outcome === "alreadyRemoved") {
        result.alreadyRemoved.push(normEmail);
      } else {
        // Bug fix #1: roll back PENDING + delete orphan Task if queue.add fails
        try {
          await this.removeQueue.add(
            "remove-member",
            { taskId: outcome.taskId, familyGroupId: groupId, accountId: group.accountId, memberEmail: normEmail },
            {
              ...JOB_DEFAULTS,
              jobId: `remove:${groupId}:${normEmail}` // deduplication key
            }
          );
          result.queued.push(normEmail);
        } catch (queueError) {
          // Rollback PENDING → ACTIVE so the member can be retried later
          await this.prisma.familyMember.update({
            where: { id: outcome.memberId },
            data: { status: "ACTIVE" }
          }).catch(() => {});
          // Delete orphaned Task record
          await this.prisma.task.delete({ where: { id: outcome.taskId } }).catch(() => {});
          // Individual email failure should not abort the rest of the batch.
          // Surface it explicitly so callers can retry instead of treating it as business-state.
          result.failed.push(normEmail);
        }
      }
    }

    return result;
  }

  /**
   * Bulk-invite up to BULK_MAX emails in a single request.
   * Checks availableSlots before enqueuing; rejects all if capacity is insufficient.
   *
   * R2-A fix: slot check + decrement are now inside a single $transaction to prevent
   * concurrent over-invite (two simultaneous requests both passing the slot check).
   */
  async bulkInvite(
    groupId: string,
    emails: string[]
  ): Promise<{
    queued: string[];
    rejected: string[];
    reason?: string;
  }> {
    const group = await this.findOne(groupId);
    if (!group.account) throw new NotFoundException("Account not found for family group");

    const normEmails = emails.map((e) => e.trim().toLowerCase());
    const uniqueEmails = [...new Set(normEmails)];

    // Atomically check slots and reserve them using a DB transaction.
    // This prevents two concurrent requests both seeing the same availableSlots value.
    const reserved = await this.prisma.$transaction(async (tx) => {
      const freshGroup = await tx.familyGroup.findUnique({
        where: { id: groupId },
        select: { availableSlots: true }
      });

      if (!freshGroup) return null;
      if (freshGroup.availableSlots < uniqueEmails.length) return 0; // insufficient

      // Atomically decrement availableSlots to reserve the slots
      await tx.familyGroup.update({
        where: { id: groupId },
        data: { availableSlots: { decrement: uniqueEmails.length } }
      });

      return uniqueEmails.length; // slots reserved
    });

    if (reserved === null) throw new NotFoundException("Family group not found");
    if (reserved === 0) {
      // Re-read to get fresh count for error message
      const current = await this.prisma.familyGroup.findUnique({
        where: { id: groupId },
        select: { availableSlots: true }
      });
      return {
        queued: [],
        rejected: uniqueEmails,
        reason: `Not enough slots: ${current?.availableSlots ?? 0} available, ${uniqueEmails.length} requested`
      };
    }

    const result = { queued: [] as string[], rejected: [] as string[] };
    let releasedSlots = 0; // track how many slots to give back on queue failures

    for (const email of uniqueEmails) {
      let taskId: string | null = null;

      try {
        const task = await this.prisma.task.create({
          data: {
            type: "INVITE_MEMBER",
            familyGroupId: groupId,
            accountId: group.accountId,
            payload: JSON.stringify({ familyGroupId: groupId, accountId: group.accountId, userEmail: email })
          }
        });
        taskId = task.id;

        await this.inviteQueue.add(
          "invite-member",
          { taskId, familyGroupId: groupId, accountId: group.accountId, userEmail: email },
          {
            ...JOB_DEFAULTS,
            jobId: `invite:${groupId}:${email}` // deduplication key
          }
        );
        result.queued.push(email);
      } catch (queueError) {
        if (taskId) {
          await this.prisma.task.delete({ where: { id: taskId } }).catch(() => {});
        }
        result.rejected.push(email);
        releasedSlots++;
      }
    }

    // Return any failed slots back to the pool
    if (releasedSlots > 0) {
      await this.prisma.familyGroup.update({
        where: { id: groupId },
        data: { availableSlots: { increment: releasedSlots } }
      }).catch(() => {});
    }

    return result;
  }

  /**
   * Query recent tasks for a family group, with optional type and since filters.
   * Used by external scheduling systems to poll task status.
   */
  async getTasks(
    groupId: string,
    opts: { type?: string; since?: string }
  ) {
    await this.findOne(groupId); // 404 guard

    const where: Record<string, any> = { familyGroupId: groupId };

    // Validate against the shared TaskType contract so the endpoint stays aligned
    // with Prisma/shared enums as task types evolve.
    const KNOWN_TASK_TYPES = Object.values(TASK_TYPES);
    if (opts.type) {
      if (!KNOWN_TASK_TYPES.includes(opts.type as (typeof KNOWN_TASK_TYPES)[number])) {
        throw new BadRequestException(`Unknown task type: "${opts.type}". Valid types: ${KNOWN_TASK_TYPES.join(", ")}`);
      }
      where.type = opts.type;
    }
    if (opts.since) {
      // Bug fix #5: validate ISO8601 before passing to Prisma (avoids 500 on bad input)
      const since = new Date(opts.since);
      if (isNaN(since.getTime())) {
        throw new BadRequestException(`Invalid 'since' date: "${opts.since}"`);
      }
      where.createdAt = { gte: since };
    }

    return this.prisma.task.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200
    });
  }

  /**
   * Cross-group bulk remove: accepts any number of emails, auto-discovers which
   * family group each belongs to, then removes them grouped per-account.
   * Partial success is allowed (emails not found or already removed are reported separately).
   */
  async crossBulkRemove(memberEmails: string[]): Promise<{
    queued: string[];
    notFound: string[];
    alreadyRemoved: string[];
    failed: string[];
  }> {
    const result = {
      queued: [] as string[],
      notFound: [] as string[],
      alreadyRemoved: [] as string[],
      failed: [] as string[]
    };

    const normEmails = [...new Set(memberEmails.map((e) => e.trim().toLowerCase()))];

    // Single query: look up ALL records for these emails (any status)
    const members = await this.prisma.familyMember.findMany({
      where: { email: { in: normEmails } },
      include: { familyGroup: { select: { accountId: true } } }
    });

    // email is "notFound" only if it has NO DB record at all.
    // If it has only REMOVED/PENDING records, report as alreadyRemoved.
    const emailStatusMap = new Map<string, string>(); // email -> best status
    for (const m of members) {
      const existing = emailStatusMap.get(m.email);
      // Prefer ACTIVE over any other status
      if (!existing || m.status === "ACTIVE") {
        emailStatusMap.set(m.email, m.status);
      }
    }

    for (const email of normEmails) {
      const status = emailStatusMap.get(email);
      if (!status) result.notFound.push(email);                   // truly absent
      else if (status !== "ACTIVE") result.alreadyRemoved.push(email); // present but inactive
    }

    // R2-C fix: deduplicate ACTIVE members by email — keep only the first ACTIVE group
    // per email to prevent double-remove if an email appears in multiple groups.
    const byGroup = new Map<string, string[]>();
    const processedEmails = new Set<string>();
    for (const m of members) {
      if (m.status !== "ACTIVE") continue;
      if (processedEmails.has(m.email)) continue; // skip duplicate groups for same email
      processedEmails.add(m.email);
      const list = byGroup.get(m.familyGroupId) ?? [];
      list.push(m.email);
      byGroup.set(m.familyGroupId, list);
    }

    // Process group by group, reusing existing bulkRemove logic
    for (const [groupId, emails] of byGroup) {
      const partial = await this.bulkRemove(groupId, emails);
      result.queued.push(...partial.queued);
      result.notFound.push(...partial.notFound);
      result.alreadyRemoved.push(...partial.alreadyRemoved);
      result.failed.push(...partial.failed);
    }

    return result;
  }

  /**
   * Cross-group bulk invite: distributes emails across available groups automatically.
   * Groups are filled in createdAt-ASC order (earliest first).
   * Returns per-group allocation and any emails that could not be placed.
   */
  async crossBulkInvite(emails: string[]): Promise<{
    allocated: Array<{ groupId: string; accountId: string; queued: string[] }>;
    unplaceable: string[];
    alreadyActive: string[];
    reason?: string;
  }> {
    const normEmails = [...new Set(emails.map((e) => e.trim().toLowerCase()))];

    // R3-C: filter out emails that already have an ACTIVE member record in any group
    // to avoid double-inviting existing members.
    const existingMembers = await this.prisma.familyMember.findMany({
      where: { email: { in: normEmails }, status: "ACTIVE" },
      select: { email: true }
    });
    const existingEmails = new Set(existingMembers.map((m) => m.email));
    const alreadyActive = normEmails.filter((e) => existingEmails.has(e));
    const freshEmails = normEmails.filter((e) => !existingEmails.has(e));

    if (freshEmails.length === 0) {
      return {
        allocated: [],
        unplaceable: [],
        alreadyActive,
        reason: "All provided emails are already active members"
      };
    }

    // Fetch all available groups with remaining slots, ordered earliest-first
    const availableGroups = await this.prisma.familyGroup.findMany({
      where: {
        status: "ACTIVE",
        availableSlots: { gt: 0 },
        account: { status: "HEALTHY" }
      },
      select: { id: true, accountId: true, availableSlots: true },
      orderBy: { createdAt: "asc" }
    });

    const totalSlots = availableGroups.reduce((sum, g) => sum + g.availableSlots, 0);

    if (totalSlots === 0) {
      return {
        allocated: [],
        unplaceable: freshEmails,
        alreadyActive,
        reason: "No available slots across any active family group"
      };
    }

    const allocated: Array<{ groupId: string; accountId: string; queued: string[] }> = [];
    let remaining = [...freshEmails];

    for (const group of availableGroups) {
      if (remaining.length === 0) break;

      const chunk = remaining.splice(0, group.availableSlots);
      const partial = await this.bulkInvite(group.id, chunk);

      if (partial.queued.length > 0) {
        allocated.push({ groupId: group.id, accountId: group.accountId, queued: partial.queued });
      }

      // If bulkInvite rejected some (e.g. slot race), put them back into remaining
      if (partial.rejected.length > 0) {
        remaining = [...partial.rejected, ...remaining];
      }
    }

    return {
      allocated,
      unplaceable: remaining,
      alreadyActive,
      ...(remaining.length > 0 ? { reason: `${remaining.length} email(s) could not be placed — insufficient total slots` } : {})
    };
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


  /**
   * Lookup which family group a member belongs to, along with their
   * associated redeem code and order expiry time.
   *
   * Strategy:
   * 1. Try FamilyMember table first (prefer ACTIVE status)
   * 2. If no FamilyMember record, fallback to Order table by userEmail
   *    — covers users who redeemed a code but haven't been added to a group yet
   */
  async lookupByMemberEmail(email: string): Promise<{
    found: boolean;
    memberStatus?: string;
    member?: {
      id: string;
      displayName: string | null;
      joinedAt: string | null;
    };
    familyGroup?: {
      id: string;
      groupName: string;
      accountEmail: string | null;
      status: string;
      memberCount: number;
      maxMembers: number;
    };
    order?: {
      id: string;
      orderNo: string;
      status: string;
      code: string | null;
      codeType: string | null;
      expiresAt: string | null;
      createdAt: string;
    };
  }> {
    const normalizedEmail = email.trim().toLowerCase();

    // --- Step 1: find FamilyMember records (prefer ACTIVE) ---
    // Try exact match first; fall back to case-insensitive raw SQL for SQLite
    let members = await this.prisma.familyMember.findMany({
      where: { email: normalizedEmail },
      include: {
        familyGroup: {
          include: {
            account: { select: { loginEmail: true } }
          }
        }
      },
      orderBy: { createdAt: "desc" }
    });

    // Fallback: case-insensitive lookup for records stored with mixed-case email
    if (members.length === 0) {
      const rows = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM FamilyMember WHERE LOWER(email) = ? ORDER BY createdAt DESC`,
        normalizedEmail
      );
      if (rows.length > 0) {
        members = await this.prisma.familyMember.findMany({
          where: { id: { in: rows.map((r) => r.id) } },
          include: {
            familyGroup: {
              include: {
                account: { select: { loginEmail: true } }
              }
            }
          },
          orderBy: { createdAt: "desc" }
        });
      }
    }

    if (members.length > 0) {
      // Pick ACTIVE first, fallback to latest record
      const member = members.find((m) => m.status === "ACTIVE") ?? members[0];
      const fg = member.familyGroup;

      // Find the most recent order tied to this email & group
      // Try exact match first, then case-insensitive fallback
      let order = await this.prisma.order.findFirst({
        where: {
          userEmail: normalizedEmail,
          ...(fg ? { familyGroupId: fg.id } : {})
        },
        include: { redeemCode: { select: { code: true, codeType: true } } },
        orderBy: { createdAt: "desc" }
      });

      // Fallback: case-insensitive order lookup
      if (!order && fg) {
        const orderRows = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id FROM "Order" WHERE LOWER(userEmail) = ? AND familyGroupId = ? ORDER BY createdAt DESC LIMIT 1`,
          normalizedEmail,
          fg.id
        );
        if (orderRows.length > 0) {
          order = await this.prisma.order.findFirst({
            where: { id: orderRows[0].id },
            include: { redeemCode: { select: { code: true, codeType: true } } }
          });
        }
      }

      return {
        found: true,
        memberStatus: member.status,
        member: {
          id: member.id,
          displayName: member.displayName,
          joinedAt: member.joinedAt?.toISOString() ?? null,
        },
        familyGroup: fg
          ? {
              id: fg.id,
              groupName: fg.groupName,
              accountEmail: fg.account?.loginEmail ?? null,
              status: fg.status,
              memberCount: fg.memberCount,
              maxMembers: fg.maxMembers,
            }
          : undefined,
        order: order
          ? {
              id: order.id,
              orderNo: order.orderNo,
              status: order.status,
              code: order.redeemCode?.code ?? null,
              codeType: order.redeemCode?.codeType ?? null,
              expiresAt: order.expiresAt?.toISOString() ?? null,
              createdAt: order.createdAt.toISOString(),
            }
          : undefined
      };
    }

    // --- Step 2: no FamilyMember — fallback to Order table ---
    // Removed codeType filter: order may have been created from any code type,
    // and the filter was causing valid orders to be missed.
    let order = await this.prisma.order.findFirst({
      where: {
        userEmail: normalizedEmail,
      },
      include: {
        redeemCode: { select: { code: true, codeType: true } },
        familyGroup: {
          include: { account: { select: { loginEmail: true } } }
        }
      },
      orderBy: { createdAt: "desc" }
    });

    // Fallback: case-insensitive order lookup for legacy/mixed-case records
    if (!order) {
      const rows = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM "Order" WHERE LOWER(userEmail) = ? ORDER BY createdAt DESC LIMIT 1`,
        normalizedEmail
      );
      if (rows.length > 0) {
        order = await this.prisma.order.findFirst({
          where: { id: rows[0].id },
          include: {
            redeemCode: { select: { code: true, codeType: true } },
            familyGroup: {
              include: { account: { select: { loginEmail: true } } }
            }
          }
        });
      }
    }

    if (!order) {
      return { found: false };
    }

    const fg = order.familyGroup;
    return {
      found: true,
      memberStatus: "NO_MEMBER_RECORD", // has order but no FamilyMember entry yet
      familyGroup: fg
        ? {
            id: fg.id,
            groupName: fg.groupName,
            accountEmail: fg.account?.loginEmail ?? null,
            status: fg.status,
            memberCount: fg.memberCount,
            maxMembers: fg.maxMembers,
          }
        : undefined,
      order: {
        id: order.id,
        orderNo: order.orderNo,
        status: order.status,
        code: order.redeemCode?.code ?? null,
        codeType: order.redeemCode?.codeType ?? null,
        expiresAt: order.expiresAt?.toISOString() ?? null,
        createdAt: order.createdAt.toISOString(),
      }
    };
  }

  /**
   * Toggle auto-assign for a family group.
   * ACTIVE → MANUAL_ONLY (skipped by all auto-assign paths)
   * MANUAL_ONLY → ACTIVE (re-enables auto-assign)
   * DISABLED → throws 400 (cannot toggle a fully disabled group)
   */
  async toggleAutoAssign(groupId: string): Promise<{ id: string; status: string }> {
    const group = await this.prisma.familyGroup.findUnique({
      where: { id: groupId },
      select: { id: true, status: true }
    });

    if (!group) throw new NotFoundException("Family group not found");

    if (group.status === "DISABLED") {
      throw new BadRequestException("Cannot toggle auto-assign on a DISABLED group");
    }

    const nextStatus = group.status === "ACTIVE" ? "MANUAL_ONLY" : "ACTIVE";

    const updated = await this.prisma.familyGroup.update({
      where: { id: groupId },
      data: { status: nextStatus },
      select: { id: true, status: true }
    });

    return updated;
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
        loginEmail: true,
        subscriptionExpiresAt: true,
        subscriptionStatus: true,
        subscriptionPlan: true
      }
    });
    const accountMap = new Map(accounts.map((account) => [account.id, account]));

    return groups.map((group) => ({
      ...group,
      account: accountMap.get(group.accountId) ?? null
    }));
  }

  /**
   * Replace a member in a family group (kick old + invite new).
   * Does NOT require an orderId — used from the group management panel.
   *
   * CAS guard: atomically verifies the target member is still removable
   * (ACTIVE or PENDING) before creating a task, preventing double-click races.
   */
  async replaceMember(
    groupId: string,
    targetMemberEmail: string,
    newUserEmail: string
  ) {
    // Normalize emails to lowercase — Gmail is case-insensitive
    targetMemberEmail = targetMemberEmail.trim().toLowerCase();
    newUserEmail = newUserEmail.trim().toLowerCase();
    const group = await this.prisma.familyGroup.findUnique({
      where: { id: groupId }
    });
    if (!group) throw new NotFoundException("Family group not found");

    // Atomic: check member + create task in one transaction
    const result = await this.prisma.$transaction(async (tx) => {
      // Verify target member exists and is in a removable state
      const member = await tx.familyMember.findFirst({
        where: {
          familyGroupId: groupId,
          email: targetMemberEmail,
          status: { in: ["ACTIVE", "PENDING"] }
        }
      });

      if (!member) {
        return null; // Not found or already being processed
      }

      const task = await tx.task.create({
        data: {
          type: TASK_TYPES.replaceMember,
          familyGroupId: group.id,
          accountId: group.accountId,
          payload: JSON.stringify({
            familyGroupId: group.id,
            accountId: group.accountId,
            targetMemberEmail,
            newUserEmail,
            reason: "ADMIN_REPLACE"
          })
        }
      });

      return { task, memberId: member.id };
    });

    if (!result) {
      throw new BadRequestException(
        `Member ${targetMemberEmail} not found in group or already being replaced/removed`
      );
    }

    try {
      await this.replaceQueue.add(
        "replace-member",
        {
          taskId: result.task.id,
          familyGroupId: group.id,
          accountId: group.accountId,
          targetMemberEmail,
          newUserEmail
        },
        { ...JOB_DEFAULTS }
      );
    } catch (queueError) {
      // Queue add failed — clean up orphaned task
      await this.prisma.task.delete({ where: { id: result.task.id } }).catch(() => {});
      throw queueError;
    }

    return { queued: true, taskId: result.task.id };
  }

  // ========== Transfer Batch ==========

  /**
   * Create a cross-group transfer: remove members from source, then auto-invite to target.
   * If memberEmails is omitted, all ACTIVE non-owner members are transferred.
   */
  async createTransfer(data: {
    sourceGroupId: string;
    targetGroupId: string;
    memberEmails?: string[];
  }): Promise<{
    batchId: string;
    phase: string;
    totalMembers: number;
    memberEmails: string[];
    removeTaskIds: string[];
  }> {
    const { sourceGroupId, targetGroupId } = data;

    if (sourceGroupId === targetGroupId) {
      throw new BadRequestException("Source and target groups cannot be the same");
    }

    // Validate both groups exist and have accounts
    const sourceGroup = await this.prisma.familyGroup.findUnique({
      where: { id: sourceGroupId },
      include: { account: { select: { id: true, loginEmail: true } } },
    });
    if (!sourceGroup) throw new NotFoundException("Source group not found");
    if (!sourceGroup.account) throw new NotFoundException("Source group has no account");

    const targetGroup = await this.prisma.familyGroup.findUnique({
      where: { id: targetGroupId },
      include: { account: { select: { id: true } } },
    });
    if (!targetGroup) throw new NotFoundException("Target group not found");
    if (!targetGroup.account) throw new NotFoundException("Target group has no account");

    // Resolve member list
    let emails: string[];
    if (data.memberEmails && data.memberEmails.length > 0) {
      emails = [...new Set(data.memberEmails.map(e => e.trim().toLowerCase()))];
    } else {
      // Default: all ACTIVE non-owner members
      const ownerEmail = sourceGroup.account.loginEmail?.toLowerCase() ?? "";
      const members = await this.prisma.familyMember.findMany({
        where: {
          familyGroupId: sourceGroupId,
          status: "ACTIVE",
          role: { not: "OWNER" },
        },
        select: { email: true },
      });
      emails = members
        .map(m => m.email.toLowerCase())
        .filter(e => e !== ownerEmail);
    }

    if (emails.length === 0) {
      throw new BadRequestException("No eligible members to transfer");
    }

    // Check for existing active transfer on this source group
    const existingBatch = await this.prisma.transferBatch.findFirst({
      where: {
        sourceGroupId,
        phase: { in: ["REMOVING", "INVITING"] },
      },
    });
    if (existingBatch) {
      throw new BadRequestException(
        `Source group already has an active transfer (batch ${existingBatch.id}, phase ${existingBatch.phase})`
      );
    }

    // Create TransferBatch record
    const batch = await this.prisma.transferBatch.create({
      data: {
        sourceGroupId,
        targetGroupId,
        memberEmails: JSON.stringify(emails),
        totalMembers: emails.length,
        phase: "REMOVING",
      },
    });

    // Create remove tasks with transferBatchId
    const removeTaskIds: string[] = [];

    for (const email of emails) {
      // Optimistic lock: mark member PENDING
      const member = await this.prisma.familyMember.findFirst({
        where: { familyGroupId: sourceGroupId, email, status: { in: ["ACTIVE", "PENDING"] } },
      });

      const task = await this.prisma.task.create({
        data: {
          type: "REMOVE_MEMBER",
          familyGroupId: sourceGroupId,
          accountId: sourceGroup.account.id,
          transferBatchId: batch.id,
          payload: JSON.stringify({
            familyGroupId: sourceGroupId,
            accountId: sourceGroup.account.id,
            memberEmail: email,
          }),
        },
      });

      // Mark member as PENDING to prevent duplicate operations
      if (member && member.status === "ACTIVE") {
        await this.prisma.familyMember.update({
          where: { id: member.id },
          data: { status: "PENDING" },
        }).catch(() => {});
      }

      try {
        await this.removeQueue.add(
          "remove-member",
          {
            taskId: task.id,
            familyGroupId: sourceGroupId,
            accountId: sourceGroup.account.id,
            memberEmail: email,
          },
          {
            ...JOB_DEFAULTS,
            jobId: `transfer-remove:${batch.id}:${email}`,
          }
        );
        removeTaskIds.push(task.id);
      } catch {
        // Rollback: delete task, restore member status
        await this.prisma.task.delete({ where: { id: task.id } }).catch(() => {});
        if (member) {
          await this.prisma.familyMember.update({
            where: { id: member.id },
            data: { status: "ACTIVE" },
          }).catch(() => {});
        }
      }
    }

    if (removeTaskIds.length === 0) {
      // All queue adds failed — clean up batch
      await this.prisma.transferBatch.delete({ where: { id: batch.id } }).catch(() => {});
      throw new BadRequestException("Failed to enqueue any remove tasks");
    }

    return {
      batchId: batch.id,
      phase: "REMOVING",
      totalMembers: emails.length,
      memberEmails: emails,
      removeTaskIds,
    };
  }

  /**
   * Get transfer batch status with per-member detail.
   */
  async getTransferStatus(batchId: string) {
    const batch = await this.prisma.transferBatch.findUnique({
      where: { id: batchId },
      include: {
        sourceGroup: { select: { id: true, groupName: true } },
        targetGroup: { select: { id: true, groupName: true } },
        tasks: {
          select: { id: true, type: true, status: true, payload: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!batch) throw new NotFoundException("Transfer batch not found");

    const emails: string[] = JSON.parse(batch.memberEmails);

    // Build per-member detail (safe JSON parsing to tolerate corrupted payloads)
    const safeParsePayload = (payload: string): Record<string, unknown> => {
      try { return JSON.parse(payload); }
      catch { return {}; }
    };

    const memberDetails = emails.map(email => {
      const removeTask = batch.tasks.find(
        t => t.type === "REMOVE_MEMBER" && safeParsePayload(t.payload).memberEmail === email
      );
      const inviteTask = batch.tasks.find(
        t => t.type === "INVITE_MEMBER" && safeParsePayload(t.payload).userEmail === email
      );

      return {
        email,
        removeStatus: removeTask?.status ?? "NOT_STARTED",
        inviteStatus: inviteTask?.status ?? (batch.phase === "INVITING" || batch.phase === "COMPLETED" || batch.phase === "PARTIALLY_FAILED" ? "NOT_STARTED" : undefined),
      };
    });

    const removeTasks = batch.tasks.filter(t => t.type === "REMOVE_MEMBER");
    const inviteTasks = batch.tasks.filter(t => t.type === "INVITE_MEMBER");

    const terminalStatuses = new Set(["SUCCESS", "INVITE_SENT", "FAILED_FINAL", "MANUAL_REVIEW", "CANCELLED"]);

    return {
      id: batch.id,
      phase: batch.phase,
      sourceGroupId: batch.sourceGroupId,
      targetGroupId: batch.targetGroupId,
      sourceGroupName: batch.sourceGroup.groupName,
      targetGroupName: batch.targetGroup.groupName,
      totalMembers: batch.totalMembers,
      removes: {
        success: removeTasks.filter(t => t.status === "SUCCESS").length,
        failed: removeTasks.filter(t => ["FAILED_FINAL", "MANUAL_REVIEW", "CANCELLED"].includes(t.status)).length,
        pending: removeTasks.filter(t => !terminalStatuses.has(t.status)).length,
      },
      invites: {
        sent: inviteTasks.filter(t => ["SUCCESS", "INVITE_SENT"].includes(t.status)).length,
        failed: inviteTasks.filter(t => ["FAILED_FINAL", "MANUAL_REVIEW", "CANCELLED"].includes(t.status)).length,
        pending: inviteTasks.filter(t => !terminalStatuses.has(t.status)).length,
      },
      memberDetails,
      errorDetail: batch.errorDetail ? JSON.parse(batch.errorDetail) : [],
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
    };
  }

  /**
   * List recent transfer batches.
   */
  async listTransfers() {
    const batches = await this.prisma.transferBatch.findMany({
      include: {
        sourceGroup: { select: { groupName: true } },
        targetGroup: { select: { groupName: true } },
        _count: { select: { tasks: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return batches.map(b => ({
      id: b.id,
      sourceGroupName: b.sourceGroup.groupName,
      targetGroupName: b.targetGroup.groupName,
      phase: b.phase,
      totalMembers: b.totalMembers,
      removedCount: b.removedCount,
      invitedCount: b.invitedCount,
      taskCount: b._count.tasks,
      createdAt: b.createdAt,
    }));
  }
}
