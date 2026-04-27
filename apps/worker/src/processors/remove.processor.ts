/**
 * Remove member processor.
 *
 * Flow:
 * 1. Acquire profile lock
 * 2. Start AdsPower browser profile
 * 3. Connect via CDP
 * 4. Navigate to Google One Family management page
 * 5. Remove the target member (with password + TOTP if needed)
 * 6. Take screenshots, update statuses
 * 7. Release lock, close profile
 *
 * Reuses removeMemberOnPage logic from replace.processor.
 */

import { Job, UnrecoverableError } from "bullmq";
import { PrismaClient, MemberStatus } from "@prisma/client";
import type { RemoveMemberPayload } from "@gfa/shared";

import { AdsPowerClient } from "../adspower-client";
import { BrowserPool } from "../browser-pool";
import { WorkerBrowser } from "../browser-context";
import { TaskLogger } from "../task-logger";
import { gmailLogin } from "../gmail-login";
import { handleLoginResult } from "../handle-login-result";
import { generateTOTP, totpSecondsRemaining, currentTotpWindow, lastUsedTotpWindow, markTotpUsed } from "../totp";
import { checkTransferBatchProgress } from "../check-transfer-progress";
import { Queue } from "bullmq";
import { postTaskSync } from "../post-task-sync";
import { recalcGroupCountsFromDB } from "./sync.processor";

const GOOGLE_FAMILY_URL = "https://myaccount.google.com/family/details?hl=en";

export interface RemoveProcessorDeps {
  prisma: PrismaClient;
  adspower: AdsPowerClient;
  pool: BrowserPool;
  workerId: string;
  inviteQueue: Queue;
}

export async function processRemove(
  job: Job<RemoveMemberPayload & { taskId: string }>,
  deps: RemoveProcessorDeps
): Promise<void> {
  const { prisma, adspower, pool, workerId } = deps;
  const { familyGroupId, memberEmail } = job.data;
  const taskId = job.data.taskId ?? job.id ?? job.name;
  if (!taskId) {
    console.error(`[worker:${workerId}] remove job has no id, skipping`);
    return;
  }

  const logger = new TaskLogger(prisma, taskId, workerId);
  const browser = new WorkerBrowser();

  const account = await prisma.account.findUnique({ where: { id: job.data.accountId } });
  if (!account) {
    await logger.updateStatus("FAILED_FINAL", { code: "ACCOUNT_NOT_FOUND", message: `账号不存在` });
    return;
  }

  let profileId: string | null = null;
  let stopHeartbeat: (() => void) | null = null;
  let originalMemberStatus: MemberStatus = 
    (job.data as any).originalMemberStatus as MemberStatus || MemberStatus.ACTIVE; // from API payload for rollback
  const lockedAccountId = account.id;

  try {
    // Look up member DB record before acquiring browser resource
    const memberRecord = await prisma.familyMember.findFirst({
      where: { familyGroupId, email: memberEmail },
      select: { googleMemberId: true, displayName: true, status: true },
    });
    // Use actual DB status for rollback (not the API-sent one which may already be stale).
    // The API side may have already changed it to PENDING before queuing this task.
    if (memberRecord?.status) {
      originalMemberStatus = memberRecord.status;
    }

    // Skip if member is already removed (duplicate task or retry after another task succeeded)
    if (memberRecord?.status === "REMOVED") {
      await logger.log("INFO", `成员 ${memberEmail} 在数据库中已是 REMOVED 状态，跳过移除`);
      await logger.updateStatus("SUCCESS", {
        code: "ALREADY_REMOVED",
        message: `成员 ${memberEmail} 已被移除`,
      });
      return;
    }

    // Cooldown guard: skip immediately if this account recently failed login
    if (!job.data.ignoreCooldown) {
      const cooldownSecs = await pool.isLoginCoolingDown(account.id);
      if (cooldownSecs > 0) {
        await logger.log("WARN", `[remove] 主号登录冷却中（剩余 ${cooldownSecs} 秒），跳过本次执行`);
        await logger.updateStatus("FAILED_RETRYABLE", { code: "LOGIN_COOLDOWN", message: `主号登录冷却中，剩余 ${cooldownSecs} 秒` });
        throw new Error(`LOGIN_COOLDOWN: ${cooldownSecs}s remaining`);
      }
    }

    // Acquire profile + open AdsPower browser (retries other profiles on failure)
    const acquired = await pool.acquireAndOpen(workerId, account.id, adspower);
    profileId = acquired.profileId;
    stopHeartbeat = pool.startHeartbeat(profileId, account.id, workerId);
    await logger.log("INFO", `Removing member ${memberEmail}`, {
      profileId, familyGroupId,
      gaiaId: memberRecord?.googleMemberId ?? "unknown",
    });
    await logger.updateStatus("RUNNING");

    const page = await browser.connect(acquired.debugUrl);

    // Gmail auto-login (required every time — browser clears cache on start)
    const loginResult = await gmailLogin(page, account, logger);
    if (!loginResult.success) {
      await handleLoginResult(loginResult, { job, pool, prisma, logger, accountId: account.id });
    }
    // Record which account is now logged into this profile
    await pool.setLastAccount(profileId!, account.id);


    await browser.navigateTo(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Query other members' GAIA IDs for cross-validation safety check
    const otherMembers = await prisma.familyMember.findMany({
      where: {
        familyGroupId,
        email: { not: memberEmail },
        googleMemberId: { not: null },
        status: { not: "REMOVED" },
      },
      select: { googleMemberId: true },
    });
    const otherGaiaIds = new Set(otherMembers.map((m) => m.googleMemberId!).filter(Boolean));
    await logger.log("INFO", `Cross-validation set: ${otherGaiaIds.size} other member GAIA IDs loaded`);

    // Execute remove on page using gaiaId (S0) when available, falling back to S1/S2/S3
    const removeResult = await removeMemberOnPage(page, memberEmail, logger, {
      password: account.loginPassword ?? undefined,
      totpSecret: account.totpSecret ?? undefined,
      googleMemberId: memberRecord?.googleMemberId ?? undefined,
      displayName: memberRecord?.displayName ?? undefined,
    }, otherGaiaIds);

    // Idempotent success: member was already removed (e.g. previous attempt succeeded
    // but was reported as failed due to confirm button timeout)
    if (removeResult === "ALREADY_REMOVED") {
      await logger.log("INFO", `Member ${memberEmail} already removed from Google page (idempotent success)`);
      // Still run post-sync to reconcile DB state
    }

    // ── Post-removal sync ──
    // Reuse the shared postTaskSync which handles: dedup, reconcile, slot
    // calculation — all in one consistent path.
    const syncOk = await postTaskSync(page, prisma, familyGroupId, account.loginEmail ?? "", logger);

    if (!syncOk) {
      // postTaskSync failed silently — recalculate from DB records for accuracy
      await logger.log("WARN", "Post-removal sync failed, recalculating counts from DB");
      await prisma.familyMember.updateMany({
        where: { familyGroupId, email: memberEmail },
        data: { status: "REMOVED", removedAt: new Date() },
      });
      await recalcGroupCountsFromDB(prisma, familyGroupId, logger);
    } else {
      // Verify the removed member was marked in DB (postTaskSync's reconcile
      // should have done this, but ensure it as a safety net)
      const memberAfterSync = await prisma.familyMember.findFirst({
        where: { familyGroupId, email: memberEmail },
        select: { status: true },
      });
      if (memberAfterSync && memberAfterSync.status !== "REMOVED") {
        await logger.log("WARN", `Post-sync: member ${memberEmail} still ${memberAfterSync.status}, forcing REMOVED`);
        await prisma.familyMember.updateMany({
          where: { familyGroupId, email: memberEmail },
          data: { status: "REMOVED", removedAt: new Date() },
        });
      }
    }


    await logger.updateStatus("SUCCESS");
    await logger.log("INFO", `Member ${memberEmail} removed successfully`);

    // Transfer batch callback: check if all remove tasks are done
    await checkTransferBatchProgress(prisma, taskId, deps.inviteQueue).catch((err) =>
      logger.log("WARN", `Transfer progress check failed: ${err instanceof Error ? err.message : String(err)}`)
    );

    // Fix #3: Sync Order status so frontend shows consistent data.
    // ONLY mark order EXPIRED when removal is due to membership expiry
    // (triggered by expire-scan cron). Swap-related removals and manual
    // operations should NOT change the order status.
    const removalReason = (job.data as any).reason || "";
    const isExpiryRemoval = removalReason === "EXPIRED" || removalReason === "MEMBER_EXPIRED" || removalReason === "SCHEDULER_EXPIRED";
    if (isExpiryRemoval) {
      try {
        const relatedOrder = await prisma.order.findFirst({
          where: {
            userEmail: memberEmail,
            familyGroupId,
            status: { notIn: ["FAILED", "CREATED", "EXPIRED"] },
          },
          select: { id: true, orderType: true },
        });
        if (relatedOrder) {
          await prisma.order.update({
            where: { id: relatedOrder.id },
            data: { status: "EXPIRED", resultMessage: `Member ${memberEmail} removed from family group (expired)` },
          });
          await logger.log("INFO", `Updated Order ${relatedOrder.id} status to EXPIRED (reason=${removalReason})`);
        }
      } catch (orderErr) {
        // Non-fatal: member removal itself succeeded
        await logger.log("WARN", `Failed to sync Order status after removal: ${orderErr instanceof Error ? orderErr.message : String(orderErr)}`);
      }
    } else {
      await logger.log("INFO", `Skipped order status sync (removal reason=${removalReason || "manual"}, not expiry)`);
    }
  } catch (error) {
    // Don't overwrite MANUAL_REVIEW status and don't rollback member status
    if (error instanceof UnrecoverableError) throw error;

    const errMsg = error instanceof Error ? error.message : String(error);

    try {
    } catch {
      // noop
    }

    // Rollback member status: restore to whatever it was BEFORE the removal attempt
    if (originalMemberStatus !== "REMOVED") {
      await prisma.familyMember.updateMany({
        where: { familyGroupId, email: memberEmail },
        data: { status: originalMemberStatus },
      }).catch(() => {});
    }

    await logger.updateStatus("FAILED_RETRYABLE", {
      code: profileId ? "REMOVE_ERROR" : "PROFILE_ACQUIRE_FAILED",
      message: errMsg,
    });

    await logger.log("ERROR", `移除失败（将重试）: ${errMsg}`);

    // Transfer batch callback on terminal failure:
    // Mark task FAILED_FINAL first so the callback sees a terminal status
    // and can correctly advance the batch phase.
    // Only applies to transfer tasks (has transferBatchId) to avoid changing
    // behavior of normal remove tasks.
    if (job.attemptsMade >= (job.opts?.attempts ?? 3) - 1) {
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
    await pool.releaseAccount(lockedAccountId, workerId).catch(() => {});
  }
}

/**
 * Remove a family member on the Google Family page.
 *
 * Strategy (tried in order):
 *   S0: Direct GAIA URL navigation (uses googleMemberId from DB)
 *   S1: Find email text directly on list page (pending invites)
 *   S2: Find member by displayName (accepted members show display name)
 *   S3: Iterate all member hrefs from DOM and check detail page body
 *
 * Handles password re-authentication and TOTP 2FA if triggered by Google.
 */
export async function removeMemberOnPage(
  page: import("playwright").Page,
  email: string,
  logger: TaskLogger,
  credentials?: { password?: string; totpSecret?: string; googleMemberId?: string; displayName?: string },
  otherMemberGaiaIds?: Set<string>
): Promise<"REMOVED" | "ALREADY_REMOVED"> {
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 });

  const googleMemberId = credentials?.googleMemberId;
  const displayName = credentials?.displayName;

  if (googleMemberId) {
    // S0: Direct GAIA navigation
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
      // Identity verification using leaf-node extraction (body.textContent contains ALL members' emails)
      const leafEmails = await page.evaluate(() => {
        const leafEls = Array.from(document.querySelectorAll("*"))
          .filter((el) => el.children.length === 0);
        return leafEls
          .map((el) => el.textContent?.trim() ?? "")
          .filter((t) => /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(t));
      });
      await logger.log("INFO", `S0: Leaf emails on detail page: [${leafEmails.join(", ")}]`);
      const emailMatch = leafEmails.some((e) => e.toLowerCase() === email.toLowerCase());

      if (emailMatch) {
        await logger.log("INFO", `S0 verified: leaf email matches ${email}`);
      } else {
        await logger.log("WARN",
          `S0 identity mismatch: gaiaId=${googleMemberId} page does not contain email="${email}" or displayName="${displayName ?? 'N/A'}". Falling back.`
        );
        // Clear SPA state: navigate to blank page first to prevent stale DOM content
        await page.goto("about:blank", { waitUntil: "domcontentloaded" }).catch(() => {});
        await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
        const found = await fallbackFindMember(page, email, displayName, logger, googleMemberId, otherMemberGaiaIds);
        if (!found) return "ALREADY_REMOVED";
      }
    } else {
      await logger.log("WARN", `S0: No action button found, falling back to list page matching`);
      // Clear SPA state before fallback
      await page.goto("about:blank", { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      const found = await fallbackFindMember(page, email, displayName, logger, googleMemberId, otherMemberGaiaIds);
      if (!found) return "ALREADY_REMOVED";
    }
  } else {
    await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    const found = await fallbackFindMember(page, email, displayName, logger, undefined, otherMemberGaiaIds);
    if (!found) return "ALREADY_REMOVED";
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
    const found = await fallbackFindMember(page, email, displayName, logger, undefined, otherMemberGaiaIds);
    if (!found) {
      await logger.log("WARN", `Member ${email} not found after clearing bad GAIA ID — may be already removed`);
      return "ALREADY_REMOVED";
    }
    await logger.log("INFO", `After manager-page fallback, now on: ${page.url()}`);
  }

  const memberDetailUrl = page.url();

  // Wait for Angular to render the action button (lazy-loaded)
  const actionButton = page.locator([
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

  try {
    await actionButton.first().waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    // Try S0 fallback if direct nav failed to show button, or continue to throw
    if (googleMemberId) {
      await logger.log("WARN", `S0 page has no action button, falling back to list-page matching`);
      await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      await fallbackFindMember(page, email, displayName, logger, googleMemberId, otherMemberGaiaIds);
      // Re-wait after fallback
      try { await actionButton.first().waitFor({ state: "visible", timeout: 10_000 }); } catch { /* fall through */ }
    }
  }

  if ((await actionButton.count()) === 0) {
    const allButtons = await page.evaluate(() =>
      Array.from(document.querySelectorAll("button")).map((b) => ({
        text: b.textContent?.trim(),
        visible: b.offsetParent !== null,
      }))
    );
    await logger.log("WARN", `No action button found. Buttons: ${JSON.stringify(allButtons)}`);
    throw new Error(`Cannot find remove/cancel button for member ${email}`);
  }

  await actionButton.first().click();
  await logger.log("INFO", `Clicked remove/cancel for ${email}`);

  await page.waitForTimeout(3000);
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 });

  // ── Unified confirmation + re-auth loop ──
  // Google's removal flow can vary:
  //   Flow A: Click Remove → confirmation dialog (with "Remove" button) → re-auth → done
  //   Flow B: Click Remove → re-auth → back to member page → click remove again → confirm → done
  //   Flow C: Click Remove (pending invite) → done immediately
  // This loop handles all flows by checking the page state at each step.

  const CONFIRM_SELECTORS = [
    'button:has-text("Remove")', 'button:has-text("移除")',
    'button:has-text("Remove member")',
    'button:has-text("Cancel invitation")', 'button:has-text("取消邀請")', 'button:has-text("取消邀请")',
    'button:has-text("Revoke")', 'button:has-text("撤銷")', 'button:has-text("撤销")',
    'button:has-text("是")', 'button:has-text("Yes")',
    'button:has-text("確認")', 'button:has-text("确认")', 'button:has-text("Confirm")',
    'a:has-text("Remove")', 'a:has-text("移除")',
    'a:has-text("是")', 'a:has-text("Yes")',
    'a:has-text("確認")', 'a:has-text("Confirm")',
    'div[role="button"]:has-text("Remove")', 'div[role="button"]:has-text("移除")',
    // Korean
    'button:has-text("구성원 삭제")', 'button:has-text("삭제")',
    'button:has-text("초대 취소")',
    'button:has-text("예")', 'button:has-text("확인")',
    'a:has-text("삭제")', 'a:has-text("예")', 'a:has-text("확인")',
    // Japanese
    'button:has-text("削除")', 'button:has-text("メンバーを削除")',
    'button:has-text("招待をキャンセル")',
    'button:has-text("はい")', 'button:has-text("確認")',
    'a:has-text("削除")', 'a:has-text("はい")',
    // Vietnamese
    'button:has-text("Xóa")', 'button:has-text("Xóa thành viên")',
    'button:has-text("Hủy lời mời")',
    'button:has-text("Có")', 'button:has-text("Xác nhận")',
    'a:has-text("Xóa")', 'a:has-text("Có")', 'a:has-text("Xác nhận")',
  ].join(", ");

  for (let step = 0; step < 10; step++) {
    const stepUrl = page.url();
    await logger.log("DEBUG", `[remove] Step ${step + 1}, URL: ${stepUrl}`);

    // ── Check if we've navigated away → removal complete ──
    if (
      stepUrl.includes("family/details") ||
      stepUrl.includes("families.google.com/families")
    ) {
      await logger.log("INFO", `[remove] Reached family list page — removal likely complete`);
      break;
    }

    // ── Handle re-auth: accounts.google.com ──
    const isReAuth =
      stepUrl.includes("accounts.google.com") ||
      stepUrl.includes("challenge/pwd") ||
      stepUrl.includes("challenge/totp") ||
      stepUrl.includes("challenge/az") ||
      stepUrl.includes("challenge/sk") ||
      stepUrl.includes("challenge/selection") ||
      stepUrl.includes("signin/challenge");

    if (isReAuth) {
      await logger.log("INFO", `[remove] Re-auth at step ${step + 1}: ${stepUrl}`);

      // Challenge selection → pick TOTP (check FIRST, before any input detection)
      if (stepUrl.includes("challenge/selection") && credentials?.totpSecret) {
        const totpOption = page.locator(
          'div[data-challengetype="6"], li[data-challengetype="6"], button[data-challengetype="6"]'
        );
        if ((await totpOption.count()) > 0) {
          await totpOption.first().click();
          await logger.log("INFO", "[remove] Selected TOTP from challenge selection");
          await page.waitForTimeout(3000);
          continue;
        }
      }

      // TOTP challenge (check by URL before password)
      if (stepUrl.includes("challenge/totp") || stepUrl.includes("challenge/az")) {
        if (!credentials?.totpSecret) {
          throw new Error(`Google requires TOTP to remove member ${email}, but no totpSecret configured`);
        }

        // Ensure we use a different TOTP code than the one submitted during login.
        // Google rejects same-code reuse within a session, even if still valid.
        const curWindow = currentTotpWindow();
        if (curWindow <= lastUsedTotpWindow()) {
          const remaining = totpSecondsRemaining();
          await logger.log("INFO", `[remove] Waiting ${remaining + 1}s to avoid TOTP code reuse (same window as login)`);
          await page.waitForTimeout((remaining + 1) * 1000);
        } else {
          const remaining = totpSecondsRemaining();
          if (remaining < 5) {
            await logger.log("INFO", `[remove] Waiting ${remaining + 1}s for fresh TOTP code`);
            await page.waitForTimeout((remaining + 1) * 1000);
          }
        }
        const totpCode = generateTOTP(credentials.totpSecret);

        let totpInput = page.locator(
          'input[type="tel"], input[name="totpPin"], input[id="totpPin"], input[autocomplete="one-time-code"]'
        );
        try {
          await totpInput.first().waitFor({ state: "visible", timeout: 10_000 });
        } catch {
          // Try clicking Authenticator option first
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
        await totpInput.first().press("Enter");
        await logger.log("INFO", `[remove] TOTP submitted (${totpCode.slice(0, 2)}****)`);
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
            await logger.log("INFO", `[remove] TOTP verified — URL changed after ${elapsed + TOTP_POLL_INTERVAL_MS}ms. URL: ${pollUrl}`);
            totpPassed = true;
            break;
          }
        }

        if (!totpPassed) {
          // Still on challenge page after full polling window — retry with a guaranteed-fresh code.
          await logger.log("WARN", `[remove] Still on TOTP page after ${TOTP_POLL_MAX_MS}ms polling, retrying with fresh code. URL: ${page.url()}`);

          // Always wait for the next 30s TOTP window to ensure a different code
          const retryRemaining = totpSecondsRemaining();
          await logger.log("INFO", `[remove] Waiting ${retryRemaining + 1}s for next TOTP window`);
          await page.waitForTimeout((retryRemaining + 1) * 1000);

          const freshCode = generateTOTP(credentials.totpSecret!);
          await logger.log("INFO", `[remove] Retry TOTP code: ${freshCode.slice(0, 2)}****`);

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
                await logger.log("INFO", `[remove] TOTP retry verified — URL changed after ${elapsed + TOTP_POLL_INTERVAL_MS}ms. URL: ${retryUrl}`);
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
        continue;
      }

      // Password page — detect by URL (challenge/pwd) OR by presence of password input
      // IMPORTANT: Check password BEFORE email/identifier, because password pages also
      // have a pre-filled email field at the top that would falsely match identifier check.
      const pwdInput = page.locator('input[type="password"]');
      const hasPwdInput = (await pwdInput.count()) > 0;
      if (stepUrl.includes("challenge/pwd") || hasPwdInput) {
        if (!credentials?.password) {
          throw new Error(`Google requires password to remove member ${email}, but no password configured`);
        }
        if (hasPwdInput) {
          try {
            await pwdInput.first().waitFor({ state: "visible", timeout: 10_000 });
          } catch {
            await logger.log("WARN", "[remove] Password field not visible, trying anyway");
          }
          const visiblePwd = page.locator('input[type="password"]:visible');
          if ((await visiblePwd.count()) > 0) {
            await visiblePwd.first().fill(credentials.password);
            await visiblePwd.first().press("Enter");
            await logger.log("INFO", "[remove] Password submitted for re-auth");
            await page.waitForTimeout(5000);
            await page.waitForLoadState("domcontentloaded", { timeout: 60000 });
          } else {
            await logger.log("WARN", "[remove] Password input exists but not visible after wait");
          }
        } else {
          // URL says challenge/pwd but no password input yet — wait for render
          await logger.log("INFO", "[remove] On challenge/pwd but no input yet, waiting...");
          await page.waitForTimeout(3000);
        }
        continue;
      }

      // Identifier/email page — LAST resort (only when no password/TOTP input present)
      const identifierInput = page.locator('input[type="email"]');
      if ((await identifierInput.count()) > 0) {
        await identifierInput.first().press("Enter");
        await logger.log("INFO", "[remove] Pressed Enter on identifier page");
        await page.waitForTimeout(3000);
        await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
        continue;
      }

      // Unrecognized auth page
      await logger.log("WARN", `[remove] Unrecognized auth page, waiting... URL: ${stepUrl}`);
      await page.waitForTimeout(3000);
      continue;
    }

    // ── Handle /family/remove/ confirmation page ──
    if (stepUrl.includes("family/remove/")) {
      const removeFinalBtn = page.locator(
        'button:has-text("Remove"), button:has-text("移除"), button:has-text("Confirm"), button:has-text("確認"), ' +
        'button:has-text("삭제"), button:has-text("확인"), ' +
        'button:has-text("削除"), ' +
        'button:has-text("Xóa"), button:has-text("Xác nhận")'
      );
      if ((await removeFinalBtn.count()) > 0) {
        // Use force:true to click even if the button is disabled.
        // Google may disable the button immediately after it starts processing,
        // which causes Playwright's default click to wait forever for 'enabled' state.
        await removeFinalBtn.last().click({ force: true }).catch(async () => {
          await logger.log("WARN", `[remove] Force-click on confirm button failed — removal may already be done`);
        });
        await logger.log("INFO", `[remove] Clicked confirm on /family/remove/ page`);

        // Wait for either:
        //   (a) Page navigates away from /family/remove/ (normal success), OR
        //   (b) Confirm button becomes disabled/hidden (Google processed it server-side)
        // Use 30s timeout to handle slow networks.
        const navigationDone = page.waitForURL(
          url => !url.toString().includes('/family/remove/'),
          { timeout: 30_000 }
        ).then(() => "navigated" as const);

        const buttonDisabled = (async (): Promise<"disabled"> => {
          // Poll button state every 1s for up to 30s
          for (let i = 0; i < 30; i++) {
            await page.waitForTimeout(1000);
            const count = await removeFinalBtn.count().catch(() => 0);
            if (count === 0) return "disabled"; // button removed from DOM
            const disabled = await removeFinalBtn.last().isDisabled().catch(() => true);
            if (disabled) return "disabled";
          }
          throw new Error("timeout");
        })();

        try {
          const result = await Promise.race([navigationDone, buttonDisabled]);
          if (result === "navigated") {
            await logger.log("INFO", `[remove] Page navigated away from /family/remove/ — removal confirmed`);
          } else {
            await logger.log("INFO", `[remove] Confirm button disabled/hidden — Google processed the removal`);
          }
          break; // Removal complete
        } catch {
          // Button still enabled — continue the loop for another attempt
          await logger.log("WARN", `[remove] Still on /family/remove/ page, button still enabled — retrying`);
        }
        continue;
      }
    }

    // ── Handle confirmation dialog on member detail page ──
    if (stepUrl.includes("family/member/")) {
      const confirmBtn = page.locator(CONFIRM_SELECTORS);
      const btnCount = await confirmBtn.count();
      if (btnCount > 0) {
        // Use last() to prefer dialog's confirm button over the original action button behind it.
        // Use short timeout + catch: clicking may trigger navigation to /family/remove/ which
        // can redirect to TOTP/password re-auth. If that happens, click() will throw because
        // the button element gets detached during navigation. That's fine — the main loop's
        // next iteration will detect the TOTP/password page and handle it.
        try {
          await confirmBtn.last().click({ timeout: 10_000 });
        } catch (clickErr) {
          const clickErrMsg = clickErr instanceof Error ? clickErr.message : String(clickErr);
          // Check if page already navigated (TOTP redirect, /family/remove/, etc.)
          const postClickUrl = page.url();
          if (postClickUrl !== stepUrl) {
            await logger.log("INFO",
              `[remove] Confirm click threw (likely navigation/redirect), page moved to: ${postClickUrl}. Will handle in next loop.`
            );
          } else {
            await logger.log("WARN",
              `[remove] Confirm click failed without navigation: ${clickErrMsg}`
            );
          }
        }
        await logger.log("INFO", `[remove] Clicked confirm/remove at step ${step + 1} (${btnCount} matching buttons)`);
        await page.waitForTimeout(3000);
        await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
        continue;
      }
    }


    // Nothing matched — wait and try again
    await logger.log("DEBUG", `[remove] No action matched at step ${step + 1}, waiting...`);
    await page.waitForTimeout(2000);
  }

  // Final wait for any pending navigation
  await page.waitForTimeout(2000);
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});

  // ── Post-removal verification ──
  // Navigate back to family list and confirm the member is gone.
  await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1000);
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

  // Check by email in leaf-node text
  const emailStillPresent = await page.evaluate((targetEmail: string) => {
    const leafEls = Array.from(document.querySelectorAll("*"))
      .filter((el) => el.children.length === 0);
    return leafEls.some((el) => {
      const text = (el.textContent?.trim() ?? "").toLowerCase();
      return text === targetEmail.toLowerCase();
    });
  }, email);

  // Check by GAIA ID in member links
  let gaiaStillPresent = false;
  if (credentials?.googleMemberId) {
    gaiaStillPresent = await page.evaluate((gaiaId: string) => {
      const links = document.querySelectorAll('a[href*="family/member/"]');
      return Array.from(links).some((link) => {
        const href = link.getAttribute("href") ?? "";
        return href.includes(`/g/${gaiaId}`) || href.includes(`/i/${gaiaId}`);
      });
    }, credentials.googleMemberId);
  }

  if (emailStillPresent || gaiaStillPresent) {
    await logger.log("ERROR",
      `Removal verification FAILED: ${email} still on family page ` +
      `(email=${emailStillPresent}, gaia=${gaiaStillPresent})`
    );
    throw new Error(
      `REMOVE_VERIFICATION_FAILED: Member ${email} still present on family page after removal attempt`
    );
  }

  await logger.log("INFO", `Removal verified: ${email} no longer on family page ✓`);
  return "REMOVED";
}

/**
 * Fallback member finder when GAIA ID is not available.
 * Tries S1 (email text) → S2 (displayName) → S3 (iterate all member hrefs).
 */
export async function fallbackFindMember(
  page: import("playwright").Page,
  email: string,
  displayName: string | undefined,
  logger: TaskLogger,
  knownGaiaId?: string,
  otherMemberGaiaIds?: Set<string>
): Promise<boolean> {
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 });

  // S1: email visible directly on list page (pending invites)
  const emailLocator = page.locator(`text="${email}"`);
  if ((await emailLocator.count()) > 0) {
    await logger.log("INFO", `S1: Found email text on list page, clicking`);
    await emailLocator.first().click();
    await page.waitForLoadState("domcontentloaded", { timeout: 60000 });
    return true;
  }

  // S2: displayName match (accepted members show display name)
  if (displayName) {
    await logger.log("INFO", `S2: Trying displayName "${displayName}"`);
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
        return true;
      }
      // Mismatch: displayName was ambiguous, fall through to S3
      await logger.log("WARN", `S2: displayName matched on list but detail page does not contain "${email}" — falling to S3`);
      await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    }
    await logger.log("WARN", `S2: displayName "${displayName}" not found`);
  }

  // S3: iterate all member hrefs
  await logger.log("INFO", `S3: Iterating all member links to find "${email}"`);
  const memberHrefs: string[] = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="family/member/"]');
    return Array.from(links).map((a) => (a as HTMLAnchorElement).href).filter(Boolean);
  });
  await logger.log("INFO", `S3: Found ${memberHrefs.length} member links`);

  // S3-fast: If we have a known GAIA ID, try to find matching href FIRST
  if (knownGaiaId) {
    const gaiaHref = memberHrefs.find((h) => h.includes(`/g/${knownGaiaId}`) || h.includes(`/i/${knownGaiaId}`));
    if (gaiaHref) {
      await logger.log("INFO", `S3-fast: Found href matching known GAIA ${knownGaiaId}, navigating directly`);
      await page.goto(gaiaHref, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1500);
      return true;
    }
    await logger.log("WARN", `S3-fast: Known GAIA ${knownGaiaId} not found in ${memberHrefs.length} hrefs, falling to blind iteration`);
  }

  for (let i = 0; i < memberHrefs.length; i++) {
    try {
      await page.goto(memberHrefs[i], { waitUntil: "domcontentloaded", timeout: 60000 });
      // Wait for Google Angular content to render
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1500);

      // Verify URL actually navigated to a member detail page
      const currentUrl = page.url();
      if (!currentUrl.includes("family/member/")) {
        await logger.log("WARN", `S3: Card #${i} navigation landed on unexpected URL: ${currentUrl}, skipping`);
        continue;
      }

      // Definitive manager detection: "Delete Family Group" button only appears on the manager's own page.
      // Always skip regardless of whether the email appears in body text.
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
        `S3: Card #${i} (href=${memberHrefs[i]}), target=${email}, matched=${matched}. Leaf emails: [${s3LeafEmails.join(", ")}]`
      );

      if (matched) {
        // Cross-validate: make sure this card does NOT belong to another known member
        const cardGaiaId = page.url().match(/\/g\/(\d+)/)?.[1] ?? page.url().match(/\/member\/(\d+)/)?.[1];
        if (cardGaiaId && otherMemberGaiaIds?.has(cardGaiaId)) {
          await logger.log("WARN",
            `S3: SAFETY BLOCK — Card #${i} GAIA ${cardGaiaId} belongs to ANOTHER known member. Skipping.`
          );
          continue;
        }
        await logger.log("INFO", `S3: Matched on detail page for card #${i}`);
        return true;
      }
    } catch (err) {
      await logger.log("WARN", `S3: Card #${i} error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await logger.log("WARN",
    `Member "${email}" not found on family page after checking ${memberHrefs.length} cards via S1/S2/S3 — may already be removed`
  );
  return false;
}
