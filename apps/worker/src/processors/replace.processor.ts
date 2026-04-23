/**
 * Replace member processor.
 *
 * Flow:
 * 1. Acquire profile lock
 * 2. Start AdsPower browser profile
 * 3. Connect via CDP
 * 4. Navigate to Google One Family management page
 * 5. Remove the target member
 * 6. Invite the new member
 * 7. Take screenshots, update statuses
 * 8. Release lock, close profile
 */

import { Job, Queue, UnrecoverableError, DelayedError } from "bullmq";
import { PrismaClient } from "@prisma/client";
import type { ReplaceMemberPayload } from "@gfa/shared";
import { JOB_DEFAULTS } from "@gfa/shared";

import { AdsPowerClient } from "../adspower-client";
import { BrowserPool } from "../browser-pool";
import { WorkerBrowser } from "../browser-context";
import { TaskLogger } from "../task-logger";
import { gmailLogin } from "../gmail-login";
import { handleLoginResult } from "../handle-login-result";
import { generateTOTP, totpSecondsRemaining, currentTotpWindow, lastUsedTotpWindow, markTotpUsed } from "../totp";
import { postTaskSync } from "../post-task-sync";
import { InviteCooldownError, countMemberCardsOnPage, checkInviteResultPage } from "./invite.processor";

const GOOGLE_FAMILY_URL = "https://myaccount.google.com/family/details?hl=en";

export interface ReplaceProcessorDeps {
  prisma: PrismaClient;
  adspower: AdsPowerClient;
  pool: BrowserPool;
  workerId: string;
  inviteQueue?: Queue;
}

export async function processReplace(
  job: Job<ReplaceMemberPayload>,
  deps: ReplaceProcessorDeps
): Promise<void> {
  const { prisma, adspower, pool, workerId } = deps;
  const { orderId, familyGroupId, accountId, targetMemberEmail, newUserEmail } =
    job.data;
  const taskId = job.data.taskId ?? job.id ?? job.name;
  if (!taskId) {
    console.error(`[worker:${workerId}] replace job has no id or name, skipping`);
    return;
  }

  const logger = new TaskLogger(prisma, taskId, workerId);
  const browser = new WorkerBrowser();

  const account = await prisma.account.findUnique({
    where: { id: accountId },
  });
  if (!account) {
    await logger.updateStatus("FAILED_FINAL", {
      code: "ACCOUNT_NOT_FOUND",
      message: `账号 ${accountId} 不存在`,
    });
    return;
  }

  let profileId: string | null = null;
  let stopHeartbeat: (() => void) | null = null;
  let removeConfirmed = false; // tracks whether remove step succeeded (for failure recovery)

  try {
    // ── Pre-check: if account is in cooldown, has too many failures, or is unhealthy → delay/fail ──
    if (!job.data.ignoreCooldown) {
      const cooldownSecs = await pool.isLoginCoolingDown(accountId);
      const priorFailures = await pool.getAccountTaskFailureCount(accountId);

      // Account truly unhealthy (too many failures or bad status) → unrecoverable, needs human
      if (priorFailures >= 5 || (account.status !== "HEALTHY" && account.status !== "LOGIN_REQUIRED")) {
        const statusDesc = account.status === "RISKY" ? "风险" : account.status === "DISABLED" ? "已禁用" : account.status;
        await logger.log("WARN",
          `[replace] 主号不可用：累计登录失败 ${priorFailures} 次，状态=${statusDesc}。替换任务必须使用家庭组自身主号，无法切换。`
        );
        await logger.updateStatus("FAILED_RETRYABLE", {
          code: "ACCOUNT_UNAVAILABLE",
          message: `主号不可用（累计失败 ${priorFailures} 次，状态: ${statusDesc}），请手动检查账号登录情况`,
        });
        throw new UnrecoverableError(`ACCOUNT_UNAVAILABLE: failures=${priorFailures}, status=${account.status}`);
      }

      // Account in transient cooldown → delay job until cooldown expires (don't waste an attempt)
      if (cooldownSecs > 0) {
        const delayMs = (cooldownSecs + 5) * 1000; // add 5s buffer
        await logger.log("INFO",
          `[replace] 主号登录冷却中（剩余 ${cooldownSecs} 秒），任务将延迟 ${Math.ceil(delayMs / 1000)} 秒后重试`
        );
        await job.moveToDelayed(Date.now() + delayMs, job.token);
        throw new DelayedError(`Delayed by ${cooldownSecs}s cooldown`);
      }

      // Account in invite cooldown (Google rate limit) → fail immediately with user-facing message
      const inviteCooldownSecs = await pool.isInviteCoolingDown(accountId);
      if (inviteCooldownSecs > 0) {
        const hoursRemaining = Math.ceil(inviteCooldownSecs / 3600);
        await logger.log("WARN",
          `[replace] Account ${accountId} in invite cooldown (${inviteCooldownSecs}s / ~${hoursRemaining}h remaining). ` +
          `Replace tasks require the group's own account — cannot switch.`
        );
        await logger.updateStatus("FAILED_FINAL", {
          code: "INVITE_COOLDOWN",
          message: `主号邀请次数过多，约${hoursRemaining}小时后可继续替换`,
        });
        if (orderId) {
          await logger.updateOrderStatus(orderId, "FAILED", `主号邀请次数过多，约${hoursRemaining}小时后可继续替换`);
        }
        throw new UnrecoverableError(`INVITE_COOLDOWN: ${inviteCooldownSecs}s remaining`);
      }
    }

    // Acquire profile + open AdsPower browser (retries other profiles on failure)
    const acquired = await pool.acquireAndOpen(workerId, accountId, adspower);
    profileId = acquired.profileId;
    stopHeartbeat = pool.startHeartbeat(profileId, accountId, workerId);
    await logger.log("INFO", `Replacing ${targetMemberEmail} → ${newUserEmail}`, {
      profileId, familyGroupId,
    });

    await logger.updateStatus("RUNNING");

    const page = await browser.connect(acquired.debugUrl);

    // Gmail auto-login
    const loginResult = await gmailLogin(page, account, logger);
    if (!loginResult.success) {
      // Record failure before handleLoginResult throws
      // handleLoginResult will also record, but we want to ensure it happens
      await handleLoginResult(loginResult, { job, pool, prisma, logger, accountId });
    }
    // Record which account is now logged into this profile
    await pool.setLastAccount(profileId!, accountId);


    await browser.navigateTo(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Look up the member's googleMemberId and displayName from DB
    const memberRecord = await prisma.familyMember.findFirst({
      where: { familyGroupId, email: targetMemberEmail },
      select: { id: true, displayName: true, googleMemberId: true, status: true }
    });
    const targetDisplayName = memberRecord?.displayName ?? undefined;
    let targetGaiaId = memberRecord?.googleMemberId ?? undefined;

    // Fuzzy GAIA lookup (方案B): If the real member record has no GAIA ID,
    // search for placeholder records (@gaia.unknown) in the same group.
    // This handles the "split identity" case where sync created a placeholder
    // instead of merging the GAIA ID into the real record.
    if (!targetGaiaId && memberRecord) {
      const placeholders = await prisma.familyMember.findMany({
        where: {
          familyGroupId,
          email: { endsWith: "@gaia.unknown" },
          status: { in: ["ACTIVE", "PENDING"] },
        },
        select: { id: true, email: true, googleMemberId: true, displayName: true },
      });

      if (placeholders.length === 1) {
        // Single placeholder — high confidence it's the same person
        targetGaiaId = placeholders[0].googleMemberId ?? undefined;
        await logger.log("INFO",
          `Fuzzy GAIA: single placeholder ${placeholders[0].email} found → using gaiaId=${targetGaiaId}`);

        // Backfill: merge GAIA ID into the real record and delete the placeholder
        if (targetGaiaId && memberRecord.id) {
          await prisma.familyMember.update({
            where: { id: memberRecord.id },
            data: { googleMemberId: targetGaiaId },
          }).catch(() => {});
          await prisma.familyMember.delete({
            where: { id: placeholders[0].id },
          }).catch(() => {});
          await logger.log("INFO",
            `Fuzzy GAIA: merged placeholder into ${targetMemberEmail}, deleted ${placeholders[0].email}`);
        }
      } else if (placeholders.length > 1 && targetDisplayName) {
        // Multiple placeholders — try displayName match
        const byName = placeholders.filter(
          (p) => p.displayName && p.displayName === targetDisplayName
        );
        if (byName.length === 1) {
          targetGaiaId = byName[0].googleMemberId ?? undefined;
          await logger.log("INFO",
            `Fuzzy GAIA: matched placeholder by displayName "${targetDisplayName}" → gaiaId=${targetGaiaId}`);

          if (targetGaiaId && memberRecord.id) {
            await prisma.familyMember.update({
              where: { id: memberRecord.id },
              data: { googleMemberId: targetGaiaId },
            }).catch(() => {});
            await prisma.familyMember.delete({
              where: { id: byName[0].id },
            }).catch(() => {});
            await logger.log("INFO",
              `Fuzzy GAIA: merged placeholder into ${targetMemberEmail}`);
          }
        } else {
          await logger.log("WARN",
            `Fuzzy GAIA: ${placeholders.length} placeholders found, ${byName.length} matched displayName — cannot disambiguate`);
        }
      } else if (placeholders.length > 1) {
        await logger.log("WARN",
          `Fuzzy GAIA: ${placeholders.length} placeholders found but no displayName to disambiguate`);
      }
    }

    await logger.log("INFO",
      `Target member: email=${targetMemberEmail}, displayName=${targetDisplayName ?? 'unknown'}, gaiaId=${targetGaiaId ?? 'unknown'}`
    );

    // Fix #5: On retry, check if old member was already removed in a previous attempt.
    // Two checks:
    //   1. DB status = REMOVED → definitely skip
    //   2. DB status != REMOVED but member not findable on page → also skip (crash-retry scenario)
    // For check #2, we count member cards on the page (excluding manager).
    // We do NOT use body.textContent for presence detection (it's unreliable for PENDING→ACTIVE transitions).
    let skipRemove = false;
    let skipInvite = false;
    if (memberRecord?.status === "REMOVED") {
      await logger.log("INFO", `Target member ${targetMemberEmail} already REMOVED in DB — skipping Step 1 (remove)`);
      skipRemove = true;
    }

    let discoveredGaiaId: string | undefined;
    let preRemoveCardCount: number | undefined;
    if (!skipRemove) {
      // Query other members' GAIA IDs for cross-validation safety check
      // This prevents S3 from accidentally removing a card that belongs to another known member
      const otherMembers = await prisma.familyMember.findMany({
        where: {
          familyGroupId,
          email: { not: targetMemberEmail },
          googleMemberId: { not: null },
          status: { not: "REMOVED" },
        },
        select: { googleMemberId: true },
      });
      const otherGaiaIds = new Set(otherMembers.map((m) => m.googleMemberId!).filter(Boolean));
      await logger.log("INFO", `Cross-validation set: ${otherGaiaIds.size} other member GAIA IDs loaded`);

      // Capture card count BEFORE removal for replace-flow verification.
      // After replace (remove + invite), the count should stay the same (N - 1 + 1 = N).
      // This avoids the Google page-lag problem: we don't need to wait for the removal
      // to reflect on the page before counting.
      preRemoveCardCount = await countMemberCardsOnPage(page);
      await logger.log("INFO", `Pre-remove card count: ${preRemoveCardCount}`);

      // Step 1: Remove the target member on page
      // Wrap in try-catch: if this is a retry and the member was already removed by a previous
      // attempt (but DB wasn't updated), S0-S3 will all fail with "Cannot find member".
      // In that case, treat as "already removed" and proceed to invite.
      try {
        discoveredGaiaId = await removeMemberOnPage(page, targetMemberEmail, logger, {
          loginEmail: account.loginEmail,
          password: account.loginPassword ?? undefined,
          totpSecret: account.totpSecret ?? undefined,
          displayName: targetDisplayName,
          googleMemberId: targetGaiaId,
        }, otherGaiaIds);
      } catch (removeErr) {
        const msg = removeErr instanceof Error ? removeErr.message : String(removeErr);
        if (msg.includes("Cannot find member")) {
          const isFirstAttempt = (job.attemptsMade ?? 0) === 0;
          await logger.log("WARN",
            `Member ${targetMemberEmail} not found on page (attempt=${job.attemptsMade ?? 0}). Verifying if slot is available...`
          );
          
          await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
          await page.waitForTimeout(2000);

          // Check if newUserEmail is already on the page (previous attempt or manual action completed the full replace)
          const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
          const newEmailOnPage = bodyText.toLowerCase().includes(newUserEmail.toLowerCase());
          const newMemberInDb = newEmailOnPage ? { email: newUserEmail } : await prisma.familyMember.findFirst({
            where: {
              familyGroupId,
              email: newUserEmail,
              status: { in: ["ACTIVE", "PENDING"] },
            },
          });

          if (newMemberInDb) {
            // Idempotency: new member already present → previous attempt or manual action completed the replace.
            // Safe to skip both remove and invite regardless of attempt number.
            await logger.log("INFO",
              `Idempotency check: ${newUserEmail} already found on family page! ` +
              `Previous attempt likely completed. Skipping remove+invite, proceeding to DB update.`
            );
            skipRemove = true;
            skipInvite = true;
          } else {
            // New member is NOT on the page yet.
            const inviteLinkCount = await page.locator('a[href*="invitemembers"]').count();

            if (inviteLinkCount > 0 && isFirstAttempt) {
              // CRITICAL SAFETY CHECK: First attempt + member not found + slot available.
              // This means the target member was removed externally (admin, user left, or different task)
              // but NOT by this task. Proceeding to invite would waste a seat because the removal
              // was not part of this replace operation.
              const userMessage = `原号 ${targetMemberEmail} 不在家庭组中，无法执行替换。请检查家庭组成员后重试。`;
              await logger.log("ERROR",
                `SAFETY BLOCK: First attempt but target member ${targetMemberEmail} not found, ` +
                `yet invite slot exists. The member was likely removed externally (admin/manual/other task). ` +
                `Refusing to invite ${newUserEmail} to prevent seat waste.`
              );
              await logger.updateStatus("FAILED_FINAL", {
                code: "MEMBER_NOT_IN_GROUP",
                message: userMessage,
              });
              if (orderId) {
                await logger.updateOrderStatus(orderId, "FAILED", userMessage);
                await prisma.swapRecord.updateMany({
                  where: { orderId, taskId, status: "PENDING" },
                  data: { status: "FAILED" },
                }).catch(() => {});
              }
              throw new UnrecoverableError(userMessage);
            } else if (inviteLinkCount > 0 && !isFirstAttempt) {
              // Retry attempt + member not found + slot available.
              // This is the legitimate retry scenario: previous attempt removed the member
              // but crashed before inviting. Safe to proceed.
              await logger.log("INFO",
                `Retry scenario: member not found but invite slot available (attempt=${job.attemptsMade}). ` +
                `Previous attempt likely removed the member. Proceeding to invite.`
              );
            } else {
              // No invite slots AND old member not found.
              // Possible scenarios:
              //   A) Previous attempt already completed the full replace (removed old + invited new)
              //      but crashed before updating DB. → newUserEmail should be on the page (handled above).
              //   B) Identification genuinely failed — member IS on page but S0-S4 all missed it.
              //
              // Scenario B: genuinely can't find the member. Reload and retry once.
              await logger.log("WARN",
                `No invite slots, newUserEmail not on page → member must be present but identification failed. Reloading and retrying...`
              );
              await page.goto("about:blank", { waitUntil: "domcontentloaded" }).catch(() => {});
              await page.waitForTimeout(2000);
              await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
              await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
              await page.waitForTimeout(5000);

              try {
                discoveredGaiaId = await removeMemberOnPage(page, targetMemberEmail, logger, {
                  loginEmail: account.loginEmail,
                  password: account.loginPassword ?? undefined,
                  totpSecret: account.totpSecret ?? undefined,
                  displayName: targetDisplayName,
                  googleMemberId: targetGaiaId,
                }, otherGaiaIds);
                await logger.log("INFO", `Retry succeeded — member found and removed on second attempt`);
              } catch (retryErr) {
                const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                await logger.log("ERROR",
                  `Retry also failed: ${retryMsg}. Group is full but cannot identify target member.`
                );
                throw new Error(
                  `Cannot find member on page despite group being full (识别失败，组满但无法定位目标成员). ` +
                  `Target: ${targetMemberEmail}, gaiaId: ${targetGaiaId ?? 'unknown'}`
                );
              }
            }
          }
        } else {
          throw removeErr; // re-throw non-matching errors
        }
      }

      // Back-fill gaiaId into DB if we discovered it via fallback during this remove step
      if (discoveredGaiaId && !targetGaiaId && memberRecord) {
        await prisma.familyMember.update({
          where: { id: memberRecord.id },
          data: { googleMemberId: discoveredGaiaId },
        }).catch(() => {}); // non-fatal
        await logger.log("INFO", `Back-filled gaiaId=${discoveredGaiaId} for ${targetMemberEmail}`);
      }
    }

    await logger.log("INFO", `Remove step complete. Current URL: ${page.url()}`);
    removeConfirmed = true; // removal verified — safe to update DB on failure

    // Step 2: Navigate back to family details before inviting.
    await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);
    await logger.log("INFO", `Back on family details, now inviting ${newUserEmail}`);

    // Step 3: Invite the new member on page (skip if previous attempt already invited)
    let newMemberGaiaId: string | undefined;
    if (!skipInvite) {
      // Use preRemoveCardCount for invite verification.
      // In a replace flow: remove(-1) + invite(+1) = net 0 change.
      // So if postInviteCount >= preRemoveCount, the invite succeeded.
      // This avoids the Google page-lag false positive where preInviteCount
      // after removal was still showing the old count (e.g. 6→6 = false cooldown).
      const preInviteCardCount = skipRemove
        ? await countMemberCardsOnPage(page)  // no removal happened, count normally
        : Math.max(0, preRemoveCardCount! - 1);  // removal happened: expect N-1
      await logger.log("INFO",
        `Pre-invite card count for replace: ${preInviteCardCount} ` +
        `(preRemove=${preRemoveCardCount ?? 'N/A'}, skipRemove=${skipRemove})`
      );

      await inviteMemberOnPage(page, newUserEmail, logger, preInviteCardCount);

      // --- Verify invite by checking new member appears on family page ---
      try {
        if (!page.url().includes("family/details")) {
          await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
        }
        await page.waitForTimeout(2000);
        newMemberGaiaId = await scanPageForMemberGaiaId(page, newUserEmail, prisma, familyGroupId);
        if (newMemberGaiaId) {
          await logger.log("INFO", `Verified invite: found ${newUserEmail} on family page (gaiaId=${newMemberGaiaId})`);
        } else {
          await logger.log("WARN", `Could not capture gaiaId for ${newUserEmail} — will be filled on next sync`);
        }
      } catch (err: any) {
        await logger.log("WARN", `gaiaId capture error for new member (non-fatal): ${err.message}`);
      }
    } else {
      await logger.log("INFO", `[replace] Skipping invite step — previous attempt already completed`);
      // Try to get the new member's GAIA ID from the current page for DB update
      try {
        await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(2000);
        newMemberGaiaId = await scanPageForMemberGaiaId(page, newUserEmail, prisma, familyGroupId);
      } catch { /* non-fatal */ }
    }

    // Both page operations succeeded — now update DB atomically
    let usedCaseInsensitive = false;
    await prisma.$transaction(async (tx) => {
      // Mark old member as REMOVED (case-insensitive match for safety)
      const updated = await tx.familyMember.updateMany({
        where: { familyGroupId, email: targetMemberEmail },
        data: { status: "REMOVED", removedAt: new Date() },
      });

      // If exact-case didn't match, try case-insensitive via raw query
      if (updated.count === 0) {
        await tx.$executeRawUnsafe(
          `UPDATE FamilyMember SET status = 'REMOVED', removedAt = datetime('now'), updatedAt = datetime('now') WHERE familyGroupId = ? AND LOWER(email) = LOWER(?)`,
          familyGroupId,
          targetMemberEmail
        );
        usedCaseInsensitive = true;
      }

      // Inherit expiry from old member (or from job payload if provided).
      // Keep the original expiresAt as-is — even if already past.
      // ExpireScanService runs hourly and will handle expired members automatically.
      // Do NOT grant a free 30-day extension to prevent abuse via swap-after-expiry.
      const oldMember = await tx.familyMember.findFirst({
        where: { familyGroupId, email: targetMemberEmail },
        select: { expiresAt: true },
      });
      const inheritedExpiresAt = job.data.inheritedExpiresAt
        ? new Date(job.data.inheritedExpiresAt)
        : oldMember?.expiresAt ?? null;

      // Upsert placeholder for newly invited member (sync may have already created a PENDING record)
      await tx.familyMember.upsert({
        where: { familyGroupId_email: { familyGroupId, email: newUserEmail } },
        update: {
          status: "PENDING",
          displayName: newUserEmail.split("@")[0],
          expiresAt: inheritedExpiresAt,
          ...(newMemberGaiaId ? { googleMemberId: newMemberGaiaId } : {}),
        },
        create: {
          familyGroupId,
          email: newUserEmail,
          displayName: newUserEmail.split("@")[0],
          role: "member",
          status: "PENDING",
          expiresAt: inheritedExpiresAt,
          googleMemberId: newMemberGaiaId ?? undefined,
        },
      });

      // Record invite (idempotent: skip if a SENT invite already exists for this email)
      const existingInvite = await tx.familyInvite.findFirst({
        where: { familyGroupId, email: newUserEmail, status: "SENT" },
      });
      if (!existingInvite) {
        await tx.familyInvite.create({
          data: { familyGroupId, email: newUserEmail, status: "SENT" },
        });
      }

      // Update FamilyGroup counters
      await tx.familyGroup.updateMany({
        where: { id: familyGroupId, memberCount: { gt: 0 } },
        data: { memberCount: { decrement: 1 } },
      });
      await tx.familyGroup.update({
        where: { id: familyGroupId },
        data: {
          pendingInviteCount: { increment: 1 },
          yearlyChangeCount: { increment: 1 },
        },
      });
    }, { timeout: 30000, maxWait: 10000 });

    // Log outside transaction to avoid SQLite write-lock contention
    if (usedCaseInsensitive) {
      await logger.log("INFO", `Used case-insensitive update for ${targetMemberEmail}`);
    }


    await logger.updateStatus("REPLACED_AND_INVITE_SENT");

    if (orderId) {
      await logger.updateOrderStatus(
        orderId,
        "INVITE_SENT",
        `Replaced ${targetMemberEmail} with ${newUserEmail}`
      );

      // Mark SwapRecord as COMPLETED (if any exists for this order+task)
      await prisma.swapRecord.updateMany({
        where: { orderId, taskId, status: "PENDING" },
        data: { status: "COMPLETED" },
      }).catch((err: any) => {
        logger.log("WARN", `Failed to update SwapRecord: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    // Post-task sync: full scrape to reconcile DB with actual page state.
    // skipPlaceholders=true prevents creating @gaia.unknown records for the
    // just-invited member (whose email may not be visible on the page yet).
    await postTaskSync(page, prisma, familyGroupId, account.loginEmail ?? "", logger, {
      justInvitedEmail: newUserEmail,
      skipPlaceholders: true,
    });

    await logger.log("INFO", "Replace completed successfully");
  } catch (error) {
    // Don't overwrite MANUAL_REVIEW status if login challenge was detected
    if (error instanceof UnrecoverableError) throw error;
    // DelayedError = job was rescheduled via moveToDelayed, not a real failure
    if (error instanceof DelayedError) throw error;

    // ── INVITE_COOLDOWN: Google rate-limited this account's invite capability ──
    // For REPLACE tasks, we cannot auto-reassign (must use same group's account).
    // Notify user that the account needs 24h cooldown.
    if (error instanceof InviteCooldownError) {
      await pool.recordInviteCooldown(accountId);
      // Mark family groups as MANUAL_ONLY so API won't assign new tasks to this account
      await prisma.familyGroup.updateMany({
        where: { accountId, status: "ACTIVE" },
        data: { status: "MANUAL_ONLY" },
      }).catch(() => {});
      await prisma.account.update({
        where: { id: accountId },
        data: { syncError: "INVITE_COOLDOWN" },
      }).catch(() => {});
      await logger.log("ERROR",
        `账号 ${accountId} 在替换过程中触发 Google 邀请频率限制 — 已设置 24 小时冷却，家庭组已标记为 MANUAL_ONLY`
      );

      await logger.updateStatus("FAILED_FINAL", {
        code: "INVITE_COOLDOWN",
        message: `主号邀请次数过多，24小时后可继续替换`,
      });

      if (orderId) {
        await logger.updateOrderStatus(orderId, "FAILED", `主号邀请次数过多，24小时后可继续替换`);

        // Mark SwapRecord as FAILED
        await prisma.swapRecord.updateMany({
          where: { orderId, taskId, status: "PENDING" },
          data: { status: "FAILED" },
        }).catch((err: any) => {
          logger.log("WARN", `Failed to update SwapRecord: ${err instanceof Error ? err.message : String(err)}`);
        });

        // Roll back ACCOUNT_SWAP code so user can retry after cooldown
        try {
          const order = await prisma.order.findUnique({
            where: { id: orderId },
            select: { redeemCodeId: true },
          });
          if (order?.redeemCodeId) {
            await prisma.redeemCode.updateMany({
              where: { id: order.redeemCodeId, codeType: "ACCOUNT_SWAP", status: "USED" },
              data: { status: "UNUSED", usedAt: null },
            });
          }
        } catch { /* non-fatal */ }
      }

      // If old member was already removed, sync DB so the slot is reclaimed.
      // Without this, DB still shows old member as ACTIVE but Google already removed them.
      if (removeConfirmed) {
        try {
          await logger.log("INFO", `旧成员已移除但邀请触发冷却 — 同步数据库标记 ${targetMemberEmail} 为 REMOVED`);
          await prisma.familyMember.updateMany({
            where: { familyGroupId, email: targetMemberEmail, status: { not: "REMOVED" } },
            data: { status: "REMOVED", removedAt: new Date() },
          });
          await prisma.familyGroup.update({
            where: { id: familyGroupId },
            data: {
              availableSlots: { increment: 1 },
              memberCount: { decrement: 1 },
            },
          }).catch(() => {});
          await logger.log("INFO", `数据库已同步：${targetMemberEmail} 标记为 REMOVED，位置已回收`);
        } catch (syncErr: any) {
          await logger.log("WARN", `同步数据库失败: ${syncErr.message}`);
        }
      }

      // Auto-reassign the new member to a different healthy family group
      if (deps.inviteQueue) {
        try {
          const newGroup = await prisma.familyGroup.findFirst({
            where: {
              status: "ACTIVE",
              availableSlots: { gt: 0 },
              account: { status: "HEALTHY" },
              id: { not: familyGroupId }, // exclude current (cooldown) group
            },
            include: { account: { select: { id: true, loginEmail: true } } },
            orderBy: { createdAt: "asc" },
          });

          if (newGroup) {
            // Check this account is not also in invite cooldown
            const altCooldown = await pool.isInviteCoolingDown(newGroup.accountId);
            if (altCooldown > 0) {
              await logger.log("WARN", `替代家庭组 ${newGroup.id} 的主号也在邀请冷却中（${altCooldown}秒），无法重新分配`);
            } else {
              // Reserve slot in new group
              await prisma.familyGroup.update({
                where: { id: newGroup.id },
                data: {
                  availableSlots: { decrement: 1 },
                  pendingInviteCount: { increment: 1 },
                },
              });

              // Update Order to point to new group
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

              // Create new INVITE_MEMBER task for the new member — include transfer note
              const oldAcctInfo = await prisma.account.findUnique({
                where: { id: accountId },
                select: { loginEmail: true },
              });
              const transferNote = `原母号 ${oldAcctInfo?.loginEmail ?? accountId} 邀请受限，已转移至母号 ${newGroup.account.loginEmail}`;
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
                    userEmail: newUserEmail,
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
                  userEmail: newUserEmail,
                },
                { ...JOB_DEFAULTS }
              );

              // Update current task status to reflect reassignment
              await logger.updateStatus("FAILED_FINAL", {
                code: "INVITE_COOLDOWN_REASSIGNED",
                message: `主号邀请冷却，新成员 ${newUserEmail} 已自动分配到家庭组 ${newGroup.id}`,
              });
              if (orderId) {
                await logger.updateOrderStatus(orderId, "TASK_QUEUED", `主号邀请冷却，已自动切换到其他家庭组`);
              }

              await logger.log("INFO",
                `新成员 ${newUserEmail} 已自动分配到家庭组 ${newGroup.id}（账号 ${newGroup.accountId}），新任务 ${newTask.id}`
              );
              return;
            }
          } else {
            await logger.log("WARN", `没有可用的替代家庭组，无法重新分配新成员`);
          }
        } catch (reassignErr) {
          await logger.log("ERROR",
            `自动重新分配失败: ${reassignErr instanceof Error ? reassignErr.message : String(reassignErr)}`
          );
        }
      }

      return;
    }

    const errMsg = error instanceof Error ? error.message : String(error);

    try {
    } catch {
      // noop
    }

    // "Cannot find member" — member is not on the page, retrying is pointless
    const isMemberNotFound = errMsg.includes("Cannot find member");

    // After max retries (attemptsMade is 0-indexed, attempts=3 means 0,1,2),
    // stop retrying for any error
    const isLastAttempt = (job.attemptsMade ?? 0) >= 2;

    if (isMemberNotFound || isLastAttempt) {
      await logger.updateStatus("FAILED_FINAL", {
        code: isMemberNotFound ? "MEMBER_NOT_FOUND" : "MAX_RETRIES_EXCEEDED",
        message: errMsg,
      });

      if (orderId) {
        await logger.updateOrderStatus(orderId, "FAILED", errMsg);

        // Mark SwapRecord as FAILED
        await prisma.swapRecord.updateMany({
          where: { orderId, taskId, status: "PENDING" },
          data: { status: "FAILED" },
        }).catch((rollbackErr: any) => {
          logger.log("WARN", `Failed to update SwapRecord: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`);
        });

        // Roll back ACCOUNT_SWAP redeem code from USED → UNUSED so user can retry.
        // SUBSCRIPTION codes don't need rollback — they support reuse via subscriptionReuse().
        try {
          const order = await prisma.order.findUnique({
            where: { id: orderId },
            select: { redeemCodeId: true },
          });
          if (order?.redeemCodeId) {
            const rolledBack = await prisma.redeemCode.updateMany({
              where: {
                id: order.redeemCodeId,
                codeType: "ACCOUNT_SWAP",
                status: "USED",
              },
              data: { status: "UNUSED", usedAt: null },
            });
            if (rolledBack.count > 0) {
              await logger.log("INFO", `Rolled back ACCOUNT_SWAP code to UNUSED for retry`);
            }
          }
        } catch (codeErr: any) {
          await logger.log("WARN", `Failed to roll back redeem code: ${codeErr.message}`);
        }
      }

      await logger.log("ERROR", `替换最终失败: ${errMsg}`);
      throw new UnrecoverableError(errMsg);
    }

    await logger.updateStatus("FAILED_RETRYABLE", {
      code: profileId ? "REPLACE_ERROR" : "PROFILE_ACQUIRE_FAILED",
      message: errMsg,
    });

    // Don't mark order FAILED here — BullMQ will retry
    await logger.log("ERROR", `替换失败（将重试）: ${errMsg}`);

    // If removal was confirmed but invite failed, sync DB so the old member
    // is marked REMOVED and the slot is reclaimed. Without this, DB keeps
    // the old member as ACTIVE indefinitely while Google already removed them.
    if (removeConfirmed) {
      try {
        await logger.log("INFO", `Remove was confirmed but invite failed — syncing DB to mark ${targetMemberEmail} as REMOVED`);
        await prisma.familyMember.updateMany({
          where: { familyGroupId, email: targetMemberEmail, status: { not: "REMOVED" } },
          data: { status: "REMOVED", removedAt: new Date() },
        });
        // Reclaim slot: removal freed 1 slot, but invite didn't consume it
        await prisma.familyGroup.update({
          where: { id: familyGroupId },
          data: {
            availableSlots: { increment: 1 },
            memberCount: { decrement: 1 },
          },
        }).catch(() => {});
        await logger.log("INFO", `DB synced: ${targetMemberEmail} marked REMOVED, slot reclaimed`);
      } catch (syncErr: any) {
        await logger.log("WARN", `Failed to sync DB after partial replace: ${syncErr.message}`);
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
    await pool.releaseAccount(accountId, workerId).catch(() => {});
  }
}

/**
 * Remove a family member on the Google Family page.
 *
 * Matching strategies (tried in order):
 *   S0: Direct GAIA URL navigation (fastest, uses googleMemberId from DB)
 *   S1: Find email text directly on list page (pending invites without Google account)
 *   S2: Find member by displayName (accepted members show display name, not email)
 *   S3: Blind iteration — click each card, check body text (last resort)
 */
/**
 * Returns the GAIA ID discovered from the member detail page URL
 * (may be undefined if S0 was used with a pre-known gaiaId).
 */
async function removeMemberOnPage(
  page: import("playwright").Page,
  email: string,
  logger: TaskLogger,
  credentials?: { loginEmail?: string; password?: string; totpSecret?: string; displayName?: string; googleMemberId?: string },
  otherMemberGaiaIds?: Set<string>
): Promise<string | undefined> {
  let discoveredGaiaId: string | undefined;
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 });

  const displayName = credentials?.displayName;
  const googleMemberId = credentials?.googleMemberId;

  if (googleMemberId) {
    // Strategy 0: Direct navigation using GAIA ID — bypasses all text matching issues
    // Google uses /g/<id> for accepted members and /i/<id> for pending invites.
    // We cannot determine path from ID sign alone (pending IDs can be positive or negative).
    // Try /g/ first (most common), then /i/ if no action button found.
    const pathsToTry = ["g", "i"] as const;
    let hasAction = 0;

    for (const pathSegment of pathsToTry) {
      const directUrl = `https://myaccount.google.com/family/member/${pathSegment}/${googleMemberId}?hl=en`;
      await logger.log("INFO", `S0: Trying /${pathSegment}/${googleMemberId}`);
      await page.goto(directUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 60000 });

      hasAction = await page.locator(
        'button:has-text("移除"), button:has-text("取消邀請"), button:has-text("取消"), button:has-text("Cancel"), button:has-text("Remove"), ' +
        'button:has-text("구성원 삭제"), button:has-text("초대 취소"), ' +
        'button:has-text("メンバーを削除"), button:has-text("削除"), ' +
        'button:has-text("Xóa thành viên"), button:has-text("Xóa")'
      ).count();

      if (hasAction > 0) {
        await logger.log("INFO", `S0: Found action button on /${pathSegment}/ path`);
        break;
      }
      await logger.log("INFO", `S0: No action button on /${pathSegment}/ path, trying next`);
    }

    if (hasAction > 0) {
      // Identity verification: confirm this page actually belongs to the target member.
      // IMPORTANT: Use leaf-node extraction, NOT body.textContent — body contains ALL members' emails.
      const leafEmails = await page.evaluate(() => {
        const leafEls = Array.from(document.querySelectorAll("*"))
          .filter((el) => el.children.length === 0);
        return leafEls
          .map((el) => el.textContent?.trim() ?? "")
          .filter((t) => /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(t));
      });
      await logger.log("INFO", `S0: Leaf emails on detail page: [${leafEmails.join(", ")}]`);
      const emailMatch = leafEmails.some((e) => e.toLowerCase() === email.toLowerCase());
      const nameMatch = false; // displayName is unreliable for verification

      if (emailMatch) {
        await logger.log("INFO", `S0 verified: leaf email matches ${email}`);
        // Identity confirmed — proceed to remove button logic below
      } else {
        await logger.log("WARN",
          `S0 identity mismatch: gaiaId=${googleMemberId} page does not contain email="${email}" or displayName="${displayName ?? 'N/A'}". Falling back to list page matching.`
        );
        // Clear SPA state: navigate to blank page first to prevent stale DOM content
        // from leaking into subsequent S3 page visits
        await page.goto("about:blank", { waitUntil: "domcontentloaded" }).catch(() => {});
        await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
        discoveredGaiaId = await fallbackFindMember(page, email, displayName, logger, googleMemberId, otherMemberGaiaIds);
      }
    } else {
      await logger.log("WARN", `S0: Landed on page but no action button found, falling back to list page matching`);
      // Clear SPA state before fallback
      await page.goto("about:blank", { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      discoveredGaiaId = await fallbackFindMember(page, email, displayName, logger, googleMemberId, otherMemberGaiaIds);
    }
  } else {
    // No GAIA ID — fall back to text-based matching
    await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    discoveredGaiaId = await fallbackFindMember(page, email, displayName, logger, undefined, otherMemberGaiaIds);
  }

  await logger.log("INFO", `On detail page for member ${email}`);

  // Safety net: detect if we accidentally landed on the family manager's page.
  // The manager page shows "Delete Family Group" instead of "Remove member".
  // This means the stored googleMemberId is WRONG — it belongs to the manager, not the target member.
  const deleteGroupBtn = page.locator(
    'button:has-text("Delete Family Group"), button:has-text("删除家庭群组"), button:has-text("刪除家庭群組"), ' +
    'button:has-text("가족 그룹 삭제"), button:has-text("ファミリーグループを削除"), button:has-text("Xóa nhóm gia đình")'
  );
  if ((await deleteGroupBtn.count()) > 0) {
    await logger.log("WARN",
      `Landed on manager page (Delete Family Group detected). ` +
      `Member ${email} has a WRONG googleMemberId=${googleMemberId ?? "?"} that points to the manager account. ` +
      `Clearing bad GAIA ID and retrying with list-page matching only.`
    );
    // Go back to list page and retry WITHOUT the bad GAIA ID
    await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    // Pass undefined for googleMemberId so S3-fast won't re-match the bad ID
    discoveredGaiaId = await fallbackFindMember(page, email, displayName, logger, undefined, otherMemberGaiaIds);
    if (!discoveredGaiaId) {
      await logger.log("WARN", `Member ${email} not found after clearing bad GAIA ID — may be already removed`);
      return "ALREADY_REMOVED";
    }
    await logger.log("INFO", `After manager-page fallback, now on: ${page.url()}`);
  }

  // Save the member detail URL for potential re-navigation after password auth
  const memberDetailUrl = page.url();

  // Look for remove/cancel-invite button on the member detail page.
  // Use precise selectors first, fall back to broader ones only if needed.
  // Covers both joined members (Remove) and pending invites (Cancel/Revoke).
  const preciseButton = page.locator([
    'button:has-text("移除")',
    'button:has-text("取消邀請")',
    'button:has-text("取消邀请")',
    'button:has-text("撤銷")',
    'button:has-text("撤销")',
    'button:has-text("Remove member")',
    'button:has-text("Cancel invitation")',
    'button:has-text("Revoke")',
    'button:has-text("Remove")',
    // Korean
    'button:has-text("구성원 삭제")',
    'button:has-text("초대 취소")',
    'button:has-text("취소")',
    // Japanese
    'button:has-text("メンバーを削除")',
    'button:has-text("削除")',
    'button:has-text("招待をキャンセル")',
    'button:has-text("キャンセル")',
    // Vietnamese
    'button:has-text("Xóa thành viên")',
    'button:has-text("Xóa")',
    'button:has-text("Hủy lời mời")',
    'button:has-text("Thu hồi")',
  ].join(", "));

  // Broad fallback: Google may show just "取消"/"Cancel" for pending invites.
  // Place AFTER precise selectors to avoid clicking unrelated cancel buttons
  // (e.g., form cancel, navigation cancel) on joined-member detail pages.
  const broadButton = page.locator([
    'button:has-text("取消")',
    'button:has-text("Cancel")',
  ].join(", "));

  // Wait for Angular to render the action button (lazy-loaded component).
  // Try precise buttons first; fall back to broad buttons; hard-fail after 15s total.
  try {
    await preciseButton.first().waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    try {
      await broadButton.first().waitFor({ state: "visible", timeout: 3_000 });
    } catch {
      // Button still not found — fall through to dump+throw below
    }
  }

  let removeButton = (await preciseButton.count()) > 0 ? preciseButton : broadButton;

  if ((await removeButton.count()) === 0) {
    // Dump all visible buttons for debugging
    const allButtons = await page.evaluate(() =>
      Array.from(document.querySelectorAll("button")).map((b) => ({
        text: b.textContent?.trim(),
        cls: b.className,
        visible: b.offsetParent !== null,
      }))
    );
    await logger.log("WARN", `No remove button found. All buttons on page: ${JSON.stringify(allButtons)}`);
    throw new Error(`Cannot find remove/cancel button for member ${email}`);
  }

  await removeButton.first().click();
  await logger.log("INFO", `Clicked remove/cancel for ${email}`);

  // --- Handle potential redirect or confirmation dialog ---
  // Google's redirect to re-auth (or popping up a dialog) can take >3s and cause race conditions.
  // We poll for up to 15s to definitively detect the state change.
  let needsReAuth = false;
  let confirmDetected = false;
  
  for (let poll = 0; poll < 30; poll++) {
    await page.waitForTimeout(500);
    const u = page.url();
    if (u.includes("accounts.google.com") || u.includes("signin") || u.includes("challenge") || u.includes("ServiceLogin")) {
      needsReAuth = true;
      break;
    }
    
    if (u.includes("family/remove/")) {
      confirmDetected = true;
      break;
    }

    // Check if dialog appeared
    const confirmButton = page.locator([
      'a:has-text("是")', 'button:has-text("是")',
      'a:has-text("Yes")', 'button:has-text("Yes")',
      'a:has-text("確認")', 'button:has-text("確認")',
      'a:has-text("确认")', 'button:has-text("确认")',
      'a:has-text("Confirm")', 'button:has-text("Confirm")',
      'button:has-text("예")', 'a:has-text("예")',
      'button:has-text("확인")', 'a:has-text("확인")',
      'button:has-text("はい")', 'a:has-text("はい")',
      'button:has-text("Có")', 'a:has-text("Có")',
      'button:has-text("Xác nhận")', 'a:has-text("Xác nhận")',
    ].join(", "));

    if ((await confirmButton.count()) > 0 && await confirmButton.first().isVisible().catch(()=>false)) {
      confirmDetected = true;
      break;
    }
  }

  await page.waitForLoadState("domcontentloaded", { timeout: 60000 });
  const postClickUrl = page.url();

  if (needsReAuth) {
    await logger.log("INFO", `Re-auth required. URL: ${postClickUrl}`);

    // Step 1: Handle identifier page (email pre-filled, click Next)
    const identifierInput = page.locator('input[type="email"]');
    if ((await identifierInput.count()) > 0) {
      await logger.log("INFO", "On identifier page, pressing Enter");
      await identifierInput.first().press("Enter");
      await page.waitForTimeout(3000);
      await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
    }

    // Step 2: Detect if we're already on TOTP page (Google skipped password)
    const currentReAuthUrl = page.url();
    const isDirectTotp = currentReAuthUrl.includes("challenge/totp") || currentReAuthUrl.includes("challenge/az");

    if (!isDirectTotp) {
      // Need password first
      if (!credentials?.password) {
        throw new Error(
          `Google requires password to remove joined member ${email}, ` +
          `but Account.loginPassword is not set`
        );
      }

      const passwordInput = page.locator('input[type="password"]');
      try {
        await passwordInput.first().waitFor({ state: "visible", timeout: 15_000 });
      } catch {
        const anyPwd = page.locator('input[name="Passwd"], input[name="password"]');
        if ((await anyPwd.count()) === 0) {
          // Maybe Google jumped to TOTP during our wait — re-check URL
          const nowUrl = page.url();
          if (!nowUrl.includes("challenge")) {
            await logger.log("WARN", `No password input found. URL: ${nowUrl}`);
            throw new Error(`Password page not found during remove re-auth. URL: ${nowUrl}`);
          }
          // URL changed to challenge — fall through to TOTP handling below
          await logger.log("INFO", "URL changed to challenge during password wait, proceeding to TOTP");
        }
      }

      // Fill password if input is visible
      const pwdField = page.locator('input[type="password"]:visible, input[name="Passwd"]:visible');
      if ((await pwdField.count()) > 0) {
        await pwdField.first().fill(credentials!.password!);
        await pwdField.first().press("Enter");
        await logger.log("INFO", "Password submitted for re-auth");

        await page.waitForTimeout(5000);
        await page.waitForLoadState("domcontentloaded", { timeout: 60000 });
      } else {
        // Password input exists but is hidden (aria-hidden="true") — Google's lazy render.
        // Wait for it to become visible, then retry.
        await logger.log("WARN", "Password field hidden, waiting for it to become visible...");
        const hiddenPwd = page.locator('input[type="password"]');
        try {
          await hiddenPwd.first().waitFor({ state: "visible", timeout: 10_000 });
          await hiddenPwd.first().fill(credentials!.password!);
          await hiddenPwd.first().press("Enter");
          await logger.log("INFO", "Password submitted (after wait for visibility)");
          await page.waitForTimeout(5000);
          await page.waitForLoadState("domcontentloaded", { timeout: 60000 });
        } catch {
          await logger.log("WARN", "Password field never became visible — re-auth may fail");
        }
      }
    } else {
      await logger.log("INFO", "Google skipped password, directly on TOTP challenge");
    }

    // Step 3: Handle TOTP 2FA challenge (after password OR direct)
    // IMPORTANT: Only enter TOTP handling for actual TOTP/2FA challenge pages,
    // NOT for /challenge/pwd (password page) which means password wasn't accepted yet.
    const afterAuthUrl = page.url();
    const isTotpChallenge = afterAuthUrl.includes("challenge/totp") ||
      afterAuthUrl.includes("challenge/az") ||
      afterAuthUrl.includes("challenge/sk") ||  // security key
      afterAuthUrl.includes("signin/v2") ||
      // Generic /challenge/ but NOT /challenge/pwd
      (afterAuthUrl.includes("challenge") && !afterAuthUrl.includes("challenge/pwd"));
    if (isTotpChallenge) {
      await logger.log("INFO", `TOTP challenge page. URL: ${afterAuthUrl}`);

      if (!credentials?.totpSecret) {
        throw new Error(
          `Google requires 2FA to remove joined member ${email}, ` +
          `but Account.totpSecret is not set`
        );
      }

      // Ensure we use a different TOTP code than the one submitted during login.
      // Google rejects same-code reuse within a session, even if still valid.
      const curWindow = currentTotpWindow();
      if (curWindow <= lastUsedTotpWindow()) {
        const remaining = totpSecondsRemaining();
        await logger.log("INFO", `Waiting ${remaining + 1}s to avoid TOTP code reuse (same window as login)`);
        await page.waitForTimeout((remaining + 1) * 1000);
      } else {
        // Different window, but still check if code is about to expire
        const remaining = totpSecondsRemaining();
        if (remaining < 5) {
          await logger.log("INFO", `Waiting ${remaining + 1}s for fresh TOTP code`);
          await page.waitForTimeout((remaining + 1) * 1000);
        }
      }

      const totpCode = generateTOTP(credentials.totpSecret, credentials.loginEmail);
      await logger.log("INFO", `Generated TOTP code: ${totpCode.slice(0, 2)}****`);

      let totpInput = page.locator(
        'input[type="tel"], input[name="totpPin"], input[id="totpPin"], input[autocomplete="one-time-code"]'
      );

      try {
        await totpInput.first().waitFor({ state: "visible", timeout: 10_000 });
      } catch {
        // May need to select "Google Authenticator" option first
        const authOption = page.locator(
          'div:has-text("Google Authenticator"), div:has-text("驗證器"), div:has-text("验证器"), div:has-text("Authenticator")'
        );
        if ((await authOption.count()) > 0) {
          await authOption.first().click();
          await page.waitForTimeout(3000);
        }
        totpInput = page.locator(
          'input[type="tel"], input[name="totpPin"], input[id="totpPin"], input[autocomplete="one-time-code"]'
        );
      }

      if ((await totpInput.count()) === 0) {
        throw new Error("Cannot find TOTP input field on 2FA challenge page");
      }

      await totpInput.first().fill(totpCode);
      // Submit via Enter key to avoid pointer interception
      await totpInput.first().press("Enter");
      await logger.log("INFO", "TOTP code submitted");
      markTotpUsed();

      // Poll for URL change instead of fixed wait.
      // Google's TOTP verification + redirect takes 8-12s (observed in gmail-login logs).
      // Check every 1s for up to 15s before concluding the code was rejected.
      const TOTP_POLL_INTERVAL_MS = 1000;
      const TOTP_POLL_MAX_MS = 15000;
      let totpPassed = false;

      for (let elapsed = 0; elapsed < TOTP_POLL_MAX_MS; elapsed += TOTP_POLL_INTERVAL_MS) {
        await page.waitForTimeout(TOTP_POLL_INTERVAL_MS);
        const pollUrl = page.url();
        const stillOnChallenge = pollUrl.includes("challenge/totp") ||
          pollUrl.includes("challenge/az") ||
          (pollUrl.includes("accounts.google.com") && pollUrl.includes("challenge"));

        if (!stillOnChallenge) {
          await logger.log("INFO", `TOTP verified — URL changed after ${elapsed + TOTP_POLL_INTERVAL_MS}ms. URL: ${pollUrl}`);
          totpPassed = true;
          break;
        }
      }

      if (!totpPassed) {
        // Still on challenge page after full polling window — retry with a guaranteed-fresh code.
        await logger.log("WARN", `Still on TOTP page after ${TOTP_POLL_MAX_MS}ms polling, retrying with fresh code. URL: ${page.url()}`);

        // Always wait for the next 30s TOTP window to ensure a different code
        const retryRemaining = totpSecondsRemaining();
        await logger.log("INFO", `Waiting ${retryRemaining + 1}s for next TOTP window`);
        await page.waitForTimeout((retryRemaining + 1) * 1000);

        const freshCode = generateTOTP(credentials!.totpSecret!, credentials!.loginEmail);
        await logger.log("INFO", `Retry TOTP code: ${freshCode.slice(0, 2)}****`);

        const retryInput = page.locator(
          'input[type="tel"], input[name="totpPin"], input[id="totpPin"], input[autocomplete="one-time-code"]'
        );
        if ((await retryInput.count()) > 0) {
          await retryInput.first().fill("");
          await page.waitForTimeout(300);
          await retryInput.first().fill(freshCode);
          await retryInput.first().press("Enter");

          // Poll again after retry submission
          let retryPassed = false;
          for (let elapsed = 0; elapsed < TOTP_POLL_MAX_MS; elapsed += TOTP_POLL_INTERVAL_MS) {
            await page.waitForTimeout(TOTP_POLL_INTERVAL_MS);
            const retryUrl = page.url();
            const stillOnChallenge = retryUrl.includes("challenge/totp") ||
              retryUrl.includes("challenge/az") ||
              (retryUrl.includes("accounts.google.com") && retryUrl.includes("challenge"));
            if (!stillOnChallenge) {
              await logger.log("INFO", `TOTP retry verified — URL changed after ${elapsed + TOTP_POLL_INTERVAL_MS}ms. URL: ${retryUrl}`);
              retryPassed = true;
              break;
            }
          }

          if (!retryPassed) {
            throw new Error(
              `TOTP verification failed after retry — still on challenge page after ${TOTP_POLL_MAX_MS}ms polling. URL: ${page.url()}`
            );
          }
        } else {
          throw new Error("TOTP input field disappeared during retry — cannot re-submit code");
        }
      }

      await page.waitForLoadState("domcontentloaded", { timeout: 60000 });
    }

    // Step 4: After auth, Google redirects back — may need to click remove again
    if (page.url().includes("family/member/")) {
      await logger.log("INFO", "Back on member detail after auth, clicking remove again");
      const removeBtn2 = page.locator([
        'button:has-text("移除")',
        'button:has-text("Remove")',
        'button:has-text("구성원 삭제")',
        'button:has-text("削除")',
        'button:has-text("Xóa")',
      ].join(", "));
      if ((await removeBtn2.count()) > 0) {
        await removeBtn2.first().click();
        await page.waitForTimeout(2000);
      }
    } else if (page.url().includes("family/remove/")) {
      await logger.log("INFO", "On /family/remove/ confirmation page");
    } else if (!page.url().includes("family/")) {
      await page.goto(memberDetailUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      const removeBtn3 = page.locator([
        'button:has-text("移除")',
        'button:has-text("Remove")',
        'button:has-text("구성원 삭제")',
        'button:has-text("削除")',
        'button:has-text("Xóa")',
      ].join(", "));
      if ((await removeBtn3.count()) > 0) {
        await removeBtn3.first().click();
        await page.waitForTimeout(2000);
      }
    }
  }

  // --- Handle confirmation ---
  // Pattern 1: /family/remove/ page with "Remove" / "Cancel" buttons
  // Pattern 2: Same-page dialog with 是/Yes or 確認/Confirm <a> links
  const confirmButton = page.locator([
    'a:has-text("是")',
    'button:has-text("是")',
    'a:has-text("Yes")',
    'button:has-text("Yes")',
    'a:has-text("確認")',
    'button:has-text("確認")',
    'a:has-text("确认")',
    'button:has-text("确认")',
    'a:has-text("Confirm")',
    'button:has-text("Confirm")',
    // Korean
    'button:has-text("예")', 'a:has-text("예")',
    'button:has-text("확인")', 'a:has-text("확인")',
    // Japanese
    'button:has-text("はい")', 'a:has-text("はい")',
    'button:has-text("確認")', 'a:has-text("確認")',
    // Vietnamese
    'button:has-text("Có")', 'a:has-text("Có")',
    'button:has-text("Xác nhận")', 'a:has-text("Xác nhận")',
  ].join(", "));

  if ((await confirmButton.count()) > 0) {
    await confirmButton.last().click();
    await logger.log("INFO", `Confirmed removal of ${email}`);
  } else if (page.url().includes("family/remove/")) {
    // On /family/remove/ confirmation page — click the primary "Remove" button
    const removeFinalBtn = page.locator(
      'button:has-text("Remove"), button:has-text("移除"), ' +
      'button:has-text("삭제"), button:has-text("削除"), button:has-text("Xóa"), ' +
      'button:has-text("Xác nhận"), button:has-text("확인")'
    );
    if ((await removeFinalBtn.count()) > 0) {
      await removeFinalBtn.last().click();
      await logger.log("INFO", `Clicked Remove on confirmation page for ${email}`);
    } else {
      throw new Error(
        `REMOVE_CONFIRM_FAILED: On /family/remove/ page but no confirm button found for ${email}. ` +
        `URL: ${page.url()}. Aborting to prevent inviting without removing.`
      );
    }
  } else {
    // CRITICAL: Neither confirm dialog nor /family/remove/ page detected.
    // This means the removal flow did not proceed as expected.
    // DO NOT silently continue — throw to prevent inviting without removing.
    throw new Error(
      `REMOVE_CONFIRM_FAILED: No confirmation dialog or remove page detected for ${email}. ` +
      `URL: ${page.url()}. Aborting to prevent inviting without removing.`
    );
  }

  await page.waitForTimeout(3000);
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 });

  // --- CRITICAL SAFETY CHECK: Verify the member was actually removed ---
  // Navigate back to family details and confirm the member is gone.
  // Without this, a failed removal (e.g. button click ignored, network error)
  // would silently proceed to the invite step, wasting a seat.
  const VERIFY_MAX_RETRIES = 4;
  const VERIFY_DELAY_MS = 3000;
  for (let vr = 0; vr < VERIFY_MAX_RETRIES; vr++) {
    try {
      await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2000);

      // Check if the removed member's email is still visible on the page (leaf nodes only)
      const stillPresent = await page.evaluate((targetEmail: string) => {
        const leafEls = Array.from(document.querySelectorAll("*"))
          .filter((el) => el.children.length === 0);
        return leafEls.some((el) => {
          const text = el.textContent?.trim().toLowerCase() ?? "";
          return text === targetEmail.toLowerCase();
        });
      }, email);

      if (!stillPresent) {
        await logger.log("INFO", `Removal verified: ${email} no longer on family page (attempt ${vr + 1})`);
        return discoveredGaiaId;
      }

      // Still showing — could be Google page cache lag
      if (vr < VERIFY_MAX_RETRIES - 1) {
        await logger.log("WARN",
          `Removal not yet reflected: ${email} still on page (attempt ${vr + 1}/${VERIFY_MAX_RETRIES}), waiting...`
        );
        await page.waitForTimeout(VERIFY_DELAY_MS);
      }
    } catch (verifyErr: any) {
      await logger.log("WARN", `Removal verify navigation error (attempt ${vr + 1}): ${verifyErr.message}`);
    }
  }

  // After all retries, member is still on the page — removal likely failed
  throw new Error(
    `REMOVE_NOT_CONFIRMED: ${email} still appears on family page after ${VERIFY_MAX_RETRIES} checks. ` +
    `Removal may have failed. Aborting to prevent inviting without removing.`
  );
}

/**
 * Fallback member finder when GAIA ID is not available.
 * Tries S1 (email text on page) → S2 (displayName) → S3 (click each card).
 * After this resolves, the page will be on the member's detail page.
 */
/**
 * Extracts the GAIA ID from the current member detail page URL.
 * e.g. /family/member/g/123456  →  "123456"
 */
function extractGaiaIdFromUrl(url: string): string | undefined {
  return url.match(/\/g\/(\d+)/)?.[1] ?? url.match(/\/i\/([-\d]+)/)?.[1] ?? url.match(/\/member\/([-\d]+)/)?.[1];
}

async function fallbackFindMember(
  page: import("playwright").Page,
  email: string,
  displayName: string | undefined,
  logger: TaskLogger,
  knownGaiaId?: string,
  otherMemberGaiaIds?: Set<string>
): Promise<string | undefined> {
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 });

  // S1: Email visible directly on list (pending invites without a Google account name)
  const emailLocator = page.locator(`text="${email}"`);
  if ((await emailLocator.count()) > 0) {
    await logger.log("INFO", `S1: Found email text on list page, clicking`);
    await emailLocator.first().click();
    await page.waitForLoadState("domcontentloaded", { timeout: 60000 });
    return extractGaiaIdFromUrl(page.url());
  }

  // S2: displayName match (accepted members show their Google display name)
  if (displayName) {
    await logger.log("INFO", `S2: Email not visible, trying displayName "${displayName}"`);
    const nameLocator = page.locator(`text="${displayName}"`);
    if ((await nameLocator.count()) > 0) {
      await logger.log("INFO", `S2: Found by displayName, clicking`);
      await nameLocator.first().click();
      await page.waitForLoadState("domcontentloaded", { timeout: 60000 });

      // Fix #4: Verify identity on detail page — displayName collision is possible.
      // Use leaf-node extraction: body.textContent contains ALL members' emails (always matches).
      const s2LeafEmails = await page.evaluate(() => {
        const leafEls = Array.from(document.querySelectorAll("*"))
          .filter((el) => el.children.length === 0);
        return leafEls
          .map((el) => el.textContent?.trim() ?? "")
          .filter((t) => /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(t));
      });
      await logger.log("INFO", `S2: Leaf emails on detail page: [${s2LeafEmails.join(", ")}]`);
      if (s2LeafEmails.some((e) => e.toLowerCase() === email.toLowerCase())) {
        await logger.log("INFO", `S2 verified: leaf email matches target ${email}`);
        return extractGaiaIdFromUrl(page.url());
      }
      // Mismatch: displayName was ambiguous, fall through to S3
      await logger.log("WARN", `S2: displayName matched on list but detail page does not contain "${email}" — falling to S3`);
      await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    }
    await logger.log("WARN", `S2: displayName "${displayName}" not found on page either`);
  }

  // S3: Blind iteration — click each non-admin card and check detail page body.
  // NOTE: Do NOT use obfuscated Google CSS classes (e.g. .umngff) — they change with deployments.
  // Use only stable structural selectors.
  await logger.log("INFO", `S3: Iterating all member cards to find "${email}"`);

  // Collect all member href links from the page DOM directly
  const memberHrefs: string[] = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="family/member/"]');
    return Array.from(links)
      .map((a) => (a as HTMLAnchorElement).href)
      .filter((h) => !!h);
  });

  await logger.log("INFO", `S3: Found ${memberHrefs.length} member links on family page`);

  if (memberHrefs.length === 0) {
    // Dump page content for diagnostics
    const pageSnippet = await page.evaluate(() => document.body?.innerText?.slice(0, 800) ?? "").catch(() => "?");
    await logger.log("WARN", `S3: No member links found. Page snippet: ${pageSnippet}`);
  }

  // S3-fast: If we have a known GAIA ID, try to find matching href FIRST (O(1) vs O(n) page visits)
  if (knownGaiaId) {
    const gaiaHref = memberHrefs.find((h) => h.includes(`/g/${knownGaiaId}`) || h.includes(`/i/${knownGaiaId}`));
    if (gaiaHref) {
      await logger.log("INFO", `S3-fast: Found href matching known GAIA ${knownGaiaId}, navigating directly`);
      await page.goto(gaiaHref, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1500);
      return extractGaiaIdFromUrl(page.url());
    }
    await logger.log("WARN", `S3-fast: Known GAIA ${knownGaiaId} not found in ${memberHrefs.length} hrefs, falling to blind iteration`);
  }

  for (let i = 0; i < memberHrefs.length; i++) {
    const href = memberHrefs[i];

    try {
      await page.goto(href, { waitUntil: "domcontentloaded", timeout: 60000 });
      // Wait for Google Angular content to render — domcontentloaded only means
      // the HTML shell is parsed, not that dynamic content is visible.
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1500);

      // Verify URL actually navigated to a member detail page
      const currentUrl = page.url();
      if (!currentUrl.includes("family/member/")) {
        await logger.log("WARN", `S3: Card #${i} navigation landed on unexpected URL: ${currentUrl}, skipping`);
        continue;
      }

      // Definitive manager detection: "Delete Family Group" button only appears on the manager's own page.
      // Always skip regardless of whether the email appears in body text (it often does on the manager page).
      const deleteGroupBtn = await page.locator(
        'button:has-text("Delete Family Group"), button:has-text("删除家庭群组"), button:has-text("刪除家庭群組"), ' +
        'button:has-text("가족 그룹 삭제"), button:has-text("ファミリーグループを削除"), button:has-text("Xóa nhóm gia đình")'
      ).count();
      if (deleteGroupBtn > 0) {
        await logger.log("DEBUG", `S3: Card #${i} is manager page (Delete Family Group button), skipping`);
        continue;
      }

      const s3LeafEmails = await page.evaluate(() => {
        const leafEls = Array.from(document.querySelectorAll("*"))
          .filter((el) => el.children.length === 0);
        return leafEls
          .map((el) => el.textContent?.trim() ?? "")
          .filter((t) => /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(t));
      });
      let matched = s3LeafEmails.some((e) => e.toLowerCase() === email.toLowerCase());

      // Best-of-both-worlds fallback: For accepted members, Google completely hides their email from the visible DOM.
      // However, the email remains in the massive WIZ_global_data JSON payloads inside script tags.
      // We can extract the definitive mapping of email -> GAIA ID from this payload, and verify if it matches the current URL.
      if (!matched) {
        const payloadGaia = await page.evaluate((targetEmail) => {
          const rawHtml = document.documentElement.innerHTML;
          const emailRegex = /"([^"]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})"/g;
          let m;
          while ((m = emailRegex.exec(rawHtml)) !== null) {
            if (m[1].toLowerCase() === targetEmail.toLowerCase()) {
              const chunk = rawHtml.substring(Math.max(0, m.index - 1000), m.index);
              const gaiaMatch = Array.from(chunk.matchAll(/"(-?\d{15,25})"/g));
              if (gaiaMatch.length > 0) return gaiaMatch[gaiaMatch.length - 1][1];
            }
          }
          return null;
        }, email);

        const currentGaia = page.url().match(/\/g\/(\d+)/)?.[1] ?? page.url().match(/\/i\/([-\d]+)/)?.[1] ?? page.url().match(/\/member\/([-\d]+)/)?.[1];
        if (payloadGaia && currentGaia && payloadGaia === currentGaia) {
          matched = true;
        }
      }

      // Diagnostic log: always record what emails were found on this detail page
      await logger.log("DEBUG",
        `S3: Card #${i} (href=${href}), target=${email}, matched=${matched}. Leaf emails: [${s3LeafEmails.join(", ")}]`
      );

      if (matched) {
        // Cross-validate: if we know other members' GAIA IDs, make sure this card
        // does NOT belong to a different member (prevents removing the wrong person)
        const cardGaiaId = extractGaiaIdFromUrl(page.url());
        if (cardGaiaId && otherMemberGaiaIds?.has(cardGaiaId)) {
          await logger.log("WARN",
            `S3: SAFETY BLOCK — Card #${i} GAIA ${cardGaiaId} belongs to ANOTHER known member. ` +
            `Email leaf-match was likely a false positive. Skipping this card.`
          );
          continue;
        }
        await logger.log("INFO", `S3: Matched on detail page for card #${i} (href=${href})`);
        return cardGaiaId;
      }
    } catch (err) {
      await logger.log("WARN", `S3: Failed to navigate to card #${i}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // S4: Elimination strategy — if we know the GAIA IDs of OTHER members,
  // identify the target by finding the card whose GAIA is NOT in the known set.
  // This handles cases where email and displayName are both hidden/mismatched
  // but we can deduce identity by process of elimination.
  if (otherMemberGaiaIds && otherMemberGaiaIds.size > 0 && memberHrefs.length > 0) {
    await logger.log("INFO", `S4: Attempting elimination — ${otherMemberGaiaIds.size} known other GAIA IDs, ${memberHrefs.length} cards`);

    // Collect all card GAIA IDs (excluding manager)
    const unknownCards: { href: string; gaiaId: string }[] = [];
    for (const href of memberHrefs) {
      const gaiaFromHref = href.match(/\/g\/(\d+)/)?.[1] ?? href.match(/\/i\/([-\d]+)/)?.[1];
      if (!gaiaFromHref) continue;

      // Skip the manager card (check if it's the known gaiaId of another member or manager)
      if (otherMemberGaiaIds.has(gaiaFromHref)) {
        await logger.log("DEBUG", `S4: Card GAIA ${gaiaFromHref} belongs to a known OTHER member, skipping`);
        continue;
      }

      // Verify it's not the manager page
      try {
        await page.goto(href, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1500);

        const isManager = await page.locator(
          'button:has-text("Delete Family Group"), button:has-text("删除家庭群组"), button:has-text("刪除家庭群組"), ' +
          'button:has-text("가족 그룹 삭제"), button:has-text("ファミリーグループを削除"), button:has-text("Xóa nhóm gia đình")'
        ).count();
        if (isManager > 0) {
          await logger.log("DEBUG", `S4: Card GAIA ${gaiaFromHref} is manager, skipping`);
          continue;
        }

        unknownCards.push({ href, gaiaId: gaiaFromHref });
      } catch {
        // Navigation error — skip this card
      }
    }

    await logger.log("INFO", `S4: Found ${unknownCards.length} unmatched card(s) after elimination`);

    if (unknownCards.length === 1) {
      // Exactly one unknown card — it MUST be our target
      const target = unknownCards[0];
      await logger.log("INFO", `S4: Elimination match! Only 1 unmatched card: GAIA=${target.gaiaId}. This must be "${email}".`);
      await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1500);
      return target.gaiaId;
    } else if (unknownCards.length > 1) {
      await logger.log("WARN",
        `S4: ${unknownCards.length} unmatched cards — cannot disambiguate. ` +
        `GAIAs: [${unknownCards.map(c => c.gaiaId).join(", ")}]`
      );
    } else {
      await logger.log("WARN", `S4: No unmatched cards found — all cards belong to known members or manager`);
    }
  }

  // Navigate back to family page for error screenshot
  await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});

  throw new Error(
    `Cannot find member "${email}" on family page. ` +
    `Checked ${memberHrefs.length} cards via S1/S2/S3/S4. Member may have left or DB is out of sync.`
  );
}

/**
 * Invite a new member on the Google Family page.
 * (Reuses the same calibrated approach as invite.processor)
 *
 * Selectors calibrated from real Google Family UI.
 */
async function inviteMemberOnPage(
  page: import("playwright").Page,
  email: string,
  logger: TaskLogger,
  preInviteCardCount?: number
): Promise<void> {
  // Always navigate to family details to ensure a clean starting state
  await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1000);

  // Wait for the invite link to appear (confirms the slot opened up)
  // After a removal, Google's backend may take 30-60s+ to release the slot.
  // The page does NOT live-update, so we must reload/navigate to re-fetch.
  // Strategy: poll with page refresh every 10s, up to 90s total.
  const inviteLink = page.locator('a[href*="invitemembers"]');
  const POLL_INTERVAL_MS = 5_000;
  const MAX_WAIT_MS = 30_000;
  let inviteLinkFound = false;

  for (let elapsed = 0; elapsed < MAX_WAIT_MS; elapsed += POLL_INTERVAL_MS) {
    if ((await inviteLink.count()) > 0 && await inviteLink.first().isVisible().catch(() => false)) {
      inviteLinkFound = true;
      break;
    }

    if (elapsed > 0) {
      await logger.log("INFO", `Invite link not yet visible — refreshing page (${elapsed / 1000}s / ${MAX_WAIT_MS / 1000}s)`);
    }

    // Reload the family page to pick up backend slot changes
    await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(POLL_INTERVAL_MS);
  }

  if (!inviteLinkFound) {
    // Last check after final wait
    if ((await inviteLink.count()) > 0 && await inviteLink.first().isVisible().catch(() => false)) {
      inviteLinkFound = true;
    }
  }

  if (!inviteLinkFound) {
    throw new Error(
      `Invite link not found on family page after removal — slot may not be available yet (waited ${MAX_WAIT_MS / 1000}s with ${MAX_WAIT_MS / POLL_INTERVAL_MS} page refreshes)`
    );
  }

  await inviteLink.first().click();
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 });
  await page.waitForTimeout(2000);

  // Email input — selectors must match invite.processor.ts
  const emailInput = page.locator([
    "input.I4p4db",
    'input[placeholder*="電子郵件"]',
    'input[placeholder*="电子邮件"]',
    'input[placeholder*="email" i]',
    'input[placeholder*="メール"]',
    'input[placeholder*="이메일"]',
    'input[type="email"]',
  ].join(", "));

  // Wait up to 15s for Angular to render the input (lazy-loaded component)
  try {
    await emailInput.first().waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    const url = page.url();
    const bodySnippet = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? "").catch(() => "?");
    throw new Error(`Cannot find email input field. URL: ${url}, body: ${bodySnippet}`);
  }

  await emailInput.first().fill(email);
  await logger.log("INFO", `Filled email: ${email}`);

  await page.waitForTimeout(1500);
  await emailInput.first().press("Enter");
  await page.waitForTimeout(1000);

  // Send button
  const sendButton = page.locator(
    'button:has-text("傳送"), button:has-text("Send"), button:has-text("发送"), ' +
    'button:has-text("보내기"), button:has-text("전송"), ' +
    'button:has-text("送信"), ' +
    'button:has-text("Gửi")'
  );
  if ((await sendButton.count()) === 0) {
    throw new Error("Cannot find send button");
  }

  await sendButton.first().click();
  await logger.log("INFO", `Clicked send for ${email}`);

  // Wait for page to navigate away from invitemembers
  try {
    await page.waitForURL(
      (url) => !url.toString().includes("invitemembers"),
      { timeout: 15_000 }
    );
  } catch {
    const postSendUrl = page.url();
    if (postSendUrl.includes("invitemembers")) {
      const bodyText = await page.locator("body").textContent().catch(() => "");
      const snippet = bodyText?.substring(0, 200) || "";
      throw new Error(`Invite may have failed — still on invite page after send. URL: ${postSendUrl}. Page snippet: ${snippet}`);
    }
  }
  await page.waitForTimeout(2000);

  // ── Post-send: check result page for success or failure ──
  const inviteResult = await checkInviteResultPage(page, logger);

  if (inviteResult.outcome === "rate_limited") {
    await logger.log("ERROR",
      `[replace] Invite RATE LIMITED by Google backend. Detail: ${inviteResult.errorDetail ?? "unknown"}`
    );
    throw new InviteCooldownError("unknown");
  }

  if (inviteResult.outcome === "error") {
    await logger.log("ERROR",
      `[replace] Invite FAILED (non-rate-limit). Detail: ${inviteResult.errorDetail ?? "unknown"}. ` +
      `Page: ${inviteResult.pageText.slice(0, 200)}`
    );
    throw new Error(
      `INVITE_FAILED: ${inviteResult.errorDetail ?? "Google returned an error on the result page"}`
    );
  }

  // outcome === "success"
  await logger.log("INFO", `[replace] Invite result: SUCCESS (result page confirmed) for ${email}`);
}


/**
 * Scan the family details page for a member card matching the given email.
 * Returns the gaiaId extracted from the card's href, or undefined.
 */
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
  const allIds = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="family/member/"]');
    const ids: string[] = [];
    for (const link of Array.from(links)) {
      const href = link.getAttribute("href") ?? "";
      const match =
        href.match(/\/g\/(\d+)/) ??
        href.match(/\/member\/i\/([-\d]+)/) ??
        href.match(/\/member\/([-\d]+)/);
      if (match?.[1]) ids.push(match[1]);
    }
    return ids;
  });

  if (allIds.length > 0) {
    const existing = await prisma.familyMember.findMany({
      where: { familyGroupId, googleMemberId: { in: allIds } },
      select: { googleMemberId: true }
    });
    const existingSet = new Set(existing.map(e => e.googleMemberId!));
    const newIds = allIds.filter(id => !existingSet.has(id));
    if (newIds.length > 0) {
      // Pick the first new ID, assuming this is the one we just invited
      return newIds[0];
    }
  }

  return undefined;
}
