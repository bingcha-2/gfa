/**
 * Invite member processor.
 *
 * Flow (Browser Pool architecture):
 * 1. Acquire a free profile from BrowserPool
 * 2. Start AdsPower browser profile
 * 3. Connect via CDP, Gmail auto-login
 * 4. Ensure family group exists (create if needed)
 * 5. Navigate to Google Family page, send invite
 * 6. Take screenshots, update Task + Order status
 * 7. Release profile back to pool
 *
 * === Account fallback (v2) ===
 * On login failure:
 *   1. Record cumulative failure for original account
 *   2. Search for another HEALTHY account with available family group slots
 *   3. If found → reassign task to new account/group and retry
 *   4. If not found → throw error (BullMQ retries or fails)
 */

import { Job, UnrecoverableError } from "bullmq";
import { PrismaClient } from "@prisma/client";
import type { InviteMemberPayload } from "@gfa/shared";
import { JOB_DEFAULTS } from "@gfa/shared";

import { AdsPowerClient } from "../adspower-client";
import { BrowserPool } from "../browser-pool";
import { WorkerBrowser } from "../browser-context";
import { TaskLogger } from "../task-logger";
import { gmailLogin } from "../gmail-login";
import { handleLoginResult } from "../handle-login-result";
import { ensureFamilyGroup } from "../ensure-family-group";
import { checkTransferBatchProgress } from "../check-transfer-progress";
import { Queue } from "bullmq";

const GOOGLE_FAMILY_URL = "https://myaccount.google.com/family/details?hl=en";

/**
 * Custom error thrown when Google silently rejects an invite due to rate limiting.
 * The caller should handle this differently for JOIN (auto-reassign) vs SWAP (notify user).
 */
export class InviteCooldownError extends Error {
  constructor(accountId: string) {
    super(
      `INVITE_COOLDOWN: Account ${accountId} hit Google invite rate limit. ` +
      `Card count did not increase after two attempts.`
    );
    this.name = "InviteCooldownError";
  }
}

export interface InviteProcessorDeps {
  prisma: PrismaClient;
  adspower: AdsPowerClient;
  pool: BrowserPool;
  workerId: string;
  inviteQueue?: Queue;
}

/**
 * Find an alternative healthy account with available family group slots.
 * Excludes the given accountId and any accounts in cooldown or with high failure counts.
 */
async function findAlternativeAccount(
  prisma: PrismaClient,
  pool: BrowserPool,
  excludeAccountId: string
): Promise<{ accountId: string; familyGroupId: string } | null> {
  // Find all ACTIVE family groups with available slots whose account is HEALTHY
  const candidates = await prisma.familyGroup.findMany({
    where: {
      status: "ACTIVE",
      availableSlots: { gt: 0 },
      accountId: { not: excludeAccountId },
      account: { status: "HEALTHY" },
    },
    select: { id: true, accountId: true },
    orderBy: { createdAt: "asc" },
  });

  // Filter out accounts in cooldown or with too many failures
  for (const candidate of candidates) {
    const cooldown = await pool.isLoginCoolingDown(candidate.accountId);
    if (cooldown > 0) continue;

    const failures = await pool.getAccountTaskFailureCount(candidate.accountId);
    if (failures >= 5) continue;

    return { accountId: candidate.accountId, familyGroupId: candidate.id };
  }

  return null;
}

export async function processInvite(
  job: Job<InviteMemberPayload>,
  deps: InviteProcessorDeps
): Promise<void> {
  const { prisma, adspower, pool, workerId } = deps;
  const { orderId, userEmail } = job.data;
  let { accountId } = job.data;
  let familyGroupId = job.data.familyGroupId;
  // Compute member-level expiry: use payload value or default to 30 days from now
  const memberExpiresAt = job.data.memberExpiresAt
    ? new Date(job.data.memberExpiresAt)
    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const taskId = job.data.taskId ?? job.id ?? job.name;
  if (!taskId) {
    console.error(`[worker:${workerId}] invite job has no id or name, skipping`);
    return;
  }

  const logger = new TaskLogger(prisma, taskId, workerId);
  const browser = new WorkerBrowser();

  if (!accountId) {
    console.error(`[worker:${workerId}] invite job ${taskId} has no accountId — dropping stale job`);
    return;
  }

  let account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) {
    await logger.updateStatus("FAILED_FINAL", { code: "ACCOUNT_NOT_FOUND", message: `账号 ${accountId} 不存在` });
    return;
  }

  // Acquire a free profile + account lock from pool (AFTER account validation to avoid resource leak)
  let profileId: string | null = null;
  let stopHeartbeat: (() => void) | null = null;
  // Track accountId for account lock release; may change on fallback
  let lockedAccountId: string | null = null;

  try {
    await logger.updateStatus("RUNNING");

    // ── Pre-check: if original account is in cooldown or unhealthy, try fallback immediately ──
    if (!job.data.ignoreCooldown) {
      const cooldownSecs = await pool.isLoginCoolingDown(accountId);
      const inviteCooldownSecs = await pool.isInviteCoolingDown(accountId);
      const failureCount = await pool.getAccountTaskFailureCount(accountId);
      const accountUnhealthy = account.status !== "HEALTHY";

      if (cooldownSecs > 0 || inviteCooldownSecs > 0 || failureCount >= 5 || accountUnhealthy) {
        const reasons: string[] = [];
        if (cooldownSecs > 0) reasons.push(`登录冷却中(${cooldownSecs}秒)`);
        if (inviteCooldownSecs > 0) reasons.push(`邀请冷却中(${Math.ceil(inviteCooldownSecs/3600)}小时)`);
        if (failureCount >= 5) reasons.push(`累计失败${failureCount}次`);
        if (accountUnhealthy) reasons.push(`状态异常(${account.status})`);
        await logger.log("WARN",
          `[invite] 原主号不可用（${reasons.join('、')}），正在搜索替代账号...`
        );

        const alt = await findAlternativeAccount(prisma, pool, accountId);
        if (alt) {
          await logger.log("INFO", `[invite] 切换到替代账号 ${alt.accountId}（家庭组=${alt.familyGroupId}）`);
          accountId = alt.accountId;
          familyGroupId = alt.familyGroupId;
          account = await prisma.account.findUnique({ where: { id: accountId } });
          if (!account) {
            await logger.updateStatus("FAILED_FINAL", { code: "ACCOUNT_NOT_FOUND", message: `替代账号 ${accountId} 不存在` });
            return;
          }
          // Update task record to reflect new account/group
          await prisma.task.update({
            where: { id: taskId },
            data: { accountId, familyGroupId },
          }).catch(() => {});
          // Update order's family group assignment if needed
          if (orderId) {
            await prisma.order.update({
              where: { id: orderId },
              data: { familyGroupId },
            }).catch(() => {});
          }
        } else {
          await logger.log("WARN", `[invite] 没有可用的替代账号，任务失败`);
          await logger.updateStatus("FAILED_RETRYABLE", {
            code: "NO_HEALTHY_ACCOUNT",
            message: `原主号不可用（${reasons.join('、')}），且无可用替代账号`,
          });
          throw new UnrecoverableError(`No healthy account available for invite`);
        }
      }
    }

    // We will manually acquire the account lock first, so we can do a DB check
    // BEFORE opening the heavy Adspower browser instance.
    let debugUrl: string | null = null;
    const maxRetries = pool.poolSize;
    const failedProfiles = new Set<string>();
    const canForceClose = pool.createForceCloseGuard(workerId);

    try {
      // Re-check self-termination BEFORE even acquiring block lock
      const preCheck = await prisma.task.findUnique({ where: { id: taskId } });
      if (preCheck?.status === "INVITE_SENT" || preCheck?.status === "SUCCESS") {
        await logger.log("INFO", "Self-terminating immediately (picked up from queue but DB says already done)");
        return;
      }
    } catch(e) {}

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const acquiredLock = await pool.acquireForAccount(workerId, accountId, 180_000, failedProfiles);
      profileId = acquiredLock.profileId;
      lockedAccountId = accountId;

      // ── NEW: Self-Termination Check (after acquiring lock but before opening browser) ──
      const currentState = await prisma.task.findUnique({ where: { id: taskId } });
      if (currentState?.status === "INVITE_SENT" || currentState?.status === "SUCCESS") {
        await logger.log("INFO", "Self-terminating: task was already completed by another worker batch.");
        return; // finally block will gracefully release lock and profile
      }

      try {
        const opened = await adspower.openProfile(profileId, canForceClose);
        debugUrl = opened.debugUrl;
        break; // Success!
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await logger.log("WARN", `openProfile(${profileId}) failed: ${msg}. Retrying...`);
        failedProfiles.add(profileId);
        await adspower.closeProfile(profileId).catch(() => {});
        await pool.release(profileId, workerId).catch(() => {});
        await pool.releaseAccount(lockedAccountId, workerId).catch(() => {});
        profileId = null;
        lockedAccountId = null;
      }
    }

    if (!debugUrl || !profileId) {
      throw new Error(`Failed to open any adspower profile for account ${accountId}`);
    }

    // Start heartbeat AFTER successful profile open
    stopHeartbeat = pool.startHeartbeat(profileId, accountId, workerId);

    await logger.log("INFO", `Starting invite for ${userEmail}`, { profileId });

    const page = await browser.connect(debugUrl);
    await logger.log("INFO", "Browser connected via CDP");

    // Gmail auto-login (required every time — browser clears cache on start)
    const loginResult = await gmailLogin(page, account, logger);
    if (!loginResult.success) {
      // ── Login failed: try to switch to another account ──
      // Clean up current browser session first
      await browser.disconnect().catch(() => {});
      if (profileId) {
        await adspower.closeProfile(profileId).catch(() => {});
        await pool.release(profileId, workerId).catch(() => {});
        profileId = null;
      }
      // Release the account lock so fallback account can acquire it later
      if (lockedAccountId) {
        await pool.releaseAccount(lockedAccountId, workerId).catch(() => {});
        lockedAccountId = null;
      }

      // Record failure for this account (handleLoginResult also does this, but we need
      // to check for fallback BEFORE it throws)
      await pool.recordLoginFailure(accountId, 2 * 60 * 1000);
      const newFailCount = await pool.recordAccountTaskFailure(accountId);
      await logger.log("WARN",
        `Login failed for account ${accountId} (failures: ${newFailCount}/3). Searching for alternative...`
      );

      // Mark account RISKY if threshold reached
      if (newFailCount >= 3) {
        await prisma.account.update({
          where: { id: accountId },
          data: { status: "RISKY" as any },
        }).catch(() => {});
        await logger.log("ERROR",
          `Account ${accountId} reached ${newFailCount} failures — marked RISKY, needs human intervention`
        );
      }

      // Try to find alternative account
      const alt = await findAlternativeAccount(prisma, pool, accountId);
      if (alt) {
        await logger.log("INFO", `[invite] Switching to alternative account ${alt.accountId} (group=${alt.familyGroupId})`);
        // Update task and order to use new account/group
        await prisma.task.update({
          where: { id: taskId },
          data: { accountId: alt.accountId, familyGroupId: alt.familyGroupId },
        }).catch(() => {});
        if (orderId) {
          await prisma.order.update({
            where: { id: orderId },
            data: { familyGroupId: alt.familyGroupId },
          }).catch(() => {});
        }
        // Throw a retryable error — BullMQ will retry and pick up the new account
        throw new Error(`LOGIN_FAILED_SWITCHED:${alt.accountId}|Switched to alternative account, will retry`);
      }

      // No alternative — use normal handleLoginResult (may mark MANUAL_REVIEW)
      await handleLoginResult(loginResult, { job, pool, prisma, logger, accountId });
    }
    // Record which account is now logged into this profile
    await pool.setLastAccount(profileId!, accountId);

    // Ensure family group exists
    const ensureResult = await ensureFamilyGroup(page, account, prisma, logger);
    familyGroupId = ensureResult.familyGroupId;


    // Navigate to Google Family page, execute invite
    await browser.navigateTo(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await logger.log("INFO", "Navigated to Google Family page");

    // Lightweight pre-invite: count member cards (no detail page visits)
    const preInviteCardCount = await countMemberCardsOnPage(page);
    await logger.log("INFO", `Pre-invite member card count: ${preInviteCardCount}`);

    // Idempotency check: check DB if member already exists

    const existingMember = await prisma.familyMember.findFirst({
      where: {
        familyGroupId,
        email: userEmail,
        status: { in: ["ACTIVE", "PENDING"] },
      },
    });

    if (existingMember) {
      await logger.log("INFO",
        `[invite] Idempotency: ${userEmail} already in group (status=${existingMember.status}). Skipping invite.`
      );


      await logger.updateStatus("INVITE_SENT");
      if (orderId) {
        await logger.updateOrderStatus(orderId, "INVITE_SENT", `Member ${userEmail} already in family group`);
      }

      // Post-task sync already done above
      await logger.log("INFO", "Invite completed successfully (idempotent — already present)");

      if (deps.inviteQueue) {
        await checkTransferBatchProgress(prisma, taskId, deps.inviteQueue).catch((err) =>
          logger.log("WARN", `Transfer progress check failed: ${err instanceof Error ? err.message : String(err)}`)
        );
      }
      return; // Skip the actual invite
    }

    await executeInviteOnPage(page, userEmail, logger, prisma, familyGroupId, preInviteCardCount);


    await logger.updateStatus("INVITE_SENT");

    if (orderId) {
      await logger.updateOrderStatus(orderId, "INVITE_SENT", `Invite sent to ${userEmail}`);
    }

    // --- Capture gaiaId from family page after invite ---
    let capturedGaiaId: string | undefined;
    try {
      if (!page.url().includes("family/details")) {
        await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      }
      await page.waitForTimeout(1500);
      capturedGaiaId = await scanPageForMemberGaiaId(page, userEmail, prisma, familyGroupId);
      if (capturedGaiaId) {
        await logger.log("INFO", `Captured gaiaId=${capturedGaiaId} for ${userEmail}`);
      } else {
        await logger.log("WARN", `Could not capture gaiaId for ${userEmail} — will be filled on next sync`);
      }
    } catch {
      await logger.log("WARN", "gaiaId capture failed — will be filled on next sync");
    }

    // Upsert FamilyMember with gaiaId
    try {
      await prisma.familyMember.upsert({
        where: { familyGroupId_email: { familyGroupId, email: userEmail } },
        update: {
          status: "PENDING",
          displayName: userEmail.split("@")[0],
          expiresAt: memberExpiresAt,
          ...(capturedGaiaId ? { googleMemberId: capturedGaiaId } : {}),
        },
        create: {
          familyGroupId,
          email: userEmail,
          displayName: userEmail.split("@")[0],
          role: "member",
          status: "PENDING",
          expiresAt: memberExpiresAt,
          joinedAt: new Date(),
          googleMemberId: capturedGaiaId ?? undefined,
        },
      });

      const existingInvite = await prisma.familyInvite.findFirst({
        where: { familyGroupId, email: userEmail, status: "SENT" },
      });
      if (!existingInvite) {
        await prisma.familyInvite.create({ data: { familyGroupId, email: userEmail, status: "SENT" } });
      }
    } catch (dbErr) {
      await logger.log("WARN", `Failed to record invite in DB: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
    }

    // Lightweight post-invite verification: count cards instead of full sync.
    // This avoids visiting every member detail page (which creates placeholder
    // @gaia.unknown records when Google hides emails).
    try {
      if (!page.url().includes("family/details")) {
        await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      }
      await page.waitForTimeout(1500);
      const postInviteCardCount = await countMemberCardsOnPage(page);
      await logger.log("INFO", `Post-invite card count: ${postInviteCardCount} (was ${preInviteCardCount})`);

      // Update group slot counts based on card count
      const NON_ADMIN_CAPACITY = 5;
      const computedSlots = Math.max(0, NON_ADMIN_CAPACITY - postInviteCardCount);
      await prisma.familyGroup.update({
        where: { id: familyGroupId },
        data: {
          memberCount: postInviteCardCount,
          availableSlots: computedSlots,
          lastSyncedAt: new Date(),
        },
      });
      await logger.log("INFO", `Group counts updated: ${postInviteCardCount} members, ${computedSlots} slots available`);
    } catch (countErr) {
      await logger.log("WARN", `Post-invite card count failed (non-fatal): ${countErr instanceof Error ? countErr.message : String(countErr)}`);
    }

    await logger.log("INFO", "Invite completed successfully");

    // Transfer batch callback
    if (deps.inviteQueue) {
      await checkTransferBatchProgress(prisma, taskId, deps.inviteQueue).catch((err) =>
        logger.log("WARN", `Transfer progress check failed: ${err instanceof Error ? err.message : String(err)}`)
      );
    }

    // ── Batch invite: process additional waiting/active invite jobs for the same group ──
    // This avoids redundant browser open/login cycles when multiple invites are queued.
    // Instead of querying BullMQ (which misses ACTIVE tasks), we query the database.
    const batchTasks = await prisma.task.findMany({
      where: {
        accountId,
        familyGroupId,
        type: "INVITE_MEMBER",
        status: { in: ["PENDING", "RUNNING"] },
        id: { not: taskId },
      },
      orderBy: { createdAt: "asc" },
      take: 5,
    });

    let batchCount = 0;

    for (const nextTask of batchTasks) {
      // Check available slots after most recent sync
      const groupState = await prisma.familyGroup.findUnique({
        where: { id: familyGroupId },
        select: { availableSlots: true },
      });
      if (!groupState || groupState.availableSlots <= 0) {
        await logger.log("INFO", `[batch] No available slots — stopping batch`);
        break;
      }

      // Parse payload for job details
      let payload: any = {};
      try {
        payload = JSON.parse(nextTask.payload);
      } catch (e) {
        await logger.log("WARN", `[batch] Failed to parse payload for task ${nextTask.id}`);
        continue;
      }

      const nextUserEmail = payload.userEmail;
      const nextOrderId = nextTask.orderId || payload.orderId;
      const nextMemberExpiresAt = payload.memberExpiresAt
        ? new Date(payload.memberExpiresAt)
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      if (!nextUserEmail) continue;

      const batchLogger = new TaskLogger(prisma, nextTask.id, workerId);

      try {
        await batchLogger.updateStatus("RUNNING");
        await batchLogger.log("INFO", `[batch] Processing as part of batch (DB Takeover)`);

        // Extend the original job's lock so BullMQ doesn't think the parent stalled
        await job.extendLock(job.token ?? "", 300_000).catch(() => {});

        // Navigate to family page if not already there
        if (!page.url().includes("family/details")) {
          await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
        }

        // Idempotency check
        const alreadyExists = await prisma.familyMember.findFirst({
          where: {
            familyGroupId,
            email: nextUserEmail,
            status: { in: ["ACTIVE", "PENDING"] },
          },
        });

        if (alreadyExists) {
          await batchLogger.log("INFO", `[batch] ${nextUserEmail} already in group — skipping`);
          await batchLogger.updateStatus("INVITE_SENT");
          if (nextOrderId) {
            await batchLogger.updateOrderStatus(nextOrderId, "INVITE_SENT", `Member ${nextUserEmail} already in family group`);
          }
        } else {
          // Execute the invite
          await executeInviteOnPage(page, nextUserEmail, batchLogger, prisma, familyGroupId);

          await batchLogger.updateStatus("INVITE_SENT");
          if (nextOrderId) {
            await batchLogger.updateOrderStatus(nextOrderId, "INVITE_SENT", `Invite sent to ${nextUserEmail}`);
          }

          // Capture gaiaId
          let batchGaiaId: string | undefined;
          try {
            if (!page.url().includes("family/details")) {
              await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
            }
            await page.waitForTimeout(1500);
            batchGaiaId = await scanPageForMemberGaiaId(page, nextUserEmail, prisma, familyGroupId);
          } catch { /* non-fatal */ }

          // Upsert member record
          await prisma.familyMember.upsert({
            where: { familyGroupId_email: { familyGroupId, email: nextUserEmail } },
            update: {
              status: "PENDING",
              displayName: nextUserEmail.split("@")[0],
              expiresAt: nextMemberExpiresAt,
              ...(batchGaiaId ? { googleMemberId: batchGaiaId } : {}),
            },
            create: {
              familyGroupId,
              email: nextUserEmail,
              displayName: nextUserEmail.split("@")[0],
              role: "member",
              status: "PENDING",
              expiresAt: nextMemberExpiresAt,
              joinedAt: new Date(),
              googleMemberId: batchGaiaId ?? undefined,
            },
          }).catch((e) => batchLogger.log("WARN", `DB upsert failed: ${e instanceof Error ? e.message : String(e)}`));

          const existingInvite = await prisma.familyInvite.findFirst({
            where: { familyGroupId, email: nextUserEmail, status: "SENT" },
          });
          if (!existingInvite) {
            await prisma.familyInvite.create({ data: { familyGroupId, email: nextUserEmail, status: "SENT" } }).catch(() => {});
          }

          // Lightweight post-invite: count cards instead of full sync
          try {
            if (!page.url().includes("family/details")) {
              await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
            }
            await page.waitForTimeout(1500);
            const batchCardCount = await countMemberCardsOnPage(page);
            const NON_ADMIN_CAPACITY = 5;
            const computedSlots = Math.max(0, NON_ADMIN_CAPACITY - batchCardCount);
            await prisma.familyGroup.update({
              where: { id: familyGroupId },
              data: {
                memberCount: batchCardCount,
                availableSlots: computedSlots,
                lastSyncedAt: new Date(),
              },
            });
            await batchLogger.log("INFO", `Post-invite card count: ${batchCardCount}, ${computedSlots} slots available`);
          } catch (countErr) {
            await batchLogger.log("WARN", `Post-invite card count failed (non-fatal): ${countErr instanceof Error ? countErr.message : String(countErr)}`);
          }
        }

        // Note: We DO NOT call moveToCompleted on BullMQ here.
        // The corresponding worker for this task will wake up (or pick it up),
        // check the DB, see INVITE_SENT, and self-terminate gracefully in BullMQ.

        // Transfer batch callback for this job
        if (deps.inviteQueue) {
            await checkTransferBatchProgress(prisma, nextTask.id, deps.inviteQueue).catch(() => {});
        }

        batchCount++;
        await batchLogger.log("INFO", `[batch] Invite completed successfully`);

      } catch (batchErr) {
        const errMsg = batchErr instanceof Error ? batchErr.message : String(batchErr);
        await batchLogger.log("ERROR", `[batch] Invite failed: ${errMsg}`);
        await batchLogger.updateStatus("FAILED_RETRYABLE", {
          code: "BATCH_INVITE_ERROR",
          message: errMsg,
        });
        // Stop batch on first failure — remaining jobs stay in DB for normal processing
        break;
      }
    }

    if (batchCount > 0) {
      await logger.log("INFO", `[batch] Processed ${batchCount} additional invite(s) in this session`);
    }
  } catch (error) {
    // --- Auto-reassign: intercept MANUAL_REVIEW and FAMILY_FULL ---
    // FAMILY_FULL always triggers reassign (with or without orderId).
    // MANUAL_REVIEW only triggers reassign when orderId exists (order-backed tasks).
    const isManualReview = error instanceof UnrecoverableError && error.message === "MANUAL_REVIEW";
    const isFamilyFull = error instanceof UnrecoverableError && (error.message ?? "").startsWith("FAMILY_FULL");
    const shouldAutoReassign = isManualReview || isFamilyFull;
    const canReassign = isFamilyFull
      ? (shouldAutoReassign && deps.inviteQueue != null)
      : (shouldAutoReassign && orderId != null && deps.inviteQueue != null);

    if (canReassign) {
      try {
        // 1. Resolve the old familyGroupId
        const currentTask = await prisma.task.findUnique({
          where: { id: taskId },
          select: { familyGroupId: true },
        });
        const oldGroupId = currentTask?.familyGroupId ?? job.data.familyGroupId;

        // 2. Release old group slot
        if (oldGroupId) {
          if (isFamilyFull) {
            // FAMILY_FULL: availableSlots already set to 0 by detection logic,
            // just decrement pendingInviteCount
            await prisma.familyGroup.updateMany({
              where: { id: oldGroupId, pendingInviteCount: { gt: 0 } },
              data: { pendingInviteCount: { decrement: 1 } },
            });
          } else {
            // MANUAL_REVIEW: release slot normally
            await prisma.familyGroup.update({
              where: { id: oldGroupId },
              data: { availableSlots: { increment: 1 } },
            });
            await prisma.familyGroup.updateMany({
              where: { id: oldGroupId, pendingInviteCount: { gt: 0 } },
              data: { pendingInviteCount: { decrement: 1 } },
            });
          }
        }

        // 3. Find the next healthy group (exclude the failed one)
        const newGroup = await prisma.familyGroup.findFirst({
          where: {
            status: "ACTIVE",
            availableSlots: { gt: 0 },
            account: { status: "HEALTHY" },
            ...(oldGroupId ? { id: { not: oldGroupId } } : {}),
          },
          include: { account: { select: { id: true, loginEmail: true } } },
          orderBy: { createdAt: "asc" },
        });

        if (newGroup) {
          // 4. Reserve slot in new group
          await prisma.familyGroup.update({
            where: { id: newGroup.id },
            data: {
              availableSlots: { decrement: 1 },
              pendingInviteCount: { increment: 1 },
            },
          });

          // 5. Update Order to point to new group (skip if no order — bulkInvite tasks)
          if (orderId) {
            await prisma.order.update({
              where: { id: orderId },
              data: {
                familyGroupId: newGroup.id,
                status: "TASK_QUEUED" as any,
                resultMessage: null,
              },
            });
          }

          // 6. Mark current task as FAILED_FINAL
          await logger.updateStatus("FAILED_FINAL", {
            code: "AUTO_REASSIGNED",
            message: `已自动重新分配到家庭组 ${newGroup.id}（原因: ${isFamilyFull ? "原家庭组已满" : "原任务异常"}）`,
          });

          // 7. Create new task and enqueue — include transfer note
          const oldAcctInfo = await prisma.account.findUnique({
            where: { id: accountId },
            select: { loginEmail: true },
          });
          const reason = isFamilyFull ? "家庭组已满" : "任务异常";
          const reassignNote = `原母号 ${oldAcctInfo?.loginEmail ?? accountId} ${reason}，已转移至母号 ${newGroup.account.loginEmail}`;
          const newTask = await prisma.task.create({
            data: {
              type: "INVITE_MEMBER",
              ...(orderId ? { orderId } : {}),
              familyGroupId: newGroup.id,
              accountId: newGroup.accountId,
              lastErrorCode: "TRANSFERRED",
              lastErrorMessage: reassignNote,
              payload: JSON.stringify({
                ...(orderId ? { orderId } : {}),
                familyGroupId: newGroup.id,
                accountId: newGroup.accountId,
                userEmail,
              }),
            },
          });

          await deps.inviteQueue!.add(
            "invite-member",
            {
              taskId: newTask.id,
              ...(orderId ? { orderId } : {}),
              familyGroupId: newGroup.id,
              accountId: newGroup.accountId,
              userEmail,
            },
            { ...JOB_DEFAULTS }
          );

          await logger.log("INFO",
            `已自动重新分配 ${orderId ? `订单 ${orderId}` : `任务 ${taskId}`}：从家庭组 ${oldGroupId} 转到 ${newGroup.id}（新任务 ${newTask.id}）`
          );

          // Task has been auto-handled — do NOT rethrow
          return;
        }
        // else: no healthy group available → mark FAILED_FINAL immediately
        await logger.log("WARN",
          `Auto-reassign: no healthy group available — marking FAILED_FINAL (${isFamilyFull ? "FAMILY_FULL" : "MANUAL_REVIEW"})`
        );
        await logger.updateStatus("FAILED_FINAL", {
          code: isFamilyFull ? "FAMILY_FULL_NO_ALT" : "MANUAL_REVIEW_NO_ALT",
          message: `无可用家庭组可以重新分配（${isFamilyFull ? "所有家庭组已满" : "无健康的家庭组"}）`,
        });
        return;
      } catch (reassignErr) {
        // Reassign process failed → log and fall through
        await logger.log("ERROR",
          `Auto-reassign failed: ${reassignErr instanceof Error ? reassignErr.message : String(reassignErr)}`
        );
      }
      // Reassign errored → rethrow original error
      throw error;
    }

    // ── INVITE_COOLDOWN: Google rate-limited this account's invite capability ──
    if (error instanceof InviteCooldownError) {
      // 1. Record 24h invite cooldown for this account (Redis)
      await pool.recordInviteCooldown(accountId);
      // 1b. Also mark all family groups for this account as MANUAL_ONLY in the DB,
      // so the API's findAvailableGroup() won't assign new invite tasks to this account.
      // Without this, only Redis had the cooldown info and the API (which only reads DB)
      // would keep assigning tasks that immediately get re-routed.
      await prisma.familyGroup.updateMany({
        where: { accountId, status: "ACTIVE" },
        data: { status: "MANUAL_ONLY" },
      }).catch(() => {});
      await prisma.account.update({
        where: { id: accountId },
        data: { syncError: "INVITE_COOLDOWN" },
      }).catch(() => {});
      await logger.log("ERROR",
        `账号 ${accountId} 触发 Google 邀请频率限制 — 已设置 24 小时邀请冷却，家庭组已标记为 MANUAL_ONLY`
      );

      // 2. Check if this is a SWAP/REPLACE order (user-facing swap)
      let isSwapOrder = false;
      if (orderId) {
        const order = await prisma.order.findUnique({
          where: { id: orderId },
          select: { orderType: true },
        }).catch(() => null);
        isSwapOrder = order?.orderType === "SWAP" || order?.orderType === "SUBSCRIPTION";
      }

      if (isSwapOrder) {
        // SWAP/REPLACE: Cannot auto-reassign (must use same group's account).
        // Mark task and order as failed with user-facing message.
        await logger.updateStatus("FAILED_FINAL", {
          code: "INVITE_COOLDOWN",
          message: `主号邀请次数过多，24小时后可继续替换`,
        });
        if (orderId) {
          await logger.updateOrderStatus(orderId, "FAILED", `主号邀请次数过多，24小时后可继续替换`);
        }
        await logger.log("INFO", `SWAP/REPLACE order — notifying user: 24h cooldown`);
        return;
      }

      // JOIN / Transfer / Console invite: try auto-reassign to another account
      if (deps.inviteQueue) {
        try {
          const currentTask = await prisma.task.findUnique({
            where: { id: taskId },
            select: { familyGroupId: true },
          });
          const oldGroupId = currentTask?.familyGroupId ?? familyGroupId;

          // Release slot from old group
          if (oldGroupId) {
            await prisma.familyGroup.update({
              where: { id: oldGroupId },
              data: { availableSlots: { increment: 1 } },
            }).catch(() => {});
            await prisma.familyGroup.updateMany({
              where: { id: oldGroupId, pendingInviteCount: { gt: 0 } },
              data: { pendingInviteCount: { decrement: 1 } },
            }).catch(() => {});
          }

          // Find an alternative account (excluding cooldown ones)
          const newGroup = await prisma.familyGroup.findFirst({
            where: {
              status: "ACTIVE",
              availableSlots: { gt: 0 },
              account: { status: "HEALTHY" },
              ...(oldGroupId ? { id: { not: oldGroupId } } : {}),
            },
            include: { account: { select: { id: true, loginEmail: true } } },
            orderBy: { createdAt: "asc" },
          });

          if (newGroup) {
            // Check if the new account is also in invite cooldown
            const newCooldown = await pool.isInviteCoolingDown(newGroup.accountId);
            if (newCooldown > 0) {
              await logger.log("WARN",
                `Alternative account ${newGroup.accountId} also in invite cooldown (${newCooldown}s). No viable alternative.`
              );
            } else {
              // Reserve slot in new group
              await prisma.familyGroup.update({
                where: { id: newGroup.id },
                data: {
                  availableSlots: { decrement: 1 },
                  pendingInviteCount: { increment: 1 },
                },
              });

              // Update Order if applicable
              if (orderId) {
                await prisma.order.update({
                  where: { id: orderId },
                  data: {
                    familyGroupId: newGroup.id,
                    status: "TASK_QUEUED" as any,
                    resultMessage: null,
                  },
                });
              }

              // Mark current task as FAILED_FINAL
              await logger.updateStatus("FAILED_FINAL", {
                code: "INVITE_COOLDOWN_REASSIGNED",
                message: `主号邀请次数过多，已自动重新分配到家庭组 ${newGroup.id}`,
              });

              // Create new task and enqueue — include transfer note
              const oldAcct = await prisma.account.findUnique({
                where: { id: accountId },
                select: { loginEmail: true },
              });
              const transferNote = `原母号 ${oldAcct?.loginEmail ?? accountId} 邀请受限，已转移至母号 ${newGroup.account.loginEmail}`;
              const newTask = await prisma.task.create({
                data: {
                  type: "INVITE_MEMBER",
                  ...(orderId ? { orderId } : {}),
                  familyGroupId: newGroup.id,
                  accountId: newGroup.accountId,
                  lastErrorCode: "TRANSFERRED",
                  lastErrorMessage: transferNote,
                  payload: JSON.stringify({
                    ...(orderId ? { orderId } : {}),
                    familyGroupId: newGroup.id,
                    accountId: newGroup.accountId,
                    userEmail,
                  }),
                },
              });

              await deps.inviteQueue.add(
                "invite-member",
                {
                  taskId: newTask.id,
                  ...(orderId ? { orderId } : {}),
                  familyGroupId: newGroup.id,
                  accountId: newGroup.accountId,
                  userEmail,
                },
                { ...JOB_DEFAULTS }
              );

              await logger.log("INFO",
                `主号邀请冷却，已自动切换到账号 ${newGroup.accountId}（家庭组 ${newGroup.id}）`
              );
              return;
            }
          }

          // No alternative available — mark FAILED_FINAL
          await logger.log("WARN", `没有可用的替代账号（全部在冷却或无剩余位置），标记任务失败`);
          await logger.updateStatus("FAILED_FINAL", {
            code: "INVITE_COOLDOWN_NO_ALT",
            message: `主号邀请次数过多，且无可用替代主号。24小时后可重试。`,
          });
          if (orderId) {
            await logger.updateOrderStatus(orderId, "FAILED", `主号邀请次数过多，且无可用替代主号。24小时后可重试。`);
          }
          return;
        } catch (reassignErr) {
          await logger.log("ERROR",
            `Invite cooldown reassign failed: ${reassignErr instanceof Error ? reassignErr.message : String(reassignErr)}`
          );
        }
      }

      // No inviteQueue or reassign failed — mark FAILED_FINAL
      await logger.updateStatus("FAILED_FINAL", {
        code: "INVITE_COOLDOWN",
        message: `主号邀请次数过多，24小时后可重试。`,
      });
      if (orderId) {
        await logger.updateOrderStatus(orderId, "FAILED", `主号邀请次数过多，24小时后可重试。`);
      }
      return;
    }

    // UnrecoverableError that we don't auto-reassign (e.g. LOGIN_COOLDOWN)
    if (error instanceof UnrecoverableError) throw error;

    const errMsg = error instanceof Error ? error.message : String(error);
    try {
    } catch { /* noop */ }

    await logger.updateStatus("FAILED_RETRYABLE", {
      code: profileId ? "INVITE_ERROR" : "PROFILE_ACQUIRE_FAILED",
      message: errMsg
    });
    await logger.log("ERROR", `邀请失败（将重试）: ${errMsg}`);

    // Transfer batch callback on terminal failure
    if (deps.inviteQueue && job.attemptsMade >= (job.opts?.attempts ?? 3) - 1) {
      const transferTask = await prisma.task.findUnique({
        where: { id: taskId },
        select: { transferBatchId: true },
      }).catch(() => null);

      if (transferTask?.transferBatchId) {
        await prisma.task.update({
          where: { id: taskId },
          data: { status: "FAILED_FINAL" },
        }).catch(() => {});
        await checkTransferBatchProgress(prisma, taskId, deps.inviteQueue).catch(() => {});
      }
    }

    throw error;
  } finally {
    stopHeartbeat?.();
    await browser.disconnect().catch(() => {});
    if (profileId) {
      await adspower.closeProfile(profileId).catch(() => {});
      await pool.release(profileId, workerId).catch(() => {});
    }
    if (lockedAccountId) {
      await pool.releaseAccount(lockedAccountId, workerId).catch(() => {});
    }
  }
}

/**
 * Lightweight member count: counts non-admin member cards on the family page
 * WITHOUT visiting any detail pages. This avoids creating placeholder @gaia.unknown
 * records when Google hides member emails.
 *
 * Returns the number of non-admin member cards on the page.
 */
export async function countMemberCardsOnPage(page: import("playwright").Page): Promise<number> {
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 });

  const count = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="family/member/"]');
    const managerKw = ["family manager", "家庭群组管理员", "家庭群組管理員", "管理者"];

    let memberCount = 0;
    const seenGaiaIds = new Set<string>();

    for (const link of Array.from(links)) {
      const href = link.getAttribute("href") ?? "";

      // Deduplicate by GAIA ID
      const gaiaId =
        href.match(/\/g\/([\d]+)/)?.[1] ??
        href.match(/\/member\/i\/([-\d]+)/)?.[1] ??
        href.match(/\/member\/([-\d]+)/)?.[1] ??
        href;
      if (seenGaiaIds.has(gaiaId)) continue;
      seenGaiaIds.add(gaiaId);

      // Check if this is the family manager card
      const card = link.closest("li, [data-member], .member-card") ?? link.parentElement;
      if (card) {
        const cardText = Array.from(card.querySelectorAll("*"))
          .filter((el) => el.children.length === 0 && !link.contains(el))
          .map((el) => el.textContent?.trim() ?? "")
          .join(" ")
          .toLowerCase();
        if (managerKw.some((kw) => cardText.includes(kw))) continue;
      }

      memberCount++;
    }
    return memberCount;
  });

  return count;
}

/**
 * Check the result page after clicking Send on the invite form.
 *
 * After clicking Send, Google navigates to `invitationcomplete`.
 * This function reads the result page text to determine success or failure.
 *
 * Known error patterns (from live network captures):
 * - "Your invitation wasn't sent" (or localized variants)
 * - "You've sent too many invites this week. Try again in a few days."
 * - "There was a problem inviting these people"
 * - RPC error code [39] in the batchexecute response
 *
 * @returns 'success' if invite was sent, 'rate_limited' if too many invites,
 *          'error' for other errors, or the raw error text.
 */
export interface InviteResultCheck {
  outcome: "success" | "rate_limited" | "error";
  /** Raw page text snippet for logging */
  pageText: string;
  /** Specific error detail if available */
  errorDetail?: string;
}

export async function checkInviteResultPage(
  page: import("playwright").Page,
  logger: TaskLogger
): Promise<InviteResultCheck> {
  const currentUrl = page.url();

  // ── Wait for the result page to fully render ──
  // Google's invitationcomplete page renders content asynchronously via their
  // WIZ/JS framework. Just waiting for domcontentloaded is NOT enough — the
  // error text (e.g. "Your invitation wasn't sent") may appear several seconds
  // after the initial page load.
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});

  // Poll for meaningful body text to appear (error or success indicators).
  // Google's result page will show either "invitation wasn't sent" or a success
  // message — both contain "invit" or similar keywords. Wait until we see
  // meaningful text or timeout after 8 seconds.
  const POLL_INTERVAL = 500;
  const MAX_WAIT = 8_000;
  let bodyText = "";
  const meaningfulPatterns = [
    "invit", "sent", "problem", "too many",          // English
    "邀请", "邀請", "发送", "傳送", "问题", "問題",    // Chinese
    "招待", "送信",                                    // Japanese
    "초대", "전송",                                    // Korean
    "mời", "gửi",                                     // Vietnamese
  ];

  for (let waited = 0; waited < MAX_WAIT; waited += POLL_INTERVAL) {
    bodyText = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    const lower = bodyText.toLowerCase();
    if (bodyText.length > 100 && meaningfulPatterns.some((p) => lower.includes(p))) {
      break; // Page has rendered meaningful content
    }
    await page.waitForTimeout(POLL_INTERVAL);
  }

  // Final read after waiting
  if (bodyText.length < 50) {
    bodyText = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  }

  const bodyLower = bodyText.toLowerCase();
  const snippet = bodyText.slice(0, 500);

  // ── Rate limit detection (multi-language) ──
  const rateLimitPatterns = [
    // English
    "too many invites",
    "sent too many",
    "try again in a few days",
    // Chinese Simplified
    "发送的邀请太多",
    "邀请次数过多",
    "过几天再试",
    // Chinese Traditional
    "發送的邀請太多",
    "邀請次數過多",
    // Japanese
    "招待を送りすぎ",
    // Korean
    "초대를 너무 많이",
    // Vietnamese
    "quá nhiều lời mời",
  ];

  const isRateLimited = rateLimitPatterns.some((p) => bodyLower.includes(p.toLowerCase()));
  if (isRateLimited) {
    // Extract the specific error text for logging
    const errorLine = bodyText.split("\n").find((l) =>
      rateLimitPatterns.some((p) => l.toLowerCase().includes(p.toLowerCase()))
    ) ?? "rate limited";
    await logger.log("ERROR",
      `[checkInviteResult] RATE LIMITED detected on result page. ` +
      `URL: ${currentUrl}, Error: ${errorLine.trim()}`
    );
    return { outcome: "rate_limited", pageText: snippet, errorDetail: errorLine.trim() };
  }

  // ── Generic failure detection (multi-language) ──
  const failurePatterns = [
    // English
    "invitation wasn't sent",
    "invitation was not sent",
    "problem inviting",
    "something went wrong",
    // Chinese
    "邀请未发送",
    "邀請未傳送",
    "邀请出现问题",
    "邀請出現問題",
    // Japanese
    "招待は送信されませんでした",
    // Korean
    "초대가 전송되지 않았습니다",
  ];

  const hasFailed = failurePatterns.some((p) => bodyLower.includes(p.toLowerCase()));
  if (hasFailed) {
    // Check if it explicitly mentions an email with an error code
    // Google shows: "There was a problem inviting these people\nbingcha135@gmail.com\nYou've sent too many..."
    const errorLine = bodyText.split("\n").find((l) =>
      failurePatterns.some((p) => l.toLowerCase().includes(p.toLowerCase()))
    ) ?? "invite failed";
    await logger.log("ERROR",
      `[checkInviteResult] FAILURE detected on result page. ` +
      `URL: ${currentUrl}, Error: ${errorLine.trim()}`
    );
    return { outcome: "error", pageText: snippet, errorDetail: errorLine.trim() };
  }

  // ── Success detection ──
  // On success, Google shows a different page ("Invitation sent" / results page
  // without error messages). If we reached invitationcomplete without error text,
  // OR if we're on family/details, it's likely success.
  if (currentUrl.includes("invitationcomplete") || currentUrl.includes("family/details")) {
    await logger.log("INFO",
      `[checkInviteResult] SUCCESS — result page has no error indicators. URL: ${currentUrl}`
    );
    return { outcome: "success", pageText: snippet };
  }

  // ── Fallback: unknown page ──
  await logger.log("WARN",
    `[checkInviteResult] UNKNOWN result page. URL: ${currentUrl}, body: ${snippet.slice(0, 200)}`
  );
  return { outcome: "success", pageText: snippet };
}

async function executeInviteOnPage(
  page: import("playwright").Page,
  email: string,
  logger: TaskLogger,
  prisma?: PrismaClient,
  familyGroupId?: string,
  preInviteCardCount?: number
): Promise<void> {
  // Ensure we're on the family details page — postTaskSync may leave us on a member detail page
  if (!page.url().includes("family/details")) {
    await page.goto("https://myaccount.google.com/family/details?hl=en", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
  }
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 });

  // Primary selector: link with href containing "invitemembers"
  const inviteLink = page.locator('a[href*="invitemembers"]');
  // Fallback selector: button/link with invite-related text
  const inviteFallback = page.locator([
    'a:has-text("Invite member")',
    'a:has-text("Invite family member")',
    'a:has-text("Add member")',
    'button:has-text("Invite member")',
    'button:has-text("Invite family member")',
    // Chinese
    'a:has-text("邀请成员")',
    'a:has-text("邀請成員")',
    // Japanese
    'a:has-text("メンバーを招待")',
    // Korean
    'a:has-text("구성원 초대")',
    'a:has-text("가족 구성원 초대")',
    'button:has-text("구성원 초대")',
    // Vietnamese
    'a:has-text("Mời thành viên")',
    'a:has-text("Thêm thành viên")',
    'button:has-text("Mời thành viên")',
  ].join(", "));

  let inviteElement: import("playwright").Locator | null = null;
  try {
    await inviteLink.first().waitFor({ state: "visible", timeout: 15_000 });
    inviteElement = inviteLink.first();
  } catch {
    // Try fallback selectors
    if ((await inviteFallback.count()) > 0) {
      await logger.log("INFO", "Found invite button via fallback text selector");
      inviteElement = inviteFallback.first();
    }
  }

  // ── Retry with page refreshes ──
  // After member removal, Google may need 30-90s to propagate the change
  // and re-show the invite link. Refresh the page up to 6 times with 5s
  // delays between each attempt (total extra wait: ~60-90s).
  if (!inviteElement) {
    const REFRESH_RETRIES = 6;
    const REFRESH_DELAY_MS = 5_000;

    for (let retry = 0; retry < REFRESH_RETRIES; retry++) {
      await logger.log("INFO",
        `Invite link not visible — refreshing page (${retry + 1}/${REFRESH_RETRIES}, waiting ${REFRESH_DELAY_MS / 1000}s)...`
      );
      await page.waitForTimeout(REFRESH_DELAY_MS);
      await page.goto("https://myaccount.google.com/family/details?hl=en", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      try {
        await inviteLink.first().waitFor({ state: "visible", timeout: 10_000 });
        inviteElement = inviteLink.first();
        await logger.log("INFO", `Invite link appeared after ${retry + 1} refresh(es)`);
        break;
      } catch {
        if ((await inviteFallback.count()) > 0) {
          inviteElement = inviteFallback.first();
          await logger.log("INFO", `Found invite button via fallback after ${retry + 1} refresh(es)`);
          break;
        }
      }
    }
  }

  if (!inviteElement) {
    const url = page.url();
    const bodySnippet = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? "").catch(() => "?");

    // Check if family is full: member cards exist but no invite link
    const memberCardCount = await page.locator('a[href*="family/member"]').count();
    if (memberCardCount > 0) {
      // Before declaring FAMILY_FULL, check if target member is already on the page.
      // Google may hide the email on the list page but show it on the detail page.
      // This handles retry/batch scenarios where the invite already succeeded.
      await logger.log("INFO",
        `No invite link found (${memberCardCount} cards). ` +
        `Checking detail pages for target ${email}...`
      );

      const memberHrefs: string[] = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href*="family/member/"]'))
          .map((a) => (a as HTMLAnchorElement).href)
          .filter(Boolean)
      );

      let targetAlreadyOnPage = false;
      for (const href of memberHrefs) {
        try {
          await page.goto(href, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await page.waitForTimeout(500);

          // Layer 1: visible leaf-node email text
          const detailEmails: string[] = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("*"))
              .filter((el) => el.children.length === 0)
              .map((el) => el.textContent?.trim() ?? "")
              .filter((t) => /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(t));
          });
          if (detailEmails.some((e) => e.toLowerCase() === email.toLowerCase())) {
            targetAlreadyOnPage = true;
            await logger.log("INFO", `Target ${email} found via visible text on ${href}`);
            break;
          }

          // Layer 2: raw HTML search (Google may embed email in JS data even when hidden visually)
          const foundInRawHtml = await page.evaluate((targetEmail: string) => {
            const rawHtml = document.documentElement.innerHTML;
            const emailRegex = /"([^"]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})"/g;
            let m;
            while ((m = emailRegex.exec(rawHtml)) !== null) {
              if (m[1].toLowerCase() === targetEmail.toLowerCase()) return true;
            }
            return false;
          }, email);
          if (foundInRawHtml) {
            targetAlreadyOnPage = true;
            await logger.log("INFO", `Target ${email} found via raw HTML on ${href}`);
            break;
          }
        } catch { /* continue checking next card */ }
      }

      // Navigate back to family list page
      await page.goto("https://myaccount.google.com/family/details?hl=en", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      }).catch(() => {});

      if (targetAlreadyOnPage) {
        await logger.log("INFO", `Idempotent: ${email} already in family group — skipping invite`);
        return; // Member already invited, treat as success
      }

      // Truly full — target member is NOT on the page
      await logger.log("ERROR",
        `Family group is FULL (${memberCardCount} member cards, no invite link). ` +
        `Target ${email} not found on any detail page. Cannot invite.`
      );

      // Sync DB to mark this group as full
      if (prisma && familyGroupId) {
        await prisma.familyGroup.update({
          where: { id: familyGroupId },
          data: { availableSlots: 0 },
        }).catch(() => {});
        await logger.log("INFO", `Updated familyGroup ${familyGroupId} availableSlots=0`);
      }

      throw new UnrecoverableError(
        `FAMILY_FULL: Family group has ${memberCardCount} member(s) and no invite link. ` +
        `Target ${email} not found on any detail page. URL: ${url}`
      );
    }

    throw new Error(`Cannot find invite link on family page. URL: ${url}, body: ${bodySnippet}`);
  }

  await inviteElement.click();
  await logger.log("INFO", "Clicked invite link");
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 });
  await page.waitForTimeout(2000);

  await page.waitForURL(/invitemembers/, { timeout: 10000 }).catch(async () => {
    await page.waitForLoadState("domcontentloaded", { timeout: 60000 });
    if (!page.url().includes("invitemembers")) {
      throw new Error(`Expected invitemembers page, got: ${page.url()}`);
    }
  });

  const emailInput = page.locator([
    "input.I4p4db",
    'input[placeholder*="電子郵件"]',
    'input[placeholder*="电子邮件"]',
    'input[placeholder*="email" i]',
    'input[placeholder*="メール"]',
    'input[placeholder*="이메일"]',
    'input[type="email"]',
  ].join(", "));

  try {
    await emailInput.first().waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    const url = page.url();
    const bodySnippet = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? "").catch(() => "?");
    throw new Error(`Cannot find email input on invite page. URL: ${url}, body: ${bodySnippet}`);
  }

  await emailInput.first().fill(email);
  await logger.log("INFO", `Filled email: ${email}`);
  await page.waitForTimeout(1500);
  await emailInput.first().press("Enter");
  await page.waitForTimeout(1000);

  const sendButton = page.locator(
    'button:has-text("傳送"), button:has-text("Send"), button:has-text("发送"), ' +
    'button:has-text("보내기"), button:has-text("전송"), ' +
    'button:has-text("送信"), ' +
    'button:has-text("Gửi")'
  );
  if ((await sendButton.count()) === 0) throw new Error("Cannot find send button on invite page");

  await sendButton.first().click();
  await logger.log("INFO", "Clicked send invite button");

  // Wait for page to navigate away from invitemembers (to invitationcomplete or family/details)
  try {
    await page.waitForURL(
      (url) => !url.toString().includes("invitemembers"),
      { timeout: 15_000 }
    );
  } catch {
    const currentUrl = page.url();
    if (currentUrl.includes("invitemembers")) {
      await logger.log("WARN", "Still on invite page after 15s — invite may not have been sent");
    }
  }
  await page.waitForTimeout(2000);

  // ── Post-send: check result page for success or failure ──
  // Google navigates to 'invitationcomplete' after Send. The page text tells us
  // exactly what happened — no need to count cards or scan detail pages.
  const inviteResult = await checkInviteResultPage(page, logger);

  if (inviteResult.outcome === "rate_limited") {
    // Google explicitly says "too many invites" — throw InviteCooldownError
    // immediately without any retries (server-side enforced, retries are pointless).
    await logger.log("ERROR",
      `Invite RATE LIMITED by Google backend. Detail: ${inviteResult.errorDetail ?? "unknown"}`
    );
    throw new InviteCooldownError("unknown");
  }

  if (inviteResult.outcome === "error") {
    // Generic failure (not rate limit) — could be account issue, network, etc.
    // Log the error and throw retryable error so BullMQ can retry later.
    await logger.log("ERROR",
      `Invite FAILED (non-rate-limit). Detail: ${inviteResult.errorDetail ?? "unknown"}. ` +
      `Page: ${inviteResult.pageText.slice(0, 200)}`
    );
    throw new Error(
      `INVITE_FAILED: ${inviteResult.errorDetail ?? "Google returned an error on the result page"}`
    );
  }

  // outcome === "success" — invite was sent successfully
  await logger.log("INFO", "Invite result: SUCCESS (result page confirmed)");
}

async function scanPageForMemberGaiaId(
  page: import("playwright").Page,
  email: string,
  prisma: PrismaClient,
  familyGroupId: string
): Promise<string | undefined> {
  const result = await page.evaluate((targetEmail: string) => {
    const links = document.querySelectorAll('a[href*="family/member/"]');
    const lowerTarget = targetEmail.toLowerCase();
    for (const link of Array.from(links)) {
      const card = link.closest("li") ?? link.parentElement;
      const cardText = card?.textContent?.toLowerCase() ?? "";
      if (cardText.includes(lowerTarget)) {
        const href = link.getAttribute("href") ?? "";
        const match =
          href.match(/\/g\/(\d+)/) ??
          href.match(/\/member\/i\/([-\d]+)/) ??
          href.match(/\/member\/([-\d]+)/);
        return match?.[1] ?? null;
      }
    }
    return null;
  }, email);

  if (result) return result;

  // Fallback: If Google hid the email text entirely, look for any new GAIA ID on the page 
  // that we don't already know about in the DB.
  // IMPORTANT: Exclude the family manager's GAIA ID — it also appears in the member links
  // but must NOT be assigned to a child member. The manager card is identified by the
  // "Family manager" (or localized) label in the card text.
  const allIdsWithContext = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="family/member/"]');
    const managerKw = [
      "family manager", "家庭群组管理员", "家庭群組管理員",
      "관리자", "管理者", "quản lý",
    ];
    const results: Array<{ id: string; isManager: boolean }> = [];
    const seen = new Set<string>();

    for (const link of Array.from(links)) {
      const href = link.getAttribute("href") ?? "";
      const match =
        href.match(/\/g\/(\d+)/) ??
        href.match(/\/member\/i\/([-\d]+)/) ??
        href.match(/\/member\/([-\d]+)/);
      if (!match?.[1] || seen.has(match[1])) continue;
      seen.add(match[1]);

      const card = link.closest("li") ?? link.parentElement;
      const cardText = card?.textContent?.toLowerCase() ?? "";
      const isManager = managerKw.some((kw) => cardText.includes(kw));
      results.push({ id: match[1], isManager });
    }
    return results;
  });

  // Filter out manager and already-known IDs
  const nonManagerIds = allIdsWithContext.filter((r) => !r.isManager).map((r) => r.id);

  if (nonManagerIds.length > 0) {
    const existing = await prisma.familyMember.findMany({
      where: { familyGroupId, googleMemberId: { in: nonManagerIds } },
      select: { googleMemberId: true }
    });
    const existingSet = new Set(existing.map(e => e.googleMemberId!));
    const newIds = nonManagerIds.filter(id => !existingSet.has(id));
    if (newIds.length > 0) {
      // Pick the first new ID, assuming this is the one we just invited
      return newIds[0];
    }
  }

  return undefined;
}
