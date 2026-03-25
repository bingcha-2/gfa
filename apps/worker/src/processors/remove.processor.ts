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

import { Job } from "bullmq";
import { PrismaClient } from "@prisma/client";
import type { RemoveMemberPayload } from "@gfa/shared";

import { AdsPowerClient } from "../adspower-client";
import { ProfileLock } from "../profile-lock";
import { WorkerBrowser } from "../browser-context";
import { TaskLogger } from "../task-logger";
import { generateTOTP, totpSecondsRemaining } from "../totp";

const GOOGLE_FAMILY_URL = "https://myaccount.google.com/family/details";

export interface RemoveProcessorDeps {
  prisma: PrismaClient;
  adspower: AdsPowerClient;
  lock: ProfileLock;
  workerId: string;
}

export async function processRemove(
  job: Job<RemoveMemberPayload & { taskId: string }>,
  deps: RemoveProcessorDeps
): Promise<void> {
  const { prisma, adspower, lock, workerId } = deps;
  const { familyGroupId, accountId, memberEmail } = job.data;
  const taskId = job.data.taskId ?? job.id ?? job.name;
  if (!taskId) {
    console.error(`[worker:${workerId}] remove job has no id, skipping`);
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
    await logger.log("INFO", `Removing member ${memberEmail}`, {
      profileId,
      familyGroupId,
    });

    const { debugUrl } = await adspower.openProfile(profileId);
    const page = await browser.connect(debugUrl);

    const beforePath = await browser.takeScreenshot(taskId, "before");
    await logger.recordScreenshot("beforeScreenshotPath", beforePath);

    await browser.navigateTo(GOOGLE_FAMILY_URL, { waitUntil: "networkidle" });

    // Execute remove on page
    await removeMemberOnPage(page, memberEmail, logger, {
      password: account.loginPassword ?? undefined,
      totpSecret: account.totpSecret ?? undefined,
    });

    // Update DB: mark member as removed
    await prisma.familyMember.updateMany({
      where: { familyGroupId, email: memberEmail },
      data: { status: "REMOVED", removedAt: new Date() },
    });

    // Increment available slots
    await prisma.familyGroup.update({
      where: { id: familyGroupId },
      data: { availableSlots: { increment: 1 } },
    });

    const afterPath = await browser.takeScreenshot(taskId, "after");
    await logger.recordScreenshot("afterScreenshotPath", afterPath);

    await logger.updateStatus("SUCCESS");
    await logger.log("INFO", `Member ${memberEmail} removed successfully`);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);

    try {
      const errPath = await browser.takeScreenshot(taskId, "error");
      await logger.recordScreenshot("errorScreenshotPath", errPath);
    } catch {
      // noop
    }

    // Rollback member status from PENDING to ACTIVE so removal can be retried
    await prisma.familyMember.updateMany({
      where: { familyGroupId, email: memberEmail, status: "PENDING" },
      data: { status: "ACTIVE" },
    }).catch(() => {});

    await logger.updateStatus("FAILED_RETRYABLE", {
      code: "REMOVE_ERROR",
      message: errMsg,
    });

    await logger.log("ERROR", `Remove error (will retry): ${errMsg}`);
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
 * Handles password re-authentication and TOTP 2FA if triggered by Google.
 * Selectors calibrated from real Google Family UI (EN + ZH-TW).
 */
async function removeMemberOnPage(
  page: import("playwright").Page,
  email: string,
  logger: TaskLogger,
  credentials?: { password?: string; totpSecret?: string }
): Promise<void> {
  await page.waitForLoadState("networkidle");

  // Find the member on the family details page by email text
  const emailOnPage = page.locator(`text="${email}"`);

  if ((await emailOnPage.count()) > 0) {
    await emailOnPage.first().click();
  } else {
    // Email text not found — do NOT fall back to clicking other members.
    // This prevents accidentally removing the wrong person.
    throw new Error(
      `Target member email "${email}" not found on family details page. ` +
      `The member may have already been removed, or the page structure has changed.`
    );
  }

  await logger.log("INFO", `Found member ${email} on detail page`);
  const memberDetailUrl = page.url();
  await page.waitForTimeout(1000);

  // Click remove/cancel-invite button
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

  await page.waitForTimeout(3000);
  await page.waitForLoadState("networkidle");

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
    await page.waitForLoadState("networkidle");

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
      await page.waitForLoadState("networkidle");
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
  await page.waitForLoadState("networkidle");
}
