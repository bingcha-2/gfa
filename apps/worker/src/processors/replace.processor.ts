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

import { Job, UnrecoverableError } from "bullmq";
import { PrismaClient } from "@prisma/client";
import type { ReplaceMemberPayload } from "@gfa/shared";

import { AdsPowerClient } from "../adspower-client";
import { BrowserPool } from "../browser-pool";
import { WorkerBrowser } from "../browser-context";
import { TaskLogger } from "../task-logger";
import { gmailLogin } from "../gmail-login";
import { handleLoginResult } from "../handle-login-result";
import { generateTOTP, totpSecondsRemaining } from "../totp";

const GOOGLE_FAMILY_URL = "https://myaccount.google.com/family/details?hl=en";

export interface ReplaceProcessorDeps {
  prisma: PrismaClient;
  adspower: AdsPowerClient;
  pool: BrowserPool;
  workerId: string;
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
      message: `Account ${accountId} not found`,
    });
    return;
  }

  let profileId: string | null = null;
  let reuseSession = false;

  try {
    // ── Pre-check: if account is in cooldown, has too many failures, or is unhealthy → fail fast ──
    const cooldownSecs = await pool.isLoginCoolingDown(accountId);
    const priorFailures = await pool.getAccountTaskFailureCount(accountId);
    if (cooldownSecs > 0 || priorFailures >= 3 || account.status !== "HEALTHY") {
      await logger.log("WARN",
        `[replace] Account ${accountId} unavailable (cooldown=${cooldownSecs}s, failures=${priorFailures}, status=${account.status}). ` +
        `Replace tasks require the group's own account — cannot switch. Failing task.`
      );
      await logger.updateStatus("FAILED_RETRYABLE", {
        code: "ACCOUNT_UNAVAILABLE",
        message: `Account in cooldown/unhealthy (failures=${priorFailures}, status=${account.status})`,
      });
      throw new UnrecoverableError(`ACCOUNT_UNAVAILABLE: cooldown=${cooldownSecs}s, failures=${priorFailures}`);
    }

    // Try up to poolSize profiles: if AdsPower rejects one (stale/occupied),
    // release it and immediately acquire the next free profile.
    let debugUrl: string | undefined;
    const maxProfileAttempts = pool.poolSize;
    const failedProfiles = new Set<string>();
    for (let profileAttempt = 1; profileAttempt <= maxProfileAttempts; profileAttempt++) {
      profileId = await pool.acquireExcluding(workerId, failedProfiles);
      await logger.log("INFO", `Replacing ${targetMemberEmail} → ${newUserEmail} (profile attempt ${profileAttempt}/${maxProfileAttempts})`, {
        profileId, familyGroupId,
      });
      try {
        debugUrl = (await adspower.openProfile(profileId)).debugUrl;
        break;
      } catch (profileErr) {
        const profileErrMsg = profileErr instanceof Error ? profileErr.message : String(profileErr);
        await logger.log("WARN", `Profile ${profileId} unavailable, switching to next: ${profileErrMsg}`);
        failedProfiles.add(profileId!);
        await adspower.closeProfile(profileId!).catch(() => {});
        await pool.release(profileId!, workerId).catch(() => {});
        profileId = null;
        if (profileAttempt === maxProfileAttempts) {
          throw new Error(`All ${maxProfileAttempts} profiles unavailable: ${profileErrMsg}`);
        }
      }
    }

    const lastAccount = await pool.getLastAccount(profileId!);
    reuseSession = lastAccount === accountId;
    await logger.updateStatus("RUNNING");

    const page = await browser.connect(debugUrl!, reuseSession);

    // Gmail auto-login
    const loginResult = await gmailLogin(page, account, logger);
    if (!loginResult.success) {
      // Record failure before handleLoginResult throws
      // handleLoginResult will also record, but we want to ensure it happens
      await handleLoginResult(loginResult, { job, pool, prisma, logger, accountId });
    }
    // Record which account is now logged into this profile
    await pool.setLastAccount(profileId!, accountId);
    const beforePath = await browser.takeScreenshot(taskId, "before");
    await logger.recordScreenshot("beforeScreenshotPath", beforePath);

    await browser.navigateTo(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Look up the member's googleMemberId and displayName from DB
    const memberRecord = await prisma.familyMember.findFirst({
      where: { familyGroupId, email: targetMemberEmail },
      select: { id: true, displayName: true, googleMemberId: true, status: true }
    });
    const targetDisplayName = memberRecord?.displayName ?? undefined;
    const targetGaiaId = memberRecord?.googleMemberId ?? undefined;

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
    if (memberRecord?.status === "REMOVED") {
      await logger.log("INFO", `Target member ${targetMemberEmail} already REMOVED in DB — skipping Step 1 (remove)`);
      skipRemove = true;
    }

    let discoveredGaiaId: string | undefined;
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
          await logger.log("WARN",
            `Member ${targetMemberEmail} not found on page. Verifying if slot is available...`
          );
          
          await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
          await page.waitForTimeout(2000);
          
          const inviteLinkCount = await page.locator('a[href*="invitemembers"]').count();
          if (inviteLinkCount > 0) {
            await logger.log("INFO", "Invite slot is available. Proceeding to invite.");
          } else {
            throw new Error(`Cannot find member and no invite slots available (当前识别失败且无可用空位)`);
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

    // Step 2: Always navigate back to family details before inviting.
    // removeMemberOnPage may leave the page on /family/remove/ or /family/member/ path.
    await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    // Wait a few seconds for Google to reflect the slot becoming available
    await page.waitForTimeout(3000);
    await logger.log("INFO", `Back on family details, now inviting ${newUserEmail}`);

    // Step 3: Invite the new member on page
    await inviteMemberOnPage(page, newUserEmail, logger);

    // --- Verify invite by checking new member appears on family page ---
    let newMemberGaiaId: string | undefined;
    try {
      if (!page.url().includes("family/details")) {
        await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      }
      await page.waitForTimeout(2000);
      newMemberGaiaId = await scanPageForMemberGaiaId(page, newUserEmail);
      if (newMemberGaiaId) {
        await logger.log("INFO", `Verified invite: found ${newUserEmail} on family page (gaiaId=${newMemberGaiaId})`);
      } else {
        // New member not found — invite may have silently failed
        await logger.log("ERROR", `Post-invite verification failed: ${newUserEmail} not found on family page`);
        throw new Error(
          `Invite verification failed: ${newUserEmail} not found on family page after invite — ` +
          `Google may have rejected the invite silently`
        );
      }
    } catch (err: any) {
      if (err.message?.includes("Invite verification failed")) throw err;
      await logger.log("WARN", `gaiaId capture error for new member (non-fatal): ${err.message}`);
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

      // Upsert placeholder for newly invited member (sync may have already created a PENDING record)
      await tx.familyMember.upsert({
        where: { familyGroupId_email: { familyGroupId, email: newUserEmail } },
        update: {
          status: "PENDING",
          displayName: newUserEmail.split("@")[0],
          ...(newMemberGaiaId ? { googleMemberId: newMemberGaiaId } : {}),
        },
        create: {
          familyGroupId,
          email: newUserEmail,
          displayName: newUserEmail.split("@")[0],
          role: "member",
          status: "PENDING",
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

    const afterPath = await browser.takeScreenshot(taskId, "after");
    await logger.recordScreenshot("afterScreenshotPath", afterPath);

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

    await logger.log("INFO", "Replace completed successfully");
  } catch (error) {
    // Don't overwrite MANUAL_REVIEW status if login challenge was detected
    if (error instanceof UnrecoverableError) throw error;

    const errMsg = error instanceof Error ? error.message : String(error);

    try {
      const errPath = await browser.takeScreenshot(taskId, "error");
      await logger.recordScreenshot("errorScreenshotPath", errPath);
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
      }

      await logger.log("ERROR", `Replace failed permanently: ${errMsg}`);
      throw new UnrecoverableError(errMsg);
    }

    await logger.updateStatus("FAILED_RETRYABLE", {
      code: profileId ? "REPLACE_ERROR" : "PROFILE_ACQUIRE_FAILED",
      message: errMsg,
    });

    // Don't mark order FAILED here — BullMQ will retry
    await logger.log("ERROR", `Replace error (will retry): ${errMsg}`);

    throw error;
  } finally {
    await browser.disconnect().catch(() => {});
    if (profileId) {
      await adspower.closeProfile(profileId).catch(() => {});
      await pool.release(profileId, workerId).catch(() => {});
    }
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
  const deleteGroupBtn = page.locator(
    'button:has-text("Delete Family Group"), button:has-text("删除家庭群组"), button:has-text("刪除家庭群組"), ' +
    'button:has-text("가족 그룹 삭제"), button:has-text("ファミリーグループを削除"), button:has-text("Xóa nhóm gia đình")'
  );
  if ((await deleteGroupBtn.count()) > 0) {
    await logger.log("WARN", `Landed on manager page (Delete Family Group detected) — falling back to list page`);
    await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    discoveredGaiaId = await fallbackFindMember(page, email, displayName, logger, googleMemberId, otherMemberGaiaIds);
    await logger.log("INFO", `After fallback, now on: ${page.url()}`);
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

  // Wait for potential redirect to re-auth page or confirmation dialog
  await page.waitForTimeout(3000);
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 });

  // --- Handle Google re-authentication (password and/or TOTP) ---
  // After clicking Remove for an ACTIVE member, Google may redirect to
  // accounts.google.com for re-authentication. Possible landing pages:
  //   a) Identifier page (email pre-filled, need to click Next)
  //   b) Password page directly
  //   c) TOTP challenge page directly (Google may skip password if recently verified)
  const postClickUrl = page.url();
  const needsReAuth = postClickUrl.includes("accounts.google.com") ||
                       postClickUrl.includes("signin") ||
                       postClickUrl.includes("challenge");

  if (needsReAuth) {
    await logger.log("INFO", `Re-auth required. URL: ${postClickUrl}`);

    // Step 1: Handle identifier page (email pre-filled, click Next)
    const identifierInput = page.locator('input[type="email"]');
    if ((await identifierInput.count()) > 0) {
      await logger.log("INFO", "On identifier page, clicking Next");
      const nextBtn = page.locator('button:has-text("Next"), button:has-text("下一步"), button:has-text("繼續"), button:has-text("继续")');
      if ((await nextBtn.count()) > 0) {
        await nextBtn.first().click();
        await page.waitForTimeout(3000);
        await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
      }
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
        const nextButton = page.locator('button:has-text("Next"), button:has-text("下一步")');
        await nextButton.first().click();
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
          const nextButton = page.locator('button:has-text("Next"), button:has-text("下一步")');
          await nextButton.first().click();
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

      // Wait for fresh TOTP code if current one is about to expire
      const remaining = totpSecondsRemaining();
      if (remaining < 5) {
        await logger.log("INFO", `Waiting ${remaining + 1}s for fresh TOTP code`);
        await page.waitForTimeout((remaining + 1) * 1000);
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
      const verifyButton = page.locator(
        'button:has-text("Next"), button:has-text("下一步"), button:has-text("Verify"), button:has-text("驗證"), button:has-text("验证")'
      );
      await verifyButton.first().click();
      await logger.log("INFO", "TOTP code submitted");

      await page.waitForTimeout(5000);
      await page.waitForLoadState("domcontentloaded", { timeout: 60000 });

      // Verify we actually left the TOTP challenge page
      // If still stuck, retry with a fresh TOTP code (first one may have expired)
      for (let totpRetry = 0; totpRetry < 2; totpRetry++) {
        const postTotpUrl = page.url();
        const stillOnChallenge = postTotpUrl.includes("challenge/totp") ||
          postTotpUrl.includes("challenge/az") ||
          (postTotpUrl.includes("accounts.google.com") && postTotpUrl.includes("challenge"));

        if (!stillOnChallenge) break; // Successfully passed TOTP

        if (totpRetry === 0) {
          await logger.log("WARN", `Still on TOTP page after submission, retrying with fresh code. URL: ${postTotpUrl}`);
          // Wait for a fresh TOTP window
          const retryRemaining = totpSecondsRemaining();
          if (retryRemaining < 8) {
            await page.waitForTimeout((retryRemaining + 1) * 1000);
          }
          const freshCode = generateTOTP(credentials!.totpSecret!, credentials!.loginEmail);
          await logger.log("INFO", `Retry TOTP code: ${freshCode.slice(0, 2)}****`);

          const retryInput = page.locator(
            'input[type="tel"], input[name="totpPin"], input[id="totpPin"], input[autocomplete="one-time-code"]'
          );
          if ((await retryInput.count()) > 0) {
            await retryInput.first().fill("");
            await page.waitForTimeout(300);
            await retryInput.first().fill(freshCode);
            const retryBtn = page.locator(
              'button:has-text("Next"), button:has-text("下一步"), button:has-text("Verify"), button:has-text("驗證"), button:has-text("验证")'
            );
            if ((await retryBtn.count()) > 0) {
              await retryBtn.first().click();
              await page.waitForTimeout(5000);
              await page.waitForLoadState("domcontentloaded", { timeout: 60000 });
            }
          }
        } else {
          throw new Error(
            `TOTP verification failed after retry — still on challenge page. URL: ${postTotpUrl}`
          );
        }
      }
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
    }
  }

  await page.waitForTimeout(3000);
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 });

  return discoveredGaiaId;
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
  return url.match(/\/g\/(\d+)/)?.[1] ?? url.match(/\/member\/(\d+)/)?.[1];
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

  // Navigate back to family page for error screenshot
  await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});

  throw new Error(
    `Cannot find member "${email}" on family page. ` +
    `Checked ${memberHrefs.length} cards via S1/S2/S3. Member may have left or DB is out of sync.`
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
  logger: TaskLogger
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
  await page.waitForTimeout(3000);
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 });

  // Check for Google error messages after sending
  // Google shows inline errors like "can't be invited", "already a member", etc.
  const errorSelectors = [
    'div[role="alert"]',
    'div.GQ8Pzc',  // Google's error message container
    'div.o6cuMc',  // Another error container
    'span.k1V3Ic',  // Error text span
    'div[aria-live="assertive"]',
  ];
  for (const sel of errorSelectors) {
    const errEl = page.locator(sel);
    if ((await errEl.count()) > 0) {
      const errText = (await errEl.first().textContent())?.trim();
      if (errText && errText.length > 3) {
        // Only treat as error if it looks like an actual error message
        const isError = /can'?t|error|fail|unable|already|invalid|不能|无法|已经|錯誤|错误/i.test(errText);
        if (isError) {
          throw new Error(`Google invite error for ${email}: "${errText}"`);
        }
      }
    }
  }

  // Verify we navigated away from the invite page
  // If still on invitemembers page, the invite likely failed silently
  const postSendUrl = page.url();
  if (postSendUrl.includes("invitemembers")) {
    // Still on invite page — try to capture any visible error text
    const bodyText = await page.locator("body").textContent().catch(() => "");
    const snippet = bodyText?.substring(0, 500) || "";
    throw new Error(`Invite may have failed — still on invite page after send. URL: ${postSendUrl}. Page snippet: ${snippet.substring(0, 200)}`);
  }

  await logger.log("INFO", `Sent invite to ${email}`);
}

/**
 * Scan the family details page for a member card matching the given email.
 * Returns the gaiaId extracted from the card's href, or undefined.
 */
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
