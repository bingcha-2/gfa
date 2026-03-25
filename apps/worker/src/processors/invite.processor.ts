/**
 * Invite member processor.
 *
 * Flow:
 * 1. Acquire profile lock
 * 2. Start AdsPower browser profile
 * 3. Connect via CDP
 * 4. Navigate to Google One Family management page
 * 5. Send family invite to the target email
 * 6. Take screenshots (before/after)
 * 7. Update Task + Order status
 * 8. Release lock, close profile
 */

import { Job } from "bullmq";
import { PrismaClient } from "@prisma/client";
import type { InviteMemberPayload } from "@gfa/shared";

import { AdsPowerClient } from "../adspower-client";
import { ProfileLock } from "../profile-lock";
import { WorkerBrowser } from "../browser-context";
import { TaskLogger } from "../task-logger";

const GOOGLE_FAMILY_URL = "https://myaccount.google.com/family/details";

export interface InviteProcessorDeps {
  prisma: PrismaClient;
  adspower: AdsPowerClient;
  lock: ProfileLock;
  workerId: string;
}

export async function processInvite(
  job: Job<InviteMemberPayload>,
  deps: InviteProcessorDeps
): Promise<void> {
  const { prisma, adspower, lock, workerId } = deps;
  const { orderId, familyGroupId, accountId, userEmail } = job.data;
  const taskId = job.data.taskId ?? job.id ?? job.name;
  if (!taskId) {
    console.error(`[worker:${workerId}] invite job has no id or name, skipping`);
    return;
  }

  const logger = new TaskLogger(prisma, taskId, workerId);
  const browser = new WorkerBrowser();

  // Guard: stale retry jobs (pre-fix) may have null accountId
  if (!accountId) {
    console.error(`[worker:${workerId}] invite job ${taskId} has no accountId — dropping stale job`);
    return;
  }

  // Resolve the AdsPower profile ID from the account
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

  // 1. Acquire profile lock
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
    await logger.log("INFO", `Starting invite for ${userEmail}`, {
      profileId,
      familyGroupId,
    });

    // 2. Start AdsPower profile
    const { debugUrl } = await adspower.openProfile(profileId);
    await logger.log("INFO", `Profile started, CDP: ${debugUrl}`);

    // 3. Connect via CDP
    const page = await browser.connect(debugUrl);
    await logger.log("INFO", "Browser connected via CDP");

    // 4. Take pre-operation screenshot
    const beforePath = await browser.takeScreenshot(taskId, "before");
    await logger.recordScreenshot("beforeScreenshotPath", beforePath);

    // 5. Navigate to Google Family page
    await browser.navigateTo(GOOGLE_FAMILY_URL, {
      waitUntil: "networkidle",
    });
    await logger.log("INFO", "Navigated to Google Family page");

    // 6. Execute invite flow on page
    await executeInviteOnPage(page, userEmail, logger);

    // 7. Take post-operation screenshot
    const afterPath = await browser.takeScreenshot(taskId, "after");
    await logger.recordScreenshot("afterScreenshotPath", afterPath);

    // 8. Update statuses
    await logger.updateStatus("INVITE_SENT");

    if (orderId) {
      await logger.updateOrderStatus(
        orderId,
        "INVITE_SENT",
        `Invite sent to ${userEmail}`
      );
    }

    // 9. Record the invite in DB (slots already decremented at group assignment time in API)
    try {
      await prisma.familyInvite.create({
        data: { familyGroupId, email: userEmail, status: "SENT" }
      });
      await logger.log("INFO", `FamilyInvite created for ${userEmail}`);
    } catch (dbErr) {
      // Non-fatal: invite was already sent, just log the DB error
      await logger.log("WARN", `Failed to record invite in DB: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
    }

    await logger.log("INFO", "Invite completed successfully");
  } catch (error) {
    const errMsg =
      error instanceof Error ? error.message : String(error);

    // Take error screenshot if possible
    try {
      const errPath = await browser.takeScreenshot(taskId, "error");
      await logger.recordScreenshot("errorScreenshotPath", errPath);
    } catch {
      // Screenshot might fail if browser is disconnected
    }

    await logger.updateStatus("FAILED_RETRYABLE", {
      code: "INVITE_ERROR",
      message: errMsg,
    });

    // Don't mark order FAILED here — BullMQ will retry, order status
    // should only be set to FAILED when retries are exhausted
    await logger.log("ERROR", `Invite error (will retry): ${errMsg}`);

    throw error; // Let BullMQ handle retry
  } finally {
    // Always clean up
    await browser.disconnect().catch(() => {});
    await adspower.closeProfile(profileId).catch(() => {});
    await lock.release(profileId, workerId).catch(() => {});
  }
}

/**
 * Execute the invite flow on the Google Family page.
 *
 * Selectors calibrated from real Google Family UI (myaccount.google.com/family/details).
 * Page language may be zh-TW/zh-CN, so we match both Chinese and English text.
 */
async function executeInviteOnPage(
  page: import("playwright").Page,
  email: string,
  logger: TaskLogger
): Promise<void> {
  await page.waitForLoadState("networkidle");

  // The invite link: <a href="family/invitemembers" ...>傳送邀請 (還可邀請 N 人)</a>
  const inviteLink = page.locator('a[href*="invitemembers"]');

  if ((await inviteLink.count()) === 0) {
    throw new Error("Cannot find invite link on family page");
  }

  await inviteLink.first().click();
  await logger.log("INFO", "Clicked invite link");

  // Wait for invite page to load (navigates to /family/invitemembers)
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2000);

  // Ensure we are on the invite page before interacting
  await page.waitForURL(/invitemembers/, { timeout: 10000 }).catch(async () => {
    // May have been a click instead of direct navigation — wait a bit more
    await page.waitForLoadState("networkidle");
    if (!page.url().includes("invitemembers")) {
      throw new Error(`Expected to be on invitemembers page, but got: ${page.url()}`);
    }
  });

  // Email input field: <input class="I4p4db" ...> on the invite page
  // Strictly match class first; fall back to zh-TW/zh-CN/EN placeholder only on this specific page
  const emailInput = page.locator([
    "input.I4p4db",
    'input[placeholder*="電子郵件"]',
    'input[placeholder*="电子邮件"]',
    'input[placeholder*="email" i]',
  ].join(", "));

  if ((await emailInput.count()) === 0) {
    throw new Error("Cannot find email input field on invite page");
  }

  await emailInput.first().fill(email);
  await logger.log("INFO", `Filled email: ${email}`);

  // Wait a moment for autocomplete / validation
  await page.waitForTimeout(1500);

  // Press Enter to confirm the email chip
  await emailInput.first().press("Enter");
  await page.waitForTimeout(1000);

  // Send button: <button ...>傳送</button> (Chinese) or "Send" (English)
  const sendButton = page.locator(
    'button:has-text("傳送"), button:has-text("Send"), button:has-text("发送")'
  );

  if ((await sendButton.count()) === 0) {
    throw new Error("Cannot find send button on invite page");
  }

  await sendButton.first().click();
  await logger.log("INFO", "Clicked send invite button");

  // Wait for confirmation / redirect back to family page
  await page.waitForTimeout(3000);
  await page.waitForLoadState("networkidle");
}
