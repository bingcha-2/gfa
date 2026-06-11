import { Injectable, NotFoundException, BadRequestException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { FamilyGroup } from "@prisma/client";

import { PrismaService } from "../../shared/prisma/prisma.service";
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

  async findAll(opts?: { accountId?: string; memberEmail?: string }) {
    const where: Record<string, any> = {};
    if (opts?.accountId) where.accountId = opts.accountId;
    if (opts?.memberEmail) {
      const search = opts.memberEmail.trim().toLowerCase();
      where.OR = [
        // Match member email (子号)
        { members: { some: { email: { contains: search }, status: { not: "REMOVED" } } } },
        // Match parent account email (母号)
        { account: { loginEmail: { contains: search } } },
        // Match group name
        { groupName: { contains: search } },
      ];
    }
    const groups = await this.prisma.familyGroup.findMany({
      where,
      include: {
        account: {
          select: {
            id: true,
            name: true,
            loginEmail: true,
            status: true,
            syncError: true,
            subscriptionExpiresAt: true,
            subscriptionStatus: true,
            subscriptionStatusUpdatedAt: true,
            subscriptionPlan: true,
            notes: true,
          },
        },
        _count: {
          select: {
            members: true,
            invites: true,
          },
        },
        members: {
          where: { status: "PENDING" },
          select: { id: true, createdAt: true },
        },
      },
    });

    // Sort: ACTIVE groups first (by subscription expiry desc), MANUAL_ONLY last (by suspension time desc)
    const GROUP_STATUS_ORDER: Record<string, number> = { ACTIVE: 0, DISABLED: 1, MANUAL_ONLY: 2 };
    groups.sort((a, b) => {
      const aOrder = GROUP_STATUS_ORDER[a.status] ?? 1;
      const bOrder = GROUP_STATUS_ORDER[b.status] ?? 1;
      if (aOrder !== bOrder) return aOrder - bOrder;

      if (a.status === "MANUAL_ONLY") {
        // Among MANUAL_ONLY: more recently suspended first
        const aTime = a.account?.subscriptionStatusUpdatedAt?.getTime() ?? 0;
        const bTime = b.account?.subscriptionStatusUpdatedAt?.getTime() ?? 0;
        return bTime - aTime;
      }

      // Among ACTIVE: longer subscription (later expiry) first
      const aExp = a.account?.subscriptionExpiresAt?.getTime() ?? 0;
      const bExp = b.account?.subscriptionExpiresAt?.getTime() ?? 0;
      return bExp - aExp;
    });

    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    return groups.map(({ members: pendingMembers, ...g }) => ({
      ...g,
      pendingMemberCount: pendingMembers.length,
      pendingOver3DaysCount: pendingMembers.filter(
        (m) => now - m.createdAt.getTime() > THREE_DAYS_MS
      ).length,
    }));
  }

  /**
   * Find members that appear in multiple family groups.
   * Checks ACTIVE and PENDING members in ACTIVE groups only (MANUAL_ONLY excluded).
   * Returns each duplicate email with all the groups they belong to.
   */
  async findDuplicateMembers(): Promise<Array<{
    email: string;
    count: number;
    groups: Array<{ groupId: string; groupName: string; memberStatus: string; joinedAt: string | null }>;
  }>> {
    // Step 1: find emails that appear in more than one ACTIVE group (ACTIVE + PENDING members)
    const duplicates = await this.prisma.$queryRaw<
      { email: string; cnt: number }[]
    >`
      SELECT LOWER(fm.email) as email, COUNT(DISTINCT fm.familyGroupId) as cnt
      FROM FamilyMember fm
      JOIN FamilyGroup fg ON fg.id = fm.familyGroupId
      WHERE fm.status IN ('ACTIVE', 'PENDING')
        AND fg.status = 'ACTIVE'
      GROUP BY LOWER(fm.email)
      HAVING COUNT(DISTINCT fm.familyGroupId) > 1
      ORDER BY cnt DESC, email ASC
    `;

    if (duplicates.length === 0) return [];

    // Step 2: fetch group details for each duplicate email
    // Use raw SQL for case-insensitive matching (Prisma `in` is case-sensitive on SQLite)
    const dupEmails = duplicates.map((d) => d.email);
    const members = await this.prisma.familyMember.findMany({
      where: {
        status: { in: ["ACTIVE", "PENDING"] },
        familyGroup: { status: "ACTIVE" },
      },
      select: {
        email: true,
        status: true,
        joinedAt: true,
        familyGroup: { select: { id: true, groupName: true } },
      },
    });

    // Filter to only duplicate emails (case-insensitive) and group by email
    const dupEmailSet = new Set(dupEmails);
    const emailMap = new Map<string, Array<{ groupId: string; groupName: string; memberStatus: string; joinedAt: string | null }>>();
    for (const m of members) {
      const key = m.email.toLowerCase();
      if (!dupEmailSet.has(key)) continue;
      if (!emailMap.has(key)) emailMap.set(key, []);
      emailMap.get(key)!.push({
        groupId: m.familyGroup.id,
        groupName: m.familyGroup.groupName,
        memberStatus: m.status,
        joinedAt: m.joinedAt?.toISOString() ?? null,
      });
    }

    return duplicates.map((d) => ({
      email: d.email,
      count: Number(d.cnt),
      groups: emailMap.get(d.email) ?? [],
    }));
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

    // Lookup recent tasks for this group to attach latestTask per member
    const tasks = await this.prisma.task.findMany({
      where: { familyGroupId: id, type: { in: ["INVITE_MEMBER", "REMOVE_MEMBER", "REPLACE_MEMBER"] } },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { type: true, status: true, payload: true, createdAt: true },
    });

    // Build email -> latest task map
    const taskMap = new Map<string, { type: string; status: string; createdAt: string }>();
    for (const t of tasks) {
      try {
        const pl = JSON.parse(t.payload);
        const email = (pl.userEmail || pl.memberEmail || pl.targetMemberEmail || "").toLowerCase();
        if (email && !taskMap.has(email)) {
          taskMap.set(email, { type: t.type, status: t.status, createdAt: t.createdAt.toISOString() });
        }
        // For REPLACE_MEMBER, also map the NEW member email (newUserEmail)
        // so the replaced-in member shows the task in the UI
        if (t.type === "REPLACE_MEMBER" && pl.newUserEmail) {
          const newEmail = pl.newUserEmail.toLowerCase();
          if (!taskMap.has(newEmail)) {
            taskMap.set(newEmail, { type: t.type, status: t.status, createdAt: t.createdAt.toISOString() });
          }
        }
      } catch {}
    }

    // Attach derived isInGroup field and latestTask to each member
    return {
      ...withAccount,
      members: withAccount.members.map((m) => ({
        ...m,
        isInGroup: m.status === "ACTIVE",
        latestTask: taskMap.get(m.email.toLowerCase()) ?? null,
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
        { taskId: task.id, familyGroupId: groupId, accountId: group.accountId, ignoreCooldown: true },
        { ...JOB_DEFAULTS, jobId: task.id }
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
          originalMemberStatus: result.originalStatus,
          ignoreCooldown: true
        },
        { ...JOB_DEFAULTS, jobId: result.task.id }
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
            { taskId: outcome.taskId, familyGroupId: groupId, accountId: group.accountId, memberEmail: normEmail, ignoreCooldown: true },
            {
              ...JOB_DEFAULTS,
              jobId: outcome.taskId, // use unique DB task ID — fixed dedup key caused repeated removes to be silently swallowed
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
    emails: string[],
    validDays: number = 30,
    inheritedExpiresAt?: Date | null,
    source?: string
  ): Promise<{
    queued: string[];
    rejected: string[];
    reason?: string;
  }> {
    const group = await this.findOne(groupId);
    if (!group.account) throw new NotFoundException("Account not found for family group");

    // Block invitations to groups whose account subscription is suspended or expired
    const subStatus = group.account.subscriptionStatus;
    const subExpiresAt = group.account.subscriptionExpiresAt;
    const isSubscriptionExpired = subExpiresAt && new Date(subExpiresAt) <= new Date();
    if (subStatus === "SUSPENDED" || subStatus === "EXPIRED" || isSubscriptionExpired) {
      throw new BadRequestException(
        `Cannot invite to this group: account subscription is ${subStatus === "SUSPENDED" ? "SUSPENDED" : "EXPIRED"}`
      );
    }

    const normEmails = emails.map((e) => e.trim().toLowerCase());
    const allUniqueEmails = [...new Set(normEmails)];

    // Cross-group duplicate check: filter out emails already ACTIVE/PENDING in any group
    // Exception: members whose expiresAt has passed, or who are in groups with
    // SUSPENDED/EXPIRED subscriptions, are allowed (renewal scenario).
    const now = new Date();
    const existingInAnyGroup = await this.prisma.familyMember.findMany({
      where: {
        email: { in: allUniqueEmails },
        status: { in: ["ACTIVE", "PENDING"] },
      },
      select: {
        email: true,
        expiresAt: true,
        familyGroup: {
          select: {
            account: { select: { subscriptionStatus: true, subscriptionExpiresAt: true } },
          },
        },
      },
    });
    const existingEmailSet = new Set(
      existingInAnyGroup
        .filter((m) => {
          if (m.expiresAt && m.expiresAt <= now) return false;
          const subStatus = m.familyGroup?.account?.subscriptionStatus;
          const subExpiresAt = m.familyGroup?.account?.subscriptionExpiresAt;
          if (subStatus === "SUSPENDED" || subStatus === "EXPIRED") return false;
          if (subExpiresAt && new Date(subExpiresAt) <= now) return false;
          return true;
        })
        .map((m) => m.email)
    );
    const uniqueEmails = allUniqueEmails.filter((e) => !existingEmailSet.has(e));
    const skippedActive = allUniqueEmails.filter((e) => existingEmailSet.has(e));

    if (uniqueEmails.length === 0) {
      return {
        queued: [],
        rejected: skippedActive,
        reason: `所有邮箱已是活跃/待处理成员: ${skippedActive.join(', ')}`,
      };
    }

    // Compute member expiry date
    const memberExpiresAt = inheritedExpiresAt 
      ? new Date(inheritedExpiresAt).toISOString()
      : new Date(Date.now() + validDays * 24 * 60 * 60 * 1000).toISOString();

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
            source: source ?? "manual",
            payload: JSON.stringify({ familyGroupId: groupId, accountId: group.accountId, userEmail: email, memberExpiresAt })
          }
        });
        taskId = task.id;

        await this.inviteQueue.add(
          "invite-member",
          { taskId, familyGroupId: groupId, accountId: group.accountId, userEmail: email, memberExpiresAt, ignoreCooldown: true },
          {
            ...JOB_DEFAULTS,
            jobId: taskId, // use unique DB task ID — fixed dedup key caused re-invites after removal to be silently swallowed
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
    // If it has only REMOVED records, report as alreadyRemoved.
    // ACTIVE and PENDING (invite sent, not yet accepted) are both removable.
    const REMOVABLE_STATUSES = new Set(["ACTIVE", "PENDING"]);
    const emailStatusMap = new Map<string, string>(); // email -> best status
    for (const m of members) {
      const existing = emailStatusMap.get(m.email);
      // Prefer ACTIVE, then PENDING, over REMOVED
      if (!existing || (REMOVABLE_STATUSES.has(m.status) && !REMOVABLE_STATUSES.has(existing))) {
        emailStatusMap.set(m.email, m.status);
      }
      // Within removable, prefer ACTIVE over PENDING
      if (existing === "PENDING" && m.status === "ACTIVE") {
        emailStatusMap.set(m.email, m.status);
      }
    }

    for (const email of normEmails) {
      const status = emailStatusMap.get(email);
      if (!status) result.notFound.push(email);                                // truly absent
      else if (!REMOVABLE_STATUSES.has(status)) result.alreadyRemoved.push(email); // only REMOVED records
    }

    // R2-C fix: deduplicate removable members by email — keep only the first group
    // per email to prevent double-remove if an email appears in multiple groups.
    const byGroup = new Map<string, string[]>();
    const processedEmails = new Set<string>();
    for (const m of members) {
      if (!REMOVABLE_STATUSES.has(m.status)) continue;
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
  async crossBulkInvite(emails: string[], validDays: number = 30, inheritedExpiresAt?: Date | null): Promise<{
    allocated: Array<{ groupId: string; accountId: string; queued: string[] }>;
    unplaceable: string[];
    alreadyActive: string[];
    reason?: string;
  }> {
    const normEmails = [...new Set(emails.map((e) => e.trim().toLowerCase()))];

    // R3-C: filter out emails that already have an ACTIVE member record in any group
    // to avoid double-inviting existing members.
    // Exception: members whose expiresAt has passed, or who are in groups with
    // SUSPENDED/EXPIRED subscriptions, are allowed (renewal scenario).
    const now = new Date();
    const existingMembers = await this.prisma.familyMember.findMany({
      where: { email: { in: normEmails }, status: { in: ["ACTIVE", "PENDING"] } },
      select: {
        email: true,
        expiresAt: true,
        familyGroup: {
          select: {
            account: { select: { subscriptionStatus: true, subscriptionExpiresAt: true } },
          },
        },
      },
    });
    // Only block members who are truly active (not expired, not in suspended/expired groups)
    const existingEmails = new Set(
      existingMembers
        .filter((m) => {
          // Allow re-invite if member's own subscription has expired
          if (m.expiresAt && m.expiresAt <= now) return false;
          // Allow re-invite if the group's account subscription is suspended or expired
          const subStatus = m.familyGroup?.account?.subscriptionStatus;
          const subExpiresAt = m.familyGroup?.account?.subscriptionExpiresAt;
          if (subStatus === "SUSPENDED" || subStatus === "EXPIRED") return false;
          if (subExpiresAt && new Date(subExpiresAt) <= now) return false;
          return true; // truly active — block
        })
        .map((m) => m.email)
    );
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
    // Exclude accounts with SUSPENDED/EXPIRED subscription status or expired subscriptionExpiresAt
    const availableGroups = await this.prisma.familyGroup.findMany({
      where: {
        status: "ACTIVE",
        availableSlots: { gt: 0 },
        account: {
          status: "HEALTHY",
          subscriptionStatus: { notIn: ["SUSPENDED", "EXPIRED"] },
          OR: [
            { subscriptionExpiresAt: null },
            { subscriptionExpiresAt: { gt: now } },
          ],
        },
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
      const partial = await this.bulkInvite(group.id, chunk, validDays, inheritedExpiresAt);

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
    // Exclude accounts with SUSPENDED/EXPIRED subscription status or expired subscriptionExpiresAt
    const now = new Date();
    const groups = await this.prisma.familyGroup.findMany({
      where: {
        status: "ACTIVE",
        availableSlots: { gt: 0 },
        account: {
          status: "HEALTHY",
          subscriptionStatus: { notIn: ["SUSPENDED", "EXPIRED"] },
          OR: [
            { subscriptionExpiresAt: null },
            { subscriptionExpiresAt: { gt: now } },
          ],
        },
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
      expiresAt: string | null;
    };
    familyGroup?: {
      id: string;
      groupName: string;
      accountEmail: string | null;
      status: string;
      memberCount: number;
      maxMembers: number;
      lastSyncedAt: string | null;
    };
    account?: {
      subscriptionStatus: string | null;
      syncError: string | null;
      status: string;
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
            account: { select: { loginEmail: true, subscriptionStatus: true, syncError: true, status: true } }
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
                account: { select: { loginEmail: true, subscriptionStatus: true, syncError: true, status: true } }
              }
            }
          },
          orderBy: { createdAt: "desc" }
        });
      }
    }

    if (members.length > 0) {
      // Pick best member: ACTIVE > PENDING > latest record
      // This prevents a newer REMOVED record from overshadowing a valid PENDING one
      const member =
        members.find((m) => m.status === "ACTIVE") ??
        members.find((m) => m.status === "PENDING") ??
        members[0];
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
          expiresAt: member.expiresAt?.toISOString() ?? null,
        },
        familyGroup: fg
          ? {
              id: fg.id,
              groupName: fg.groupName,
              accountEmail: fg.account?.loginEmail ?? null,
              status: fg.status,
              memberCount: fg.memberCount,
              maxMembers: fg.maxMembers,
              lastSyncedAt: fg.lastSyncedAt?.toISOString() ?? null,
            }
          : undefined,
        account: fg?.account
          ? {
              subscriptionStatus: fg.account.subscriptionStatus ?? null,
              syncError: fg.account.syncError ?? null,
              status: fg.account.status,
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
          include: { account: { select: { loginEmail: true, subscriptionStatus: true, syncError: true, status: true } } }
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
              include: { account: { select: { loginEmail: true, subscriptionStatus: true, syncError: true, status: true } } }
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
            lastSyncedAt: fg.lastSyncedAt?.toISOString() ?? null,
          }
        : undefined,
      account: fg?.account
        ? {
            subscriptionStatus: fg.account.subscriptionStatus ?? null,
            syncError: fg.account.syncError ?? null,
            status: fg.account.status,
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
        syncError: true,
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

    // Unsynced groups cannot be used for replacement — slot data is unreliable
    if (!group.lastSyncedAt) {
      throw new BadRequestException("Family group has never been synced. Please sync first before replacing members.");
    }

    // Cross-group duplicate check: reject if newUserEmail is already in any group
    const existingMember = await this.prisma.familyMember.findFirst({
      where: {
        email: newUserEmail,
        status: { in: ["ACTIVE", "PENDING"] },
      },
      select: { email: true, status: true, familyGroup: { select: { groupName: true } } },
    });
    if (existingMember) {
      throw new BadRequestException(
        `${newUserEmail} 已在组 ${existingMember.familyGroup?.groupName ?? '未知'} 中（状态: ${existingMember.status}），不能重复邀请`
      );
    }

    // Atomic: check member + guard duplicate task + create task in one transaction
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

      // Guard: reject if a PENDING/RUNNING replace task already exists for this member+group
      const existingTask = await tx.task.findFirst({
        where: {
          type: "REPLACE_MEMBER",
          familyGroupId: groupId,
          status: { in: ["PENDING", "RUNNING"] },
          payload: { contains: targetMemberEmail },
        },
      });
      if (existingTask) {
        return { duplicate: true as const, existingTaskId: existingTask.id };
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

    if ('duplicate' in result) {
      throw new BadRequestException(
        `该成员已有进行中的替换任务 (${result.existingTaskId})，请勿重复提交`
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
        { ...JOB_DEFAULTS, jobId: result.task.id }
      );
    } catch (queueError) {
      // Queue add failed — clean up orphaned task
      await this.prisma.task.delete({ where: { id: result.task.id } }).catch(() => {});
      throw queueError;
    }

    return { queued: true, taskId: result.task.id };
  }

  /**
   * Migrate a member: directly delete from current group in DB (no browser removal),
   * then auto-invite to a different group with available slots.
   *
   * Steps:
   * 1. Mark the member as REMOVED in the source group and reclaim the slot
   * 2. Use crossBulkInvite to find an available group and enqueue an invite task
   * 3. Return the invite task details for frontend polling
   */
  async migrateMember(
    groupId: string,
    memberEmail: string,
    validDays: number = 30
  ): Promise<{
    removedFromGroupId: string;
    removedFromGroupName: string;
    inviteResult: {
      targetGroupId: string;
      targetGroupName: string;
      taskId: string;
    } | null;
    error?: string;
  }> {
    memberEmail = memberEmail.trim().toLowerCase();

    // 1. Validate source group
    const sourceGroup = await this.prisma.familyGroup.findUnique({
      where: { id: groupId },
      select: { id: true, groupName: true, accountId: true },
    });
    if (!sourceGroup) throw new NotFoundException("Source family group not found");

    // 2. Find the member in the source group
    const member = await this.prisma.familyMember.findFirst({
      where: {
        familyGroupId: groupId,
        email: memberEmail,
        status: { in: ["ACTIVE", "PENDING"] },
      },
    });
    if (!member) {
      throw new BadRequestException(
        `Member ${memberEmail} not found in group or already removed`
      );
    }

    // 3. Directly remove from DB: mark as REMOVED, reclaim slot, decrement member count
    await this.prisma.$transaction(async (tx) => {
      await tx.familyMember.update({
        where: { id: member.id },
        data: { status: "REMOVED", removedAt: new Date() },
      });

      await tx.familyGroup.update({
        where: { id: groupId },
        data: {
          availableSlots: { increment: 1 },
          memberCount: { decrement: 1 },
        },
      });
    });

    // 4. Use crossBulkInvite to auto-find a group and enqueue invite
    //    This reuses existing logic: finds ACTIVE groups, excludes the source group's account
    //    if it's suspended, reserves slots atomically, etc.
    const inviteResult = await this.crossBulkInvite([memberEmail], validDays, member.expiresAt);

    // Extract the invite target info
    if (inviteResult.allocated.length > 0) {
      const alloc = inviteResult.allocated[0];

      // Look up the target group name
      const targetGroup = await this.prisma.familyGroup.findUnique({
        where: { id: alloc.groupId },
        select: { groupName: true },
      });

      // Find the task that was just created for this invite
      const task = await this.prisma.task.findFirst({
        where: {
          type: "INVITE_MEMBER",
          familyGroupId: alloc.groupId,
          payload: { contains: memberEmail },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });

      if (task) {
        // Create a tracking TransferBatch so this migration is counted in stats
        const batch = await this.prisma.transferBatch.create({
          data: {
            sourceGroupId: groupId,
            targetGroupId: alloc.groupId,
            memberEmails: JSON.stringify([memberEmail]),
            totalMembers: 1,
            phase: "COMPLETED",
            removedCount: 1,
            invitedCount: 1,
          },
        });

        // Link the task to the batch so it's excluded from "Console Invites"
        await this.prisma.task.update({
          where: { id: task.id },
          data: { transferBatchId: batch.id },
        });
      }

      return {
        removedFromGroupId: groupId,
        removedFromGroupName: sourceGroup.groupName,
        inviteResult: {
          targetGroupId: alloc.groupId,
          targetGroupName: targetGroup?.groupName ?? alloc.groupId,
          taskId: task?.id ?? "",
        },
      };
    }

    // No slots available — ROLLBACK: restore member to original state
    // Without rollback, member would be orphaned (REMOVED but not re-invited),
    // causing self-service to show "removed" on next check.
    await this.prisma.$transaction(async (tx) => {
      await tx.familyMember.update({
        where: { id: member.id },
        data: { status: member.status, removedAt: null },
      });
      await tx.familyGroup.update({
        where: { id: groupId },
        data: {
          availableSlots: { decrement: 1 },
          memberCount: { increment: 1 },
        },
      });
    });

    return {
      removedFromGroupId: groupId,
      removedFromGroupName: sourceGroup.groupName,
      inviteResult: null,
      error: inviteResult.reason ?? "No available family group with open slots",
    };
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

  // ========== Expired Member Management ==========

  /**
   * Query members with expiration info across all groups.
   * Supports filtering by expired/expiring-soon status and email search.
   */
  async getExpiredMembers(opts: {
    status?: "expired" | "expiring_soon" | "all";
    email?: string;
    groupId?: string;
    page?: number;
    pageSize?: number;
  }) {
    const now = new Date();
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
    const skip = (page - 1) * pageSize;

    // Build where clause for FamilyMember
    const where: Record<string, any> = {
      status: { in: ["ACTIVE", "PENDING"] },
      expiresAt: { not: null },
    };

    if (opts.status === "expired") {
      where.expiresAt = { lte: now };
    } else if (opts.status === "expiring_soon") {
      const soon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      where.expiresAt = { lte: soon, gt: now };
    }
    // "all" keeps expiresAt: { not: null } only

    if (opts.email) {
      where.email = { contains: opts.email.trim().toLowerCase() };
    }
    if (opts.groupId) {
      where.familyGroupId = opts.groupId;
    }

    const [members, total] = await Promise.all([
      this.prisma.familyMember.findMany({
        where,
        include: {
          familyGroup: {
            select: {
              id: true,
              groupName: true,
              account: { select: { loginEmail: true } },
            },
          },
        },
        orderBy: { expiresAt: "asc" },
        skip,
        take: pageSize,
      }),
      this.prisma.familyMember.count({ where }),
    ]);

    return {
      members: members.map((m) => {
        const expiresAt = m.expiresAt;
        const isExpired = expiresAt ? expiresAt <= now : false;
        const daysRemaining = expiresAt
          ? Math.ceil((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
          : null;

        return {
          id: m.id,
          email: m.email,
          displayName: m.displayName,
          expiresAt: expiresAt?.toISOString() ?? null,
          joinedAt: m.joinedAt?.toISOString() ?? null,
          status: m.status,
          familyGroupId: m.familyGroupId,
          groupName: m.familyGroup.groupName,
          accountEmail: m.familyGroup.account?.loginEmail ?? null,
          isExpired,
          daysRemaining,
        };
      }),
      total,
      page,
      pageSize,
    };
  }

  /**
   * Bulk remove all expired members (expiresAt <= now, status ACTIVE/PENDING).
   * Delegates to crossBulkRemove for actual removal.
   */
  async bulkRemoveExpired(): Promise<{
    queued: string[];
    notFound: string[];
    alreadyRemoved: string[];
    failed: string[];
    totalExpired: number;
  }> {
    const now = new Date();
    const MAX_BATCH = 500;

    const expiredMembers = await this.prisma.familyMember.findMany({
      where: {
        expiresAt: { lte: now },
        status: { in: ["ACTIVE", "PENDING"] },
      },
      select: { email: true },
      take: MAX_BATCH,
    });

    const emails = [...new Set(expiredMembers.map((m) => m.email))];

    if (emails.length === 0) {
      return { queued: [], notFound: [], alreadyRemoved: [], failed: [], totalExpired: 0 };
    }

    const result = await this.crossBulkRemove(emails);
    return { ...result, totalExpired: emails.length };
  }

  /**
   * Search family members by email (partial match).
   * Returns member-centric results with associated group + account info.
   * Used by the inventory panel's "search by child email" feature.
   */
  async searchByMemberEmail(email: string, opts?: { page?: number; pageSize?: number }) {
    const normalizedEmail = email.trim().toLowerCase();
    const page = Math.max(1, opts?.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, opts?.pageSize ?? 50));
    const skip = (page - 1) * pageSize;

    const where: Record<string, any> = {
      email: { contains: normalizedEmail },
      status: { not: "REMOVED" },
    };

    const [members, total] = await Promise.all([
      this.prisma.familyMember.findMany({
        where,
        include: {
          familyGroup: {
            select: {
              id: true,
              groupName: true,
              status: true,
              account: {
                select: {
                  id: true,
                  loginEmail: true,
                  name: true,
                  subscriptionExpiresAt: true,
                  subscriptionStatus: true,
                  subscriptionPlan: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
      }),
      this.prisma.familyMember.count({ where }),
    ]);

    return {
      members: members.map((m) => ({
        id: m.id,
        email: m.email,
        displayName: m.displayName,
        role: m.role,
        status: m.status,
        joinedAt: m.joinedAt?.toISOString() ?? null,
        expiresAt: m.expiresAt?.toISOString() ?? null,
        googleMemberId: m.googleMemberId,
        familyGroupId: m.familyGroupId,
        groupName: m.familyGroup.groupName,
        groupStatus: m.familyGroup.status,
        accountEmail: m.familyGroup.account?.loginEmail ?? null,
        accountName: m.familyGroup.account?.name ?? null,
        subscriptionExpiresAt: m.familyGroup.account?.subscriptionExpiresAt?.toISOString() ?? null,
        subscriptionStatus: m.familyGroup.account?.subscriptionStatus ?? null,
        subscriptionPlan: m.familyGroup.account?.subscriptionPlan ?? null,
      })),
      total,
      page,
      pageSize,
    };
  }

  /**
   * Update a member's joinedAt and/or expiresAt dates.
   * Used from the admin panel for manual date adjustments.
   */
  async updateMemberDates(
    groupId: string,
    memberId: string,
    data: { joinedAt?: string | null; expiresAt?: string | null }
  ) {
    const member = await this.prisma.familyMember.findUnique({
      where: { id: memberId },
    });

    if (!member) throw new NotFoundException("Family member not found");
    if (member.familyGroupId !== groupId) {
      throw new BadRequestException("Member does not belong to this family group");
    }

    const updateData: Record<string, any> = {};
    if (data.joinedAt !== undefined) {
      updateData.joinedAt = data.joinedAt ? new Date(data.joinedAt) : null;
    }
    if (data.expiresAt !== undefined) {
      updateData.expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
    }

    // Sanity check: expiresAt should not be before joinedAt
    const finalJoinedAt = updateData.joinedAt ?? member.joinedAt;
    const finalExpiresAt = updateData.expiresAt ?? member.expiresAt;
    if (finalJoinedAt && finalExpiresAt && finalExpiresAt < finalJoinedAt) {
      throw new BadRequestException("expiresAt cannot be earlier than joinedAt");
    }

    const updated = await this.prisma.familyMember.update({
      where: { id: memberId },
      data: updateData,
    });

    return {
      id: updated.id,
      email: updated.email,
      joinedAt: updated.joinedAt?.toISOString() ?? null,
      expiresAt: updated.expiresAt?.toISOString() ?? null,
    };
  }

  /**
   * Get a complete chronological timeline of all operations involving a member email.
   * Aggregates Tasks, Orders, SwapRecords, and FamilyMember records.
   */
  async getMemberTimeline(email: string) {
    const emailLower = email.trim().toLowerCase();

    // 1. All tasks involving this email (in payload)
    const tasks = await this.prisma.task.findMany({
      where: { payload: { contains: emailLower } },
      select: {
        id: true,
        type: true,
        status: true,
        source: true,
        payload: true,
        familyGroupId: true,
        orderId: true,
        lastErrorMessage: true,
        lastErrorCode: true,
        createdAt: true,
        finishedAt: true,
        familyGroup: { select: { groupName: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    // 2. All orders for this email
    const orders = await this.prisma.order.findMany({
      where: { userEmail: emailLower },
      select: {
        id: true,
        orderNo: true,
        orderType: true,
        status: true,
        userEmail: true,
        swapCount: true,
        lastSwapAt: true,
        expiresAt: true,
        familyGroupId: true,
        familyGroup: { select: { groupName: true } },
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "asc" },
    });

    // 3. All swap records involving this email
    const swaps = await this.prisma.swapRecord.findMany({
      where: {
        OR: [
          { oldEmail: emailLower },
          { newEmail: emailLower },
        ],
      },
      select: {
        id: true,
        oldEmail: true,
        newEmail: true,
        status: true,
        orderId: true,
        taskId: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });

    // 4. All member records (including REMOVED)
    const members = await this.prisma.familyMember.findMany({
      where: { email: emailLower },
      select: {
        id: true,
        email: true,
        status: true,
        joinedAt: true,
        expiresAt: true,
        familyGroupId: true,
        familyGroup: { select: { groupName: true, status: true } },
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });

    // 5. Build unified timeline
    type TimelineEvent = {
      time: string;
      category: "task" | "order" | "swap" | "member";
      type: string;
      status: string;
      source: string;
      detail: string;
      groupName: string | null;
      extra?: Record<string, any>;
    };

    const events: TimelineEvent[] = [];

    // Tasks
    for (const t of tasks) {
      let detail = "";
      try {
        const pl = JSON.parse(t.payload);
        if (t.type === "REPLACE_MEMBER") {
          detail = `${pl.targetMemberEmail || "?"} → ${pl.newUserEmail || "?"}`;
        } else if (t.type === "INVITE_MEMBER") {
          detail = `邀请 ${pl.userEmail || "?"}`;
        } else if (t.type === "REMOVE_MEMBER") {
          detail = `移除 ${pl.memberEmail || "?"}`;
        } else if (t.type === "SYNC_FAMILY_GROUP") {
          detail = "同步家庭组";
        } else if (t.type === "ACCEPT_INVITE") {
          detail = `接受邀请 ${pl.userEmail || ""}`;
        } else {
          detail = t.type;
        }
      } catch {
        detail = t.type;
      }

      events.push({
        time: t.createdAt.toISOString(),
        category: "task",
        type: t.type,
        status: t.status,
        source: t.source || "unknown",
        detail,
        groupName: t.familyGroup?.groupName ?? null,
        extra: {
          taskId: t.id,
          orderId: t.orderId,
          errorMessage: t.lastErrorMessage,
          errorCode: t.lastErrorCode,
          finishedAt: t.finishedAt?.toISOString() ?? null,
        },
      });
    }

    // Orders
    for (const o of orders) {
      events.push({
        time: o.createdAt.toISOString(),
        category: "order",
        type: o.orderType,
        status: o.status,
        source: "system",
        detail: `订单 ${o.orderNo} (换号${o.swapCount}次)`,
        groupName: o.familyGroup?.groupName ?? null,
        extra: {
          orderId: o.id,
          orderNo: o.orderNo,
          swapCount: o.swapCount,
          expiresAt: o.expiresAt?.toISOString() ?? null,
        },
      });
    }

    // Swaps
    for (const s of swaps) {
      const direction = s.oldEmail === emailLower ? "被替换出" : "替换入";
      const otherEmail = s.oldEmail === emailLower ? s.newEmail : s.oldEmail;
      events.push({
        time: s.createdAt.toISOString(),
        category: "swap",
        type: "SWAP",
        status: s.status,
        source: "system",
        detail: `${direction} (${direction === "被替换出" ? `新号: ${otherEmail}` : `替换: ${otherEmail}`})`,
        groupName: null,
        extra: {
          swapId: s.id,
          oldEmail: s.oldEmail,
          newEmail: s.newEmail,
          orderId: s.orderId,
          taskId: s.taskId,
        },
      });
    }

    // Member records
    for (const m of members) {
      events.push({
        time: (m.joinedAt ?? m.createdAt).toISOString(),
        category: "member",
        type: m.status === "REMOVED" ? "MEMBER_REMOVED" : "MEMBER_RECORD",
        status: m.status,
        source: "record",
        detail: `成员记录: ${m.status}`,
        groupName: m.familyGroup?.groupName ?? null,
        extra: {
          memberId: m.id,
          groupStatus: m.familyGroup?.status,
          expiresAt: m.expiresAt?.toISOString() ?? null,
        },
      });
    }

    // Sort by time
    events.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

    return {
      email: emailLower,
      totalEvents: events.length,
      summary: {
        tasks: tasks.length,
        orders: orders.length,
        swaps: swaps.length,
        memberRecords: members.length,
      },
      timeline: events,
    };
  }
}
