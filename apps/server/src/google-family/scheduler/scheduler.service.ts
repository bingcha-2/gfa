import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import Redis from "ioredis";

import { PrismaService } from "../../shared/prisma/prisma.service";
import { QUEUE_NAMES, REDIS_KEYS, JOB_DEFAULTS } from "@gfa/shared";

const SCHEDULER_LOCK_TTL_MS = 30 * 60 * 1000; // 30 min timeout protection
const TASK_WAIT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min per task
const TASK_POLL_INTERVAL_MS = 5_000; // poll every 5s
const TIMEZONE = "Asia/Shanghai";

const TERMINAL_STATUSES = new Set([
  "SUCCESS",
  "INVITE_SENT",
  "REPLACED_AND_INVITE_SENT",
  "FAILED_FINAL",
  // FAILED_RETRYABLE is intentionally NOT terminal — BullMQ may still retry
  // the underlying job. waitForTask() should keep polling until a true
  // terminal status is reached or the 10-min timeout fires.
  "MANUAL_REVIEW",
  "CANCELLED",
]);

const RELEASE_LUA = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

type RunSummary = {
  totalAccounts: number;
  processedAccounts: number;
  syncTasks: number;
  removeTasks: number;
  cancelledInvites: number;
  deduplicatedMembers: number;
  errors: string[];
};

@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);
  private redis!: Redis;
  private workerId = `scheduler-${process.pid}-${Date.now()}`;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.sync) private readonly syncQueue: Queue,
    @InjectQueue(QUEUE_NAMES.remove) private readonly removeQueue: Queue
  ) {}

  onModuleInit() {
    // Reuse BullMQ's Redis connection config
    const redisOpts =
      (this.syncQueue as any).opts?.connection ?? {};
    this.redis = new Redis({
      host: redisOpts.host ?? process.env.REDIS_HOST ?? "127.0.0.1",
      port: redisOpts.port ?? parseInt(process.env.REDIS_PORT ?? "6379", 10),
      password: redisOpts.password ?? process.env.REDIS_PASSWORD ?? undefined,
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });
    this.logger.log(`Scheduler initialized with workerId: ${this.workerId}`);
  }

  // ─── Config CRUD ───────────────────────────────────────

  async getConfig() {
    return this.ensureConfig();
  }

  async updateConfig(data: Record<string, unknown>) {
    await this.ensureConfig();

    // Whitelist allowed fields
    const allowed = new Set([
      "enabled",
      "maxAccountsPerRun",
      "accountCooldownMinutes",
      "runWindowStart",
      "runWindowEnd",
      "staleSyncThresholdMinutes",
      "syncEnabled",
      "removeExpiredMembersEnabled",
      "cancelTimedOutInvitesEnabled",
      "deduplicateMembersEnabled",
      "inviteTimeoutDays",
    ]);
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (allowed.has(key)) filtered[key] = value;
    }

    return this.prisma.systemSchedulerConfig.update({
      where: { id: "default" },
      data: filtered,
    });
  }

  // ─── Status ────────────────────────────────────────────

  async getStatus() {
    const lockValue = await this.redis.get(REDIS_KEYS.schedulerLock);
    const lockTtl = await this.redis.pttl(REDIS_KEYS.schedulerLock);
    const config = await this.ensureConfig();

    return {
      isRunning: !!lockValue,
      runningSince: lockValue ?? null,
      remainingLockSeconds: lockTtl > 0 ? Math.ceil(lockTtl / 1000) : 0,
      lastRunAt: config.lastRunAt,
      lastRunStatus: config.lastRunStatus,
      lastRunSummary: config.lastRunSummary
        ? JSON.parse(config.lastRunSummary)
        : null,
    };
  }

  // ─── Scheduler Tasks ──────────────────────────────────

  async getSchedulerTasks(
    page = 1,
    pageSize = 20,
    filters: { search?: string; type?: string; status?: string } = {},
  ) {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const where: any = {
      source: { in: ["scheduler", "expire-scan", "manual", "auto", "webhook"] as string[] },
      createdAt: { gte: threeDaysAgo },
    };

    // Search by email in payload (JSON string contains)
    if (filters.search) {
      where.payload = { contains: filters.search, mode: "insensitive" };
    }

    // Filter by task type
    if (filters.type) {
      where.type = filters.type;
    }

    // Filter by task status
    if (filters.status) {
      where.status = filters.status;
    }

    const [data, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          type: true,
          status: true,
          source: true,
          payload: true,
          lastErrorCode: true,
          lastErrorMessage: true,
          startedAt: true,
          finishedAt: true,
          createdAt: true,
          familyGroup: { select: { id: true, groupName: true } },
          account: { select: { id: true, name: true, loginEmail: true } },
        },
      }),
      this.prisma.task.count({ where }),
    ]);

    return { data, total, page, pageSize };
  }

  // ─── Cleanup ───────────────────────────────────────────

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupOldTasks() {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    // Delete logs first (FK constraint)
    await this.prisma.taskLog.deleteMany({
      where: {
        task: {
          source: { in: ["scheduler", "expire-scan"] },
          createdAt: { lt: threeDaysAgo },
        },
      },
    });

    const deleted = await this.prisma.task.deleteMany({
      where: {
        source: { in: ["scheduler", "expire-scan"] },
        createdAt: { lt: threeDaysAgo },
      },
    });

    if (deleted.count > 0) {
      this.logger.log(`Cleaned up ${deleted.count} old scheduler/expire-scan tasks`);
    }
  }

  // ─── Cron Heartbeat ────────────────────────────────────

  @Cron("*/5 * * * *")
  async tick() {
    try {
      await this.executeRun(false);
    } catch (err) {
      this.logger.error(
        `Scheduler tick failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ─── Manual Run ────────────────────────────────────────

  async manualRun() {
    const lockValue = await this.redis.get(REDIS_KEYS.schedulerLock);
    if (lockValue) {
      return {
        started: false,
        reason: "Scheduler is already running",
        runningSince: lockValue,
      };
    }
    // Fire and forget — don't block the HTTP response
    this.executeRun(true).catch((err) =>
      this.logger.error(
        `Manual run failed: ${err instanceof Error ? err.message : String(err)}`
      )
    );
    return { started: true };
  }

  // ─── Core Execution ────────────────────────────────────

  private async executeRun(isManual: boolean) {
    const config = await this.ensureConfig();

    // Check enabled
    if (!config.enabled && !isManual) return;

    // Check time window (manual runs bypass)
    if (!isManual && !this.isInRunWindow(config.runWindowStart, config.runWindowEnd)) {
      return;
    }

    // Acquire Redis lock
    const lockId = `${this.workerId}:${Date.now()}`;
    const acquired = await this.redis.set(
      REDIS_KEYS.schedulerLock,
      lockId,
      "PX",
      SCHEDULER_LOCK_TTL_MS,
      "NX"
    );
    if (acquired !== "OK") {
      this.logger.debug("Scheduler lock already held, skipping");
      return;
    }

    const summary: RunSummary = {
      totalAccounts: 0,
      processedAccounts: 0,
      syncTasks: 0,
      removeTasks: 0,
      cancelledInvites: 0,
      deduplicatedMembers: 0,
      errors: [],
    };

    try {
      this.logger.log(
        `Scheduler run started (${isManual ? "manual" : "cron"})`
      );

      // Select candidate accounts
      const candidates = await this.selectCandidates(config);
      summary.totalAccounts = candidates.length;

      if (candidates.length === 0) {
        this.logger.log("No candidate accounts found");
        await this.updateRunResult(config, "SKIPPED", summary);
        return;
      }

      this.logger.log(
        `Found ${candidates.length} candidate account(s)`
      );

      // Process each account serially
      for (const accountId of candidates) {
        try {
          // Renew lock before each account to avoid expiry during slow tasks
          await this.redis.pexpire(REDIS_KEYS.schedulerLock, SCHEDULER_LOCK_TTL_MS);

          const result = await this.processAccount(accountId, config);
          summary.syncTasks += result.syncTasks;
          summary.removeTasks += result.removeTasks;
          summary.cancelledInvites += result.cancelledInvites;
          summary.deduplicatedMembers += result.deduplicatedMembers;
          summary.processedAccounts++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          summary.errors.push(`${accountId}: ${msg}`);
          this.logger.error(`Error processing account ${accountId}: ${msg}`);
        }
      }

      const status =
        summary.errors.length === 0
          ? "SUCCESS"
          : summary.processedAccounts > 0
            ? "PARTIAL"
            : "FAILED";

      await this.updateRunResult(config, status, summary);
      this.logger.log(
        `Scheduler run completed: ${status} (${summary.processedAccounts}/${summary.totalAccounts} accounts)`
      );
    } finally {
      // Release lock atomically
      await this.redis
        .eval(RELEASE_LUA, 1, REDIS_KEYS.schedulerLock, lockId)
        .catch(() => {});
    }
  }

  // ─── Candidate Selection ──────────────────────────────

  private async selectCandidates(config: any): Promise<string[]> {
    const now = new Date();
    const cooldownThreshold = new Date(
      now.getTime() - config.accountCooldownMinutes * 60 * 1000
    );
    const syncThreshold = new Date(
      now.getTime() - config.staleSyncThresholdMinutes * 60 * 1000
    );

    // Find HEALTHY accounts that have at least one reason to maintain
    const accounts = await this.prisma.account.findMany({
      where: {
        status: { in: ["HEALTHY", "RISKY"] },
        OR: [
          { lastAutoMaintenanceAt: null },
          { lastAutoMaintenanceAt: { lte: cooldownThreshold } },
        ],
      },
      select: {
        id: true,
        status: true,
        lastAutoMaintenanceAt: true,
        familyGroups: {
          where: { status: "ACTIVE" },
          select: {
            id: true,
            lastSyncedAt: true,
            members: {
              where: {
                status: { in: ["ACTIVE", "PENDING"] },
              },
              select: {
                id: true,
                email: true,
                status: true,
                expiresAt: true,
              },
            },
            invites: {
              where: { status: "SENT" },
              select: { id: true, sentAt: true },
            },
          },
        },
      },
      orderBy: [
        { lastAutoMaintenanceAt: { sort: "asc", nulls: "first" } },
      ],
    });

    // Filter: only include accounts that have at least one maintenance reason
    const inviteTimeout = config.inviteTimeoutDays * 24 * 60 * 60 * 1000;

    const candidates = accounts.filter((account) => {
      for (const group of account.familyGroups) {
        // Reason 1: stale sync (only when sync is enabled), or RISKY account auto-recovery
        if (
          config.syncEnabled &&
          (account.status === "RISKY" || !group.lastSyncedAt || group.lastSyncedAt <= syncThreshold)
        ) {
          return true;
        }
        // Reason 2: expired members (only when removal is enabled)
        if (
          config.removeExpiredMembersEnabled &&
          group.members.some(
            (m) => m.expiresAt && m.expiresAt <= now
          )
        ) {
          return true;
        }
        // Reason 3: timed-out invites (only when cancellation is enabled)
        if (
          config.cancelTimedOutInvitesEnabled &&
          group.invites.some(
            (inv) =>
              inv.sentAt &&
              inv.sentAt.getTime() + inviteTimeout <= now.getTime()
          )
        ) {
          return true;
        }
      }

      // Reason 4: cross-group duplicate members
      if (config.deduplicateMembersEnabled && account.familyGroups.length > 1) {
        const emailSet = new Set<string>();
        for (const group of account.familyGroups) {
          for (const m of group.members) {
            // members are pre-filtered to ACTIVE/PENDING in the query
            const key = m.email.toLowerCase();
            if (emailSet.has(key)) return true;
            emailSet.add(key);
          }
        }
      }

      return false;
    });

    // Check Redis login cooldown for each candidate
    const finalCandidates: string[] = [];
    for (const account of candidates) {
      const cooldownKey = `gfa:login-cooldown:${account.id}`;
      const ttl = await this.redis.pttl(cooldownKey);
      if (ttl > 0) {
        this.logger.debug(
          `Skipping account ${account.id}: login cooldown (${Math.ceil(ttl / 1000)}s remaining)`
        );
        continue;
      }
      finalCandidates.push(account.id);
      if (finalCandidates.length >= config.maxAccountsPerRun) break;
    }

    return finalCandidates;
  }

  // ─── Process Single Account ────────────────────────────

  private async processAccount(
    accountId: string,
    config: any
  ): Promise<{
    syncTasks: number;
    removeTasks: number;
    cancelledInvites: number;
    deduplicatedMembers: number;
  }> {
    const result = {
      syncTasks: 0,
      removeTasks: 0,
      cancelledInvites: 0,
      deduplicatedMembers: 0,
    };

    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        loginEmail: true,
        familyGroups: {
          where: { status: "ACTIVE" },
          select: { id: true, groupName: true, lastSyncedAt: true },
        },
      },
    });

    if (!account || account.familyGroups.length === 0) return result;

    const now = new Date();
    const syncThreshold = new Date(
      now.getTime() - config.staleSyncThresholdMinutes * 60 * 1000
    );
    let hasChanges = false;

    // ── Step 1: Sync ──
    if (config.syncEnabled) {
      for (const group of account.familyGroups) {
        if (group.lastSyncedAt && group.lastSyncedAt > syncThreshold) {
          continue; // recently synced
        }

        const taskResult = await this.createAndWaitForTask(
          "SYNC_FAMILY_GROUP",
          "sync-family-group",
          this.syncQueue,
          {
            familyGroupId: group.id,
            accountId,
          },
          group.id,
          accountId
        );
        result.syncTasks++;
        if (taskResult === "FAILED" || taskResult === "TIMEOUT") {
          this.logger.warn(
            `Sync task for group ${group.id} result: ${taskResult}`
          );
        }
      }
    }

    // ── Step 2: Remove expired members ──
    if (config.removeExpiredMembersEnabled) {
      const expiredMembers = await this.prisma.familyMember.findMany({
        where: {
          familyGroupId: {
            in: account.familyGroups.map((g) => g.id),
          },
          status: { in: ["ACTIVE", "PENDING"] },
          expiresAt: { lte: now },
        },
        select: {
          id: true,
          email: true,
          familyGroupId: true,
          familyGroup: { select: { accountId: true } },
        },
      });

      for (const member of expiredMembers) {
        // Skip if active remove task already exists
        const existingTask = await this.prisma.task.findFirst({
          where: {
            type: "REMOVE_MEMBER",
            familyGroupId: member.familyGroupId,
            status: { in: ["PENDING", "RUNNING"] },
            payload: { contains: member.email },
          },
        });
        if (existingTask) continue;

        const taskResult = await this.createAndWaitForTask(
          "REMOVE_MEMBER",
          "remove-member",
          this.removeQueue,
          {
            familyGroupId: member.familyGroupId,
            accountId: member.familyGroup.accountId,
            memberEmail: member.email,
            reason: "SCHEDULER_EXPIRED",
          },
          member.familyGroupId,
          accountId
        );
        result.removeTasks++;
        hasChanges = true;

        if (taskResult === "FAILED" || taskResult === "TIMEOUT") {
          this.logger.warn(
            `Remove task for ${member.email} result: ${taskResult}`
          );
        }
      }
    }

    // ── Step 3: Cancel timed-out invites ──
    if (config.cancelTimedOutInvitesEnabled) {
      const inviteTimeout =
        config.inviteTimeoutDays * 24 * 60 * 60 * 1000;
      const cutoff = new Date(now.getTime() - inviteTimeout);

      const timedOutInvites = await this.prisma.familyInvite.findMany({
        where: {
          familyGroupId: {
            in: account.familyGroups.map((g) => g.id),
          },
          status: "SENT",
          sentAt: { lte: cutoff },
        },
        select: {
          id: true,
          email: true,
          familyGroupId: true,
        },
      });

      for (const invite of timedOutInvites) {
        // FamilyInvite → EXPIRED
        await this.prisma.familyInvite.update({
          where: { id: invite.id },
          data: { status: "EXPIRED", respondedAt: now },
        });

        // FamilyMember PENDING → REMOVED
        await this.prisma.familyMember.updateMany({
          where: {
            familyGroupId: invite.familyGroupId,
            email: invite.email,
            status: "PENDING",
          },
          data: { status: "REMOVED", removedAt: now },
        });

        // Order CAS update — only update if still in waiting status
        await this.prisma.order.updateMany({
          where: {
            familyGroupId: invite.familyGroupId,
            userEmail: invite.email,
            status: { in: ["INVITE_SENT", "WAIT_USER_ACCEPT"] },
          },
          data: {
            status: "FAILED",
            resultMessage: `定时取消：邀请超时（${config.inviteTimeoutDays}天未接受）`,
          },
        });

        result.cancelledInvites++;
        hasChanges = true;
      }
    }

    // ── Step 4: Deduplicate members ──
    if (config.deduplicateMembersEnabled) {
      const groupIds = account.familyGroups.map((g) => g.id);
      const deduped = await this.deduplicateMembers(groupIds);
      result.deduplicatedMembers += deduped;
      if (deduped > 0) hasChanges = true;
    }

    // ── Step 5: Recalculate slot counts (if changes were made) ──
    // Step 3 (cancel invites) and Step 4 (dedup) directly modify member status
    // in the DB. We MUST update memberCount/availableSlots even if syncEnabled
    // is false, otherwise the group will have stale slot counts.
    if (hasChanges) {
      for (const group of account.familyGroups) {
        // Exclude the family manager (account's own email) to avoid
        // overcounting — capacity is for non-admin seats only.
        const adminEmail = (account.loginEmail ?? "").toLowerCase();
        const activeMembers = await this.prisma.familyMember.count({
          where: {
            familyGroupId: group.id,
            status: { in: ["ACTIVE", "PENDING"] },
            ...(adminEmail ? { email: { not: adminEmail } } : {}),
          },
        });
        const NON_ADMIN_CAPACITY = 5;
        const computedSlots = Math.max(0, NON_ADMIN_CAPACITY - activeMembers);

        await this.prisma.familyGroup.update({
          where: { id: group.id },
          data: {
            memberCount: activeMembers,
            availableSlots: computedSlots,
            pendingInviteCount: 0,
          },
        });
      }

      // If sync is also enabled, do a full scrape-based sync for accuracy
      if (config.syncEnabled) {
        for (const group of account.familyGroups) {
          await this.createAndWaitForTask(
            "SYNC_FAMILY_GROUP",
            "sync-family-group",
            this.syncQueue,
            {
              familyGroupId: group.id,
              accountId,
            },
            group.id,
            accountId
          );
          result.syncTasks++;
        }
      }
    }

    // Update account maintenance timestamp
    await this.prisma.account.update({
      where: { id: accountId },
      data: { lastAutoMaintenanceAt: now },
    });

    return result;
  }

  // ─── Deduplication ─────────────────────────────────────

  private async deduplicateMembers(groupIds: string[]): Promise<number> {
    if (groupIds.length <= 1) return 0;

    const members = await this.prisma.familyMember.findMany({
      where: {
        familyGroupId: { in: groupIds },
        status: { in: ["ACTIVE", "PENDING"] },
      },
      select: {
        id: true,
        email: true,
        status: true,
        familyGroupId: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    // Group by email
    const emailMap = new Map<
      string,
      typeof members
    >();
    for (const m of members) {
      const key = m.email.toLowerCase();
      const list = emailMap.get(key) ?? [];
      list.push(m);
      emailMap.set(key, list);
    }

    let deduplicatedCount = 0;

    for (const [email, records] of emailMap) {
      if (records.length <= 1) continue; // not a duplicate

      // Check if any of these have an active invite task — skip if so
      const activeInviteTask = await this.prisma.task.findFirst({
        where: {
          type: "INVITE_MEMBER",
          status: { in: ["PENDING", "RUNNING"] },
          payload: { contains: email },
        },
      });
      if (activeInviteTask) continue;

      const activeRecords = records.filter((r) => r.status === "ACTIVE");
      const pendingRecords = records.filter((r) => r.status === "PENDING");
      const now = new Date();

      if (activeRecords.length > 0) {
        // Case A: Keep ACTIVE, cancel all PENDING in other groups
        for (const pending of pendingRecords) {
          await this.cancelDuplicateMember(
            pending,
            "重复取消：成员已在其他组内",
            now
          );
          deduplicatedCount++;
        }
      } else if (pendingRecords.length > 1) {
        // Case B: All PENDING — keep the newest (already sorted desc by createdAt)
        const toCancel = pendingRecords.slice(1);
        for (const dup of toCancel) {
          await this.cancelDuplicateMember(
            dup,
            "重复取消：保留最新邀请",
            now
          );
          deduplicatedCount++;
        }
      }
    }

    return deduplicatedCount;
  }

  private async cancelDuplicateMember(
    member: { id: string; email: string; familyGroupId: string },
    reason: string,
    now: Date
  ) {
    // FamilyMember → REMOVED
    await this.prisma.familyMember.update({
      where: { id: member.id },
      data: { status: "REMOVED", removedAt: now },
    });

    // FamilyInvite → EXPIRED
    await this.prisma.familyInvite.updateMany({
      where: {
        familyGroupId: member.familyGroupId,
        email: member.email,
        status: "SENT",
      },
      data: { status: "EXPIRED", respondedAt: now },
    });

    // Order → FAILED with specific reason
    await this.prisma.order.updateMany({
      where: {
        familyGroupId: member.familyGroupId,
        userEmail: member.email,
        status: { in: ["INVITE_SENT", "WAIT_USER_ACCEPT"] },
      },
      data: { status: "FAILED", resultMessage: reason },
    });

    this.logger.log(
      `Dedup: cancelled ${member.email} in group ${member.familyGroupId} — ${reason}`
    );
  }

  // ─── Task Creation + Polling ───────────────────────────

  private async createAndWaitForTask(
    taskType: string,
    jobName: string,
    queue: Queue,
    payload: Record<string, unknown>,
    familyGroupId: string,
    accountId: string
  ): Promise<"SUCCESS" | "FAILED" | "TIMEOUT"> {
    // Check for existing active task of same type for same group/email
    const existingTask = await this.prisma.task.findFirst({
      where: {
        type: taskType as any,
        familyGroupId,
        status: { in: ["PENDING", "RUNNING"] },
        ...(payload.memberEmail
          ? { payload: { contains: payload.memberEmail as string } }
          : {}),
      },
    });

    if (existingTask) {
      this.logger.debug(
        `Skipping ${taskType}: active task ${existingTask.id} already exists`
      );
      // Wait for the existing task instead
      const result = await this.waitForTask(existingTask.id);
      if (result === "SUCCESS") {
        await this.supersedeSiblingTasks(existingTask.id, taskType, familyGroupId, payload);
      }
      return result;
    }

    // Create task with source = 'scheduler'
    const task = await this.prisma.task.create({
      data: {
        type: taskType as any,
        familyGroupId,
        accountId,
        source: "scheduler",
        payload: JSON.stringify(payload),
      },
    });

    // Enqueue
    const jobPayload = { taskId: task.id, ...payload };
    await queue.add(jobName, jobPayload, {
      ...JOB_DEFAULTS,
      jobId: `scheduler-${taskType}-${familyGroupId}-${task.id}`,
    });

    const result = await this.waitForTask(task.id);
    if (result === "SUCCESS") {
      await this.supersedeSiblingTasks(task.id, taskType, familyGroupId, payload);
    }
    return result;
  }

  private async waitForTask(
    taskId: string
  ): Promise<"SUCCESS" | "FAILED" | "TIMEOUT"> {
    const deadline = Date.now() + TASK_WAIT_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { status: true },
      });

      if (!task) return "FAILED";

      if (TERMINAL_STATUSES.has(task.status)) {
        const isSuccess =
          task.status === "SUCCESS" ||
          task.status === "INVITE_SENT" ||
          task.status === "REPLACED_AND_INVITE_SENT";
        return isSuccess ? "SUCCESS" : "FAILED";
      }

      await new Promise((r) => setTimeout(r, TASK_POLL_INTERVAL_MS));
    }

    return "TIMEOUT";
  }

  /**
   * After a task succeeds, cancel any older sibling tasks of the same type
   * and familyGroupId that are stuck in a failed/retryable state.
   * This keeps the task list clean: once a newer attempt succeeds,
   * the old failures are no longer actionable.
   */
  private async supersedeSiblingTasks(
    succeededTaskId: string,
    taskType: string,
    familyGroupId: string,
    payload: Record<string, unknown>
  ) {
    try {
      const now = new Date();
      const where: Record<string, unknown> = {
        type: taskType as any,
        familyGroupId,
        id: { not: succeededTaskId },
        status: {
          in: ["FAILED_RETRYABLE", "FAILED_FINAL", "MANUAL_REVIEW", "PENDING"],
        },
      };

      // For member-specific tasks, only supersede tasks targeting the same member
      if (payload.memberEmail) {
        where.payload = { contains: payload.memberEmail as string };
      }

      const obsoleteTasks = await this.prisma.task.findMany({
        where,
        select: { id: true, status: true, orderId: true },
      });

      if (obsoleteTasks.length === 0) return;

      // Batch update all obsolete tasks
      await this.prisma.task.updateMany({
        where: { id: { in: obsoleteTasks.map((t) => t.id) } },
        data: {
          status: "CANCELLED",
          lastErrorCode: "SUPERSEDED",
          lastErrorMessage: `被新的成功任务取代 (${succeededTaskId.slice(0, 12)})`,
          finishedAt: now,
        },
      });

      // Also fail linked orders for those tasks (CAS: only update non-terminal orders)
      const orderIds = obsoleteTasks
        .map((t) => t.orderId)
        .filter((id): id is string => !!id);
      if (orderIds.length > 0) {
        await this.prisma.order.updateMany({
          where: {
            id: { in: orderIds },
            status: {
              in: [
                "CREATED", "CODE_VERIFIED", "GROUP_ASSIGNED",
                "TASK_QUEUED", "TASK_RUNNING", "MANUAL_REVIEW",
              ],
            },
          },
          data: {
            status: "FAILED",
            resultMessage: `任务已被新的成功执行取代`,
          },
        });
      }

      this.logger.log(
        `Superseded ${obsoleteTasks.length} obsolete ${taskType} task(s) for group ${familyGroupId}`
      );
    } catch (err) {
      // Non-fatal: don't let cleanup errors affect the main flow
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to supersede sibling tasks: ${msg}`);
    }
  }

  // ─── Helpers ───────────────────────────────────────────

  private async ensureConfig() {
    const existing =
      await this.prisma.systemSchedulerConfig.findUnique({
        where: { id: "default" },
      });
    if (existing) return existing;

    return this.prisma.systemSchedulerConfig.create({
      data: { id: "default" },
    });
  }

  private async updateRunResult(
    config: any,
    status: string,
    summary: RunSummary
  ) {
    await this.prisma.systemSchedulerConfig.update({
      where: { id: "default" },
      data: {
        lastRunAt: new Date(),
        lastRunStatus: status,
        lastRunSummary: JSON.stringify(summary),
      },
    });
  }

  private isInRunWindow(start: string, end: string): boolean {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const currentHour = parseInt(
      parts.find((p) => p.type === "hour")!.value,
      10
    );
    const currentMinute = parseInt(
      parts.find((p) => p.type === "minute")!.value,
      10
    );
    const currentMinutes = currentHour * 60 + currentMinute;

    const [startH, startM] = start.split(":").map(Number);
    const [endH, endM] = end.split(":").map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (startMinutes <= endMinutes) {
      // Same day: 09:00 - 18:00
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    } else {
      // Cross-day: 22:00 - 08:00
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }
  }
}
