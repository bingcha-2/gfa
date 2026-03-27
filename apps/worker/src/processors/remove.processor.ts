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
import { generateTOTP, totpSecondsRemaining } from "../totp";

const GOOGLE_FAMILY_URL = "https://myaccount.google.com/family/details";

export interface RemoveProcessorDeps {
  prisma: PrismaClient;
  adspower: AdsPowerClient;
  pool: BrowserPool;
  workerId: string;
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
  let originalMemberStatus: MemberStatus = MemberStatus.ACTIVE; // track for rollback

  try {
    // Look up member DB record before acquiring browser resource
    const memberRecord = await prisma.familyMember.findFirst({
      where: { familyGroupId, email: memberEmail },
      select: { googleMemberId: true, displayName: true, status: true },
    });
    if (memberRecord?.status) originalMemberStatus = memberRecord.status as MemberStatus;

    profileId = await pool.acquire(workerId);
    await logger.updateStatus("RUNNING");
    await logger.log("INFO", `Removing member ${memberEmail}`, {
      profileId, familyGroupId,
      gaiaId: memberRecord?.googleMemberId ?? "unknown",
    });

    const { debugUrl } = await adspower.openProfile(profileId);
    const page = await browser.connect(debugUrl);

    // Gmail auto-login (required every time — browser clears cache on start)
    const loginResult = await gmailLogin(page, account, logger);
    if (!loginResult.success) {
      // TRANSIENT failures (e.g. password page didn't load) → let BullMQ retry
      if (loginResult.reason === "TRANSIENT") {
        throw new Error(`Login transient failure: ${loginResult.detail}`);
      }
      await prisma.account.update({ where: { id: account.id }, data: { status: "VERIFICATION_REQUIRED" } });
      await logger.updateStatus("MANUAL_REVIEW", { code: loginResult.reason, message: loginResult.detail });
      // Throw to exit try so finally releases pool; caller should NOT retry this task
      throw new UnrecoverableError("MANUAL_REVIEW");
    }

    const beforePath = await browser.takeScreenshot(taskId, "before");
    await logger.recordScreenshot("beforeScreenshotPath", beforePath);

    await browser.navigateTo(GOOGLE_FAMILY_URL, { waitUntil: "load", timeout: 60000 });

    // Execute remove on page using gaiaId (S0) when available, falling back to S1/S2/S3
    await removeMemberOnPage(page, memberEmail, logger, {
      password: account.loginPassword ?? undefined,
      totpSecret: account.totpSecret ?? undefined,
      googleMemberId: memberRecord?.googleMemberId ?? undefined,
      displayName: memberRecord?.displayName ?? undefined,
    });

    // Update DB: mark member as removed
    await prisma.familyMember.updateMany({
      where: { familyGroupId, email: memberEmail },
      data: { status: "REMOVED", removedAt: new Date() },
    });

    // Release the slot back to the group and fix pendingInviteCount drift.
    // pendingInviteCount is incremented at GROUP_ASSIGNED time and never decremented
    // by any removal path. Use $executeRaw-style guard via a separate conditional update
    // so the counter never goes below 0.
    await prisma.familyGroup.update({
      where: { id: familyGroupId },
      data: { availableSlots: { increment: 1 } },
    });
    // Decrement memberCount (guard: never below 0)
    await prisma.familyGroup.updateMany({
      where: { id: familyGroupId, memberCount: { gt: 0 } },
      data: { memberCount: { decrement: 1 } },
    });
    // Decrement pendingInviteCount only when it is currently > 0 (prevents underflow)
    await prisma.familyGroup.updateMany({
      where: { id: familyGroupId, pendingInviteCount: { gt: 0 } },
      data: { pendingInviteCount: { decrement: 1 } },
    });

    const afterPath = await browser.takeScreenshot(taskId, "after");
    await logger.recordScreenshot("afterScreenshotPath", afterPath);

    await logger.updateStatus("SUCCESS");
    await logger.log("INFO", `Member ${memberEmail} removed successfully`);
  } catch (error) {
    // Don't overwrite MANUAL_REVIEW status and don't rollback member status
    if (error instanceof UnrecoverableError) throw error;

    const errMsg = error instanceof Error ? error.message : String(error);

    try {
      const errPath = await browser.takeScreenshot(taskId, "error");
      await logger.recordScreenshot("errorScreenshotPath", errPath);
    } catch {
      // noop
    }

    // Rollback member status to original (ACTIVE or PENDING) so removal can be retried
    await prisma.familyMember.updateMany({
      where: { familyGroupId, email: memberEmail, status: "PENDING" },
      data: { status: originalMemberStatus },
    }).catch(() => {});

    await logger.updateStatus("FAILED_RETRYABLE", {
      code: profileId ? "REMOVE_ERROR" : "PROFILE_ACQUIRE_FAILED",
      message: errMsg,
    });

    await logger.log("ERROR", `Remove error (will retry): ${errMsg}`);
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
  credentials?: { password?: string; totpSecret?: string; googleMemberId?: string; displayName?: string }
): Promise<void> {
  await page.waitForLoadState("load", { timeout: 60000 });

  const googleMemberId = credentials?.googleMemberId;
  const displayName = credentials?.displayName;

  if (googleMemberId) {
    // S0: Direct GAIA navigation
    const directUrl = `https://myaccount.google.com/family/member/g/${googleMemberId}`;
    await logger.log("INFO", `S0: Navigating directly to member page via GAIA ID ${googleMemberId}`);
    await page.goto(directUrl, { waitUntil: "load", timeout: 60000 });
    await page.waitForLoadState("load", { timeout: 60000 });
  } else {
    await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "load", timeout: 60000 });
    await fallbackFindMember(page, email, displayName, logger);
  }

  await logger.log("INFO", `On detail page for member ${email}`);
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
  ].join(", "));

  try {
    await actionButton.first().waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    // Try S0 fallback if direct nav failed to show button, or continue to throw
    if (googleMemberId) {
      await logger.log("WARN", `S0 page has no action button, falling back to list-page matching`);
      await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "load", timeout: 60000 });
      await fallbackFindMember(page, email, displayName, logger);
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
  await page.waitForLoadState("load", { timeout: 60000 });

  // Handle Google password re-authentication
  const passwordInput = page.locator('input[type="password"]');
  if ((await passwordInput.count()) > 0) {
    await logger.log("INFO", "Password verification page detected");

    if (!credentials?.password) {
      throw new Error(
        `Google requires password to remove joined member ${email}, ` +
        `but Account.loginPassword is not set`
      );
    }

    await passwordInput.first().fill(credentials.password);
    const nextButton = page.locator(
      'button:has-text("Next"), button:has-text("下一步")'
    );
    await nextButton.first().click();
    await logger.log("INFO", "Password submitted");

    await page.waitForTimeout(5000);
    await page.waitForLoadState("load", { timeout: 60000 });

    // Handle TOTP 2FA challenge
    const currentUrl = page.url();
    if (currentUrl.includes("challenge") || currentUrl.includes("signin")) {
      await logger.log("INFO", "2FA challenge detected");

      if (!credentials?.totpSecret) {
        throw new Error(
          `Google requires 2FA to remove joined member ${email}, ` +
          `but Account.totpSecret is not set`
        );
      }

      const remaining = totpSecondsRemaining();
      if (remaining < 5) {
        await logger.log("INFO", `Waiting ${remaining + 1}s for fresh TOTP code`);
        await page.waitForTimeout((remaining + 1) * 1000);
      }

      const totpCode = generateTOTP(credentials.totpSecret);
      await logger.log("INFO", `Generated TOTP code: ${totpCode.slice(0, 2)}****`);

      let totpInput = page.locator(
        'input[type="tel"], input[name="totpPin"], input[id="totpPin"], input[autocomplete="one-time-code"]'
      );

      if ((await totpInput.count()) === 0) {
        const authOption = page.locator(
          'div:has-text("Google Authenticator"), div:has-text("驗證器"), div:has-text("Authenticator")'
        );
        if ((await authOption.count()) > 0) {
          await authOption.first().click();
          await page.waitForTimeout(2000);
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
        'button:has-text("Next"), button:has-text("下一步"), button:has-text("Verify"), button:has-text("驗證")'
      );
      await verifyButton.first().click();
      await logger.log("INFO", "TOTP code submitted");

      await page.waitForTimeout(5000);
      await page.waitForLoadState("load", { timeout: 60000 });
    }

    // After password/2FA, may need to click remove again
    if (page.url().includes("family/member/")) {
      await logger.log("INFO", "Back on member detail after auth, clicking remove again");
      const removeBtn2 = page.locator([
        'button:has-text("移除")',
        'button:has-text("Remove")',
      ].join(", "));
      if ((await removeBtn2.count()) > 0) {
        await removeBtn2.first().click();
        await page.waitForTimeout(2000);
      }
    } else if (page.url().includes("family/remove/")) {
      await logger.log("INFO", "On /family/remove/ confirmation page");
    } else if (!page.url().includes("family/")) {
      await page.goto(memberDetailUrl, { waitUntil: "load", timeout: 60000 });
      const removeBtn3 = page.locator([
        'button:has-text("移除")',
        'button:has-text("Remove")',
      ].join(", "));
      if ((await removeBtn3.count()) > 0) {
        await removeBtn3.first().click();
        await page.waitForTimeout(2000);
      }
    }
  }

  // Handle confirmation dialog
  const confirmButton = page.locator([
    'a:has-text("是")',
    'button:has-text("是")',
    'a:has-text("Yes")',
    'button:has-text("Yes")',
    'a:has-text("確認")',
    'button:has-text("確認")',
    'a:has-text("Confirm")',
    'button:has-text("Confirm")',
  ].join(", "));

  if ((await confirmButton.count()) > 0) {
    await confirmButton.last().click();
    await logger.log("INFO", `Confirmed removal of ${email}`);
  } else if (page.url().includes("family/remove/")) {
    const removeFinalBtn = page.locator('button:has-text("Remove"), button:has-text("移除")');
    if ((await removeFinalBtn.count()) > 0) {
      await removeFinalBtn.last().click();
      await logger.log("INFO", `Clicked Remove on confirmation page for ${email}`);
    }
  }

  await page.waitForTimeout(3000);
  await page.waitForLoadState("load", { timeout: 60000 });
}

/**
 * Fallback member finder when GAIA ID is not available.
 * Tries S1 (email text) → S2 (displayName) → S3 (iterate all member hrefs).
 */
async function fallbackFindMember(
  page: import("playwright").Page,
  email: string,
  displayName: string | undefined,
  logger: TaskLogger
): Promise<void> {
  await page.waitForLoadState("load", { timeout: 60000 });

  // S1: email visible directly on list page (pending invites)
  const emailLocator = page.locator(`text="${email}"`);
  if ((await emailLocator.count()) > 0) {
    await logger.log("INFO", `S1: Found email text on list page, clicking`);
    await emailLocator.first().click();
    await page.waitForLoadState("load", { timeout: 60000 });
    return;
  }

  // S2: displayName match (accepted members show display name)
  if (displayName) {
    await logger.log("INFO", `S2: Trying displayName "${displayName}"`);
    const nameLocator = page.locator(`text="${displayName}"`);
    if ((await nameLocator.count()) > 0) {
      await logger.log("INFO", `S2: Found by displayName, clicking`);
      await nameLocator.first().click();
      await page.waitForLoadState("load", { timeout: 60000 });
      return;
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

  for (let i = 0; i < memberHrefs.length; i++) {
    try {
      await page.goto(memberHrefs[i], { waitUntil: "load", timeout: 60000 });
      await page.waitForTimeout(500);
      const bodyText = await page.textContent("body").catch(() => "");
      const isManager = bodyText?.includes("管理") || bodyText?.toLowerCase().includes("manager");
      if (isManager && !bodyText?.includes(email)) continue;
      if (bodyText?.includes(email)) {
        await logger.log("INFO", `S3: Matched on detail page for card #${i}`);
        return;
      }
    } catch (err) {
      await logger.log("WARN", `S3: Card #${i} error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "load", timeout: 60000 }).catch(() => {});
  throw new Error(
    `Cannot find member "${email}" on family page. ` +
    `Checked ${memberHrefs.length} cards via S1/S2/S3.`
  );
}
