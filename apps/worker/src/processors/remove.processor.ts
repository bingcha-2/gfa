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
import { isReAuthPage, handleReAuth } from "../handle-reauth";
import { checkTransferBatchProgress } from "../check-transfer-progress";
import { Queue } from "bullmq";
import { postTaskSync } from "../post-task-sync";

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
    await logger.updateStatus("FAILED_FINAL", { code: "ACCOUNT_NOT_FOUND", message: `Account not found` });
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
      await logger.log("INFO", `Member ${memberEmail} is already REMOVED in DB — skipping removal`);
      await logger.updateStatus("SUCCESS", {
        code: "ALREADY_REMOVED",
        message: `Member ${memberEmail} was already removed`,
      });
      return;
    }

    // Cooldown guard: skip immediately if this account recently failed login
    if (!job.data.ignoreCooldown) {
      const cooldownSecs = await pool.isLoginCoolingDown(account.id);
      if (cooldownSecs > 0) {
        await logger.log("WARN", `[remove] Account ${account.id} in login cooldown (${cooldownSecs}s remaining), skipping`);
        await logger.updateStatus("FAILED_RETRYABLE", { code: "LOGIN_COOLDOWN", message: `Account in cooldown for ${cooldownSecs}s` });
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
    await removeMemberOnPage(page, memberEmail, logger, {
      loginEmail: account.loginEmail ?? undefined,
      password: account.loginPassword ?? undefined,
      totpSecret: account.totpSecret ?? undefined,
      googleMemberId: memberRecord?.googleMemberId ?? undefined,
      displayName: memberRecord?.displayName ?? undefined,
    }, otherGaiaIds);

    // ── Post-removal sync ──
    // Reuse the shared postTaskSync which handles: dedup, reconcile, slot
    // calculation — all in one consistent path.
    const syncOk = await postTaskSync(page, prisma, familyGroupId, account.loginEmail ?? "", logger);

    if (!syncOk) {
      // postTaskSync failed silently — apply manual fallback so slots stay accurate
      await logger.log("WARN", "Post-removal sync failed, applying manual DB fallback");
      await prisma.familyMember.updateMany({
        where: { familyGroupId, email: memberEmail },
        data: { status: "REMOVED", removedAt: new Date() },
      });
      await prisma.familyGroup.update({
        where: { id: familyGroupId },
        data: { availableSlots: { increment: 1 } },
      });
      await prisma.familyGroup.updateMany({
        where: { id: familyGroupId, memberCount: { gt: 0 } },
        data: { memberCount: { decrement: 1 } },
      });
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
    // Find orders tied to this member email in this family group and mark them.
    try {
      const relatedOrder = await prisma.order.findFirst({
        where: {
          userEmail: memberEmail,
          familyGroupId,
          status: { notIn: ["FAILED", "CREATED", "EXPIRED"] },
        },
        select: { id: true },
      });
      if (relatedOrder) {
        await prisma.order.update({
          where: { id: relatedOrder.id },
          data: { status: "EXPIRED", resultMessage: `Member ${memberEmail} removed from family group` },
        });
        await logger.log("INFO", `Updated Order ${relatedOrder.id} status to MEMBER_REMOVED`);
      }
    } catch (orderErr) {
      // Non-fatal: member removal itself succeeded
      await logger.log("WARN", `Failed to sync Order status after removal: ${orderErr instanceof Error ? orderErr.message : String(orderErr)}`);
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

    await logger.log("ERROR", `Remove error (will retry): ${errMsg}`);

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
async function removeMemberOnPage(
  page: import("playwright").Page,
  email: string,
  logger: TaskLogger,
  credentials?: { loginEmail?: string; password?: string; totpSecret?: string; googleMemberId?: string; displayName?: string },
  otherMemberGaiaIds?: Set<string>
): Promise<void> {
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
        await fallbackFindMember(page, email, displayName, logger, googleMemberId, otherMemberGaiaIds);
      }
    } else {
      await logger.log("WARN", `S0: No action button found, falling back to list page matching`);
      // Clear SPA state before fallback
      await page.goto("about:blank", { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      await fallbackFindMember(page, email, displayName, logger, googleMemberId, otherMemberGaiaIds);
    }
  } else {
    await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await fallbackFindMember(page, email, displayName, logger, undefined, otherMemberGaiaIds);
  }

  await logger.log("INFO", `On detail page for member ${email}`);

  // Safety net: detect if we accidentally landed on the family manager's page.
  // The manager page shows "Delete Family Group" instead of "Remove member".
  const deleteGroupBtn = page.locator(
    'button:has-text("Delete Family Group"), button:has-text("删除家庭群组"), button:has-text("刪除家庭群組"), ' +
    'button:has-text("가족 그룹 삭제"), button:has-text("ファミリーグループを削除"), button:has-text("Xóa nhóm gia đình")'
  );
  if ((await deleteGroupBtn.count()) > 0) {
    await logger.log("WARN", `Landed on manager page (Delete Family Group detected) — falling back to list page`);
    await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await fallbackFindMember(page, email, displayName, logger, googleMemberId, otherMemberGaiaIds);
    await logger.log("INFO", `After fallback, now on: ${page.url()}`);
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
    if (isReAuthPage(stepUrl)) {
      await logger.log("INFO", `[remove] Re-auth at step ${step + 1}: ${stepUrl}`);
      const handled = await handleReAuth(page, {
        loginEmail: credentials?.loginEmail,
        password: credentials?.password,
        totpSecret: credentials?.totpSecret,
      }, logger, "[remove]");
      if (!handled) {
        const stillAuthUrl = page.url();
        if (isReAuthPage(stillAuthUrl)) {
          // Don't throw here — Google may still be redirecting (ServiceLogin,
          // webreauth, signin/identifier are transitional). Wait for the page
          // to settle and let the outer 10-step loop retry on the next iteration.
          await logger.log("WARN", `[remove] Re-auth page not yet handled — waiting for page to settle. URL: ${stillAuthUrl}`);
          await page.waitForTimeout(3000);
        } else {
          await logger.log("WARN", `[remove] Auth page resolved without explicit handling, continuing. URL: ${stillAuthUrl}`);
        }
      }
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
        // Check if button is disabled (already clicked / Google is processing)
        const isDisabled = await removeFinalBtn.last().isDisabled().catch(() => false);
        if (isDisabled) {
          await logger.log("INFO", `[remove] Confirm button is disabled (processing), waiting for navigation...`);
          try {
            await page.waitForURL((url) => !url.toString().includes("family/remove/"), { timeout: 30_000 });
            await logger.log("INFO", `[remove] Navigated away from /family/remove/ after processing`);
          } catch {
            await logger.log("WARN", `[remove] Timed out waiting for navigation from /family/remove/ — proceeding`);
          }
          await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
          continue;
        }

        await removeFinalBtn.last().click();
        await logger.log("INFO", `[remove] Clicked confirm on /family/remove/ page`);
        // Wait for URL to change instead of a fixed wait — Google may take a few seconds to process
        try {
          await page.waitForURL((url) => !url.toString().includes("family/remove/"), { timeout: 15_000 });
          await logger.log("INFO", `[remove] Navigated away from /family/remove/ after confirm click`);
        } catch {
          await logger.log("WARN", `[remove] Still on /family/remove/ after confirm click, will retry in loop`);
          await page.waitForTimeout(3000);
        }
        await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
        continue;
      }
    }

    // ── Handle confirmation dialog on member detail page ──
    if (stepUrl.includes("family/member/")) {
      const confirmBtn = page.locator(CONFIRM_SELECTORS);
      const btnCount = await confirmBtn.count();
      if (btnCount > 0) {
        // Use last() to prefer dialog's confirm button over the original action button behind it
        await confirmBtn.last().click();
        await logger.log("INFO", `[remove] Clicked confirm/remove at step ${step + 1} (${btnCount} matching buttons)`);
        await page.waitForTimeout(3000);
        await page.waitForLoadState("domcontentloaded", { timeout: 60000 });
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
}

/**
 * Fallback member finder when GAIA ID is not available.
 * Tries S1 (email text) → S2 (displayName) → S3 (iterate all member hrefs).
 */
async function fallbackFindMember(
  page: import("playwright").Page,
  email: string,
  displayName: string | undefined,
  logger: TaskLogger,
  knownGaiaId?: string,
  otherMemberGaiaIds?: Set<string>
): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 });

  // S1: email visible directly on list page (pending invites)
  const emailLocator = page.locator(`text="${email}"`);
  if ((await emailLocator.count()) > 0) {
    await logger.log("INFO", `S1: Found email text on list page, clicking`);
    await emailLocator.first().click();
    await page.waitForLoadState("domcontentloaded", { timeout: 60000 });
    return;
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
        return;
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
      return;
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
        const cardGaiaId = page.url().match(/\/g\/(\d+)/)?.[1] ?? page.url().match(/\/i\/([-\d]+)/)?.[1] ?? page.url().match(/\/member\/([-\d]+)/)?.[1];
        if (cardGaiaId && otherMemberGaiaIds?.has(cardGaiaId)) {
          await logger.log("WARN",
            `S3: SAFETY BLOCK — Card #${i} GAIA ${cardGaiaId} belongs to ANOTHER known member. Skipping.`
          );
          continue;
        }
        await logger.log("INFO", `S3: Matched on detail page for card #${i}`);
        return;
      }
    } catch (err) {
      await logger.log("WARN", `S3: Card #${i} error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  throw new Error(
    `Cannot find member "${email}" on family page. ` +
    `Checked ${memberHrefs.length} cards via S1/S2/S3.`
  );
}
