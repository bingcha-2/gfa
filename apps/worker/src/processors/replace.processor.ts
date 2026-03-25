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

import { Job } from "bullmq";
import { PrismaClient } from "@prisma/client";
import type { ReplaceMemberPayload } from "@gfa/shared";

import { AdsPowerClient } from "../adspower-client";
import { ProfileLock } from "../profile-lock";
import { WorkerBrowser } from "../browser-context";
import { TaskLogger } from "../task-logger";
import { generateTOTP, totpSecondsRemaining } from "../totp";

const GOOGLE_FAMILY_URL = "https://myaccount.google.com/family/details";

export interface ReplaceProcessorDeps {
  prisma: PrismaClient;
  adspower: AdsPowerClient;
  lock: ProfileLock;
  workerId: string;
}

export async function processReplace(
  job: Job<ReplaceMemberPayload>,
  deps: ReplaceProcessorDeps
): Promise<void> {
  const { prisma, adspower, lock, workerId } = deps;
  const { orderId, familyGroupId, accountId, targetMemberEmail, newUserEmail } =
    job.data;
  const taskId = job.id ?? job.name;
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

  const profileId = account.adspowerProfileId;

  const locked = await lock.acquire(profileId, workerId);
  if (!locked) {
    await logger.updateStatus("FAILED_RETRYABLE", {
      code: "PROFILE_LOCKED",
      message: `Profile ${profileId} is locked by another worker`,
    });
    throw new Error(`Profile ${profileId} locked — will retry`);
  }

  try {
    await logger.updateStatus("RUNNING");
    await logger.log("INFO", `Replacing ${targetMemberEmail} → ${newUserEmail}`, {
      profileId,
      familyGroupId,
    });

    const { debugUrl } = await adspower.openProfile(profileId);
    const page = await browser.connect(debugUrl);

    const beforePath = await browser.takeScreenshot(taskId, "before");
    await logger.recordScreenshot("beforeScreenshotPath", beforePath);

    await browser.navigateTo(GOOGLE_FAMILY_URL, { waitUntil: "networkidle" });

    // Step 1: Remove the target member on page
    await removeMemberOnPage(page, targetMemberEmail, logger, {
      password: account.loginPassword ?? undefined,
      totpSecret: account.totpSecret ?? undefined,
    });

    // Step 2: Invite the new member on page
    await inviteMemberOnPage(page, newUserEmail, logger);

    // Both page operations succeeded — now update DB
    await prisma.familyMember.updateMany({
      where: { familyGroupId, email: targetMemberEmail },
      data: { status: "REMOVED", removedAt: new Date() },
    });

    const afterPath = await browser.takeScreenshot(taskId, "after");
    await logger.recordScreenshot("afterScreenshotPath", afterPath);

    await logger.updateStatus("REPLACED_AND_INVITE_SENT");

    if (orderId) {
      await logger.updateOrderStatus(
        orderId,
        "INVITE_SENT",
        `Replaced ${targetMemberEmail} with ${newUserEmail}`
      );
    }

    await logger.log("INFO", "Replace completed successfully");
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);

    try {
      const errPath = await browser.takeScreenshot(taskId, "error");
      await logger.recordScreenshot("errorScreenshotPath", errPath);
    } catch {
      // noop
    }

    await logger.updateStatus("FAILED_RETRYABLE", {
      code: "REPLACE_ERROR",
      message: errMsg,
    });

    // Don't mark order FAILED here — BullMQ will retry
    await logger.log("ERROR", `Replace error (will retry): ${errMsg}`);

    throw error;
  } finally {
    await browser.disconnect().catch(() => {});
    await adspower.closeProfile(profileId).catch(() => {});
    await lock.release(profileId, workerId).catch(() => {});
  }
}

/**
 * Remove a family member on the Google Family page.
 *
 * Calibrated from real DOM: members are listed as <a class="umngff" href="family/member/...">.
 * Each member card has displayName in div.IlKlLe.
 * Clicking the member navigates to detail page where the remove button is:
 * - "取消邀請" (cancel invite) for pending members
 * - "移除成員" / "從家庭群組中移除" for joined members
 */
async function removeMemberOnPage(
  page: import("playwright").Page,
  email: string,
  logger: TaskLogger,
  credentials?: { password?: string; totpSecret?: string }
): Promise<void> {
  await page.waitForLoadState("networkidle");

  // On the family details page, members are listed as <a class="umngff" href="family/member/...">
  const emailOnPage = page.locator(`text="${email}"`);

  if ((await emailOnPage.count()) > 0) {
    await emailOnPage.first().click();
  } else {
    // Click through each member card to find the matching non-admin member
    const memberLinks = page.locator('a.umngff[href*="family/member/"]');
    const count = await memberLinks.count();
    let found = false;

    for (let i = 0; i < count; i++) {
      const link = memberLinks.nth(i);
      const roleText = await link.locator(".ImPZoc").textContent();
      if (
        roleText?.includes("管理員") ||
        roleText?.toLowerCase().includes("manager")
      ) {
        continue;
      }

      await link.click();
      await page.waitForLoadState("networkidle");
      found = true;
      break;
    }

    if (!found) {
      throw new Error(`Could not find non-admin member to remove for ${email}`);
    }
  }

  await logger.log("INFO", `Found member ${email} on detail page`);
  // Save the member detail URL for potential re-navigation after password auth
  const memberDetailUrl = page.url();
  await page.waitForTimeout(1000);

  // Look for remove/cancel-invite button on the member detail page
  const removeButton = page.locator([
    'button:has-text("移除")',
    'button:has-text("取消邀請")',
    'button:has-text("Remove member")',
    'button:has-text("Cancel invitation")',
    'button:has-text("Remove")',
  ].join(", "));

  if ((await removeButton.count()) === 0) {
    throw new Error(`Cannot find remove/cancel button for member ${email}`);
  }

  await removeButton.first().click();
  await logger.log("INFO", `Clicked remove/cancel for ${email}`);

  // Wait for potential password page or confirmation dialog
  await page.waitForTimeout(3000);
  await page.waitForLoadState("networkidle");

  // --- Handle Google password re-authentication ---
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
    await page.waitForLoadState("networkidle");

    // --- Handle TOTP 2FA challenge ---
    const currentUrl = page.url();
    if (currentUrl.includes("challenge") || currentUrl.includes("signin")) {
      await logger.log("INFO", "2FA challenge detected");

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

      const totpCode = generateTOTP(credentials.totpSecret);
      await logger.log("INFO", `Generated TOTP code: ${totpCode.slice(0, 2)}****`);

      // Google TOTP input field
      let totpInput = page.locator(
        'input[type="tel"], input[name="totpPin"], input[id="totpPin"], input[autocomplete="one-time-code"]'
      );

      if ((await totpInput.count()) === 0) {
        // May need to select "Google Authenticator" option first
        const authOption = page.locator(
          'div:has-text("Google Authenticator"), div:has-text("驗證器"), div:has-text("Authenticator")'
        );
        if ((await authOption.count()) > 0) {
          await authOption.first().click();
          await page.waitForTimeout(2000);
        }

        // Retry finding input
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
      await page.waitForLoadState("networkidle");
    }

    // After password/2FA, Google may redirect back to member detail page
    // We need to click remove again now that we're authenticated
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
      // Redirected to /family/remove/ confirmation page after password auth
      await logger.log("INFO", "On /family/remove/ confirmation page");
      // The Remove button is on this page — will be handled below
    } else if (!page.url().includes("family/")) {
      // Redirected elsewhere — navigate back to member detail
      await page.goto(memberDetailUrl, { waitUntil: "networkidle", timeout: 30000 });
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
    'a:has-text("Confirm")',
    'button:has-text("Confirm")',
  ].join(", "));

  if ((await confirmButton.count()) > 0) {
    await confirmButton.last().click();
    await logger.log("INFO", `Confirmed removal of ${email}`);
  } else if (page.url().includes("family/remove/")) {
    // On /family/remove/ confirmation page — click the primary "Remove" button
    const removeFinalBtn = page.locator('button:has-text("Remove"), button:has-text("移除")');
    if ((await removeFinalBtn.count()) > 0) {
      await removeFinalBtn.last().click(); // last() = primary blue button
      await logger.log("INFO", `Clicked Remove on confirmation page for ${email}`);
    }
  }

  await page.waitForTimeout(3000);
  await page.waitForLoadState("networkidle");
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
  // Navigate back to family details if not already there
  if (!page.url().includes("/family/details")) {
    await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "networkidle" });
  }

  // Click invite link: <a href="family/invitemembers">
  const inviteLink = page.locator('a[href*="invitemembers"]');

  if ((await inviteLink.count()) === 0) {
    throw new Error("Cannot find invite link on family page");
  }

  await inviteLink.first().click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2000);

  // Email input
  const emailInput = page.locator('input.I4p4db, input[placeholder*="電子郵件"], input[placeholder*="email" i]');
  if ((await emailInput.count()) === 0) {
    throw new Error("Cannot find email input field");
  }

  await emailInput.first().fill(email);
  await logger.log("INFO", `Filled email: ${email}`);

  await page.waitForTimeout(1500);
  await emailInput.first().press("Enter");
  await page.waitForTimeout(1000);

  // Send button
  const sendButton = page.locator(
    'button:has-text("傳送"), button:has-text("Send"), button:has-text("发送")'
  );
  if ((await sendButton.count()) === 0) {
    throw new Error("Cannot find send button");
  }

  await sendButton.first().click();
  await logger.log("INFO", `Sent invite to ${email}`);
  await page.waitForTimeout(3000);
  await page.waitForLoadState("networkidle");
}
