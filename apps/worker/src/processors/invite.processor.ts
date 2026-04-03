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
import { postTaskSync } from "../post-task-sync";
import { Queue } from "bullmq";

const GOOGLE_FAMILY_URL = "https://myaccount.google.com/family/details?hl=en";

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
    if (failures >= 3) continue;

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
    await logger.updateStatus("FAILED_FINAL", { code: "ACCOUNT_NOT_FOUND", message: `Account ${accountId} not found` });
    return;
  }

  // Acquire a free profile + account lock from pool (AFTER account validation to avoid resource leak)
  let profileId: string | null = null;
  // Track accountId for account lock release; may change on fallback
  let lockedAccountId: string | null = null;

  try {
    await logger.updateStatus("RUNNING");

    // ── Pre-check: if original account is in cooldown or unhealthy, try fallback immediately ──
    if (!job.data.ignoreCooldown) {
      const cooldownSecs = await pool.isLoginCoolingDown(accountId);
      const failureCount = await pool.getAccountTaskFailureCount(accountId);
      const accountUnhealthy = account.status !== "HEALTHY";

      if (cooldownSecs > 0 || failureCount >= 3 || accountUnhealthy) {
        await logger.log("WARN",
          `[invite] Original account ${accountId} unavailable ` +
          `(cooldown=${cooldownSecs}s, failures=${failureCount}, status=${account.status}). ` +
          `Searching for alternative account...`
        );

        const alt = await findAlternativeAccount(prisma, pool, accountId);
        if (alt) {
          await logger.log("INFO", `[invite] Switching to alternative account ${alt.accountId} (group=${alt.familyGroupId})`);
          accountId = alt.accountId;
          familyGroupId = alt.familyGroupId;
          account = await prisma.account.findUnique({ where: { id: accountId } });
          if (!account) {
            await logger.updateStatus("FAILED_FINAL", { code: "ACCOUNT_NOT_FOUND", message: `Alternative account ${accountId} not found` });
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
          await logger.log("WARN", `[invite] No alternative account available. Failing task.`);
          await logger.updateStatus("FAILED_RETRYABLE", {
            code: "NO_HEALTHY_ACCOUNT",
            message: `Original account in cooldown/unhealthy and no alternative found`,
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
        const opened = await adspower.openProfile(profileId);
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

    const beforePath = await browser.takeScreenshot(taskId, "before");
    await logger.recordScreenshot("beforeScreenshotPath", beforePath);

    // Navigate to Google Family page, execute invite
    await browser.navigateTo(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await logger.log("INFO", "Navigated to Google Family page");

    // Idempotency check: sync page state first, then check if member already exists
    await postTaskSync(page, prisma, familyGroupId, account.loginEmail ?? "", logger);

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

      const afterPath = await browser.takeScreenshot(taskId, "after");
      await logger.recordScreenshot("afterScreenshotPath", afterPath);

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

    await executeInviteOnPage(page, userEmail, logger, prisma, familyGroupId);

    const afterPath = await browser.takeScreenshot(taskId, "after");
    await logger.recordScreenshot("afterScreenshotPath", afterPath);

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
      capturedGaiaId = await scanPageForMemberGaiaId(page, userEmail);
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

    // Post-task sync: scrape the family page to reconcile DB with actual state
    await postTaskSync(page, prisma, familyGroupId, account.loginEmail ?? "", logger);

    // Guard: postTaskSync may incorrectly mark the just-invited member as REMOVED
    // when Google hides the email on the family page (shows name only).
    // Restore status so downstream batch processing and idempotency checks work.
    const postSyncMember = await prisma.familyMember.findFirst({
      where: { familyGroupId, email: userEmail },
      select: { id: true, status: true },
    });
    if (postSyncMember?.status === "REMOVED") {
      await prisma.familyMember.update({
        where: { id: postSyncMember.id },
        data: { status: "PENDING" },
      });
      await logger.log("WARN",
        `Restored ${userEmail} to PENDING — postTaskSync incorrectly marked as REMOVED (Google hid email on page)`
      );
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
            batchGaiaId = await scanPageForMemberGaiaId(page, nextUserEmail);
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
              googleMemberId: batchGaiaId ?? undefined,
            },
          }).catch((e) => batchLogger.log("WARN", `DB upsert failed: ${e instanceof Error ? e.message : String(e)}`));

          const existingInvite = await prisma.familyInvite.findFirst({
            where: { familyGroupId, email: nextUserEmail, status: "SENT" },
          });
          if (!existingInvite) {
            await prisma.familyInvite.create({ data: { familyGroupId, email: nextUserEmail, status: "SENT" } }).catch(() => {});
          }

          // Sync after each batch invite
          await postTaskSync(page, prisma, familyGroupId, account.loginEmail ?? "", batchLogger);

          // Guard: protect just-invited member from incorrect REMOVED marking
          const batchPostSyncMember = await prisma.familyMember.findFirst({
            where: { familyGroupId, email: nextUserEmail },
            select: { id: true, status: true },
          });
          if (batchPostSyncMember?.status === "REMOVED") {
            await prisma.familyMember.update({
              where: { id: batchPostSyncMember.id },
              data: { status: "PENDING" },
            });
            await batchLogger.log("WARN",
              `Restored ${nextUserEmail} to PENDING — postTaskSync incorrectly marked as REMOVED`
            );
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
    // --- Auto-reassign: intercept MANUAL_REVIEW and FAMILY_FULL for order-backed invite tasks ---
    const isManualReview = error instanceof UnrecoverableError && error.message === "MANUAL_REVIEW";
    const isFamilyFull = error instanceof UnrecoverableError && (error.message ?? "").startsWith("FAMILY_FULL");
    const shouldAutoReassign = isManualReview || isFamilyFull;

    if (shouldAutoReassign && orderId && deps.inviteQueue) {
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
          include: { account: { select: { id: true } } },
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

          // 5. Update Order to point to new group
          await prisma.order.update({
            where: { id: orderId },
            data: {
              familyGroupId: newGroup.id,
              status: "TASK_QUEUED" as any,
              resultMessage: null,
            },
          });

          // 6. Mark current task as FAILED_FINAL
          await logger.updateStatus("FAILED_FINAL", {
            code: "AUTO_REASSIGNED",
            message: `Auto-reassigned to group ${newGroup.id} (reason: ${isFamilyFull ? "FAMILY_FULL" : "MANUAL_REVIEW"})`,
          });

          // 7. Create new task and enqueue
          const newTask = await prisma.task.create({
            data: {
              type: "INVITE_MEMBER",
              orderId,
              familyGroupId: newGroup.id,
              accountId: newGroup.accountId,
              payload: JSON.stringify({
                orderId,
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
              orderId,
              familyGroupId: newGroup.id,
              accountId: newGroup.accountId,
              userEmail,
            },
            { ...JOB_DEFAULTS }
          );

          await logger.log("INFO",
            `Auto-reassigned order ${orderId} from group ${oldGroupId} to group ${newGroup.id} (new task ${newTask.id})`
          );

          // Task has been auto-handled — do NOT rethrow
          return;
        }
        // else: no healthy group available → fall through
        await logger.log("WARN",
          `Auto-reassign: no healthy group available — falling back to ${isFamilyFull ? "FAMILY_FULL" : "MANUAL_REVIEW"}`
        );
      } catch (reassignErr) {
        // Reassign process failed → log and fall through
        await logger.log("ERROR",
          `Auto-reassign failed: ${reassignErr instanceof Error ? reassignErr.message : String(reassignErr)}`
        );
      }
      // No healthy group / reassign error → rethrow original error
      throw error;
    }

    // UnrecoverableError that we don't auto-reassign (e.g. LOGIN_COOLDOWN, FAMILY_FULL with no orderId)
    if (error instanceof UnrecoverableError) throw error;

    const errMsg = error instanceof Error ? error.message : String(error);
    try {
      const errPath = await browser.takeScreenshot(taskId, "error");
      await logger.recordScreenshot("errorScreenshotPath", errPath);
    } catch { /* noop */ }

    await logger.updateStatus("FAILED_RETRYABLE", {
      code: profileId ? "INVITE_ERROR" : "PROFILE_ACQUIRE_FAILED",
      message: errMsg
    });
    await logger.log("ERROR", `Invite error (will retry): ${errMsg}`);

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

async function executeInviteOnPage(
  page: import("playwright").Page,
  email: string,
  logger: TaskLogger,
  prisma?: PrismaClient,
  familyGroupId?: string
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
          const detailEmails: string[] = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("*"))
              .filter((el) => el.children.length === 0)
              .map((el) => el.textContent?.trim() ?? "")
              .filter((t) => /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(t));
          });
          if (detailEmails.some((e) => e.toLowerCase() === email.toLowerCase())) {
            targetAlreadyOnPage = true;
            await logger.log("INFO", `Target ${email} found on detail page ${href} — already invited`);
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

  try {
    await page.waitForURL(
      (url) => !url.toString().includes("invitemembers"),
      { timeout: 15_000 }
    );
    await logger.log("INFO", "Invite page navigated away — invite confirmed");
  } catch {
    const currentUrl = page.url();
    if (currentUrl.includes("invitemembers")) {
      await logger.log("WARN", "Still on invite page after 15s — invite may not have been sent");
    }
  }
  await page.waitForTimeout(2000);
}

async function scanPageForMemberGaiaId(
  page: import("playwright").Page,
  email: string
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
  return result ?? undefined;
}
