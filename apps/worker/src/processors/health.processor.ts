/**
 * Health check processor.
 *
 * Starts the AdsPower profile, checks Google login state,
 * and updates Account.status accordingly.
 */

import { Job } from "bullmq";
import { PrismaClient } from "@prisma/client";
import type { HealthCheckAccountPayload } from "@gfa/shared";

import { AdsPowerClient } from "../adspower-client";
import { ProfileLock } from "../profile-lock";
import { WorkerBrowser } from "../browser-context";
import { TaskLogger } from "../task-logger";

const GOOGLE_ACCOUNT_URL = "https://myaccount.google.com/";

export interface HealthProcessorDeps {
  prisma: PrismaClient;
  adspower: AdsPowerClient;
  lock: ProfileLock;
  workerId: string;
}

export async function processHealth(
  job: Job<HealthCheckAccountPayload>,
  deps: HealthProcessorDeps
): Promise<void> {
  const { prisma, adspower, lock, workerId } = deps;
  const { accountId } = job.data;
  const taskId = job.data.taskId ?? job.id ?? job.name;
  if (!taskId) {
    console.error(`[worker:${workerId}] health job has no id or name, skipping`);
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
      message: `Profile ${profileId} locked`,
    });
    throw new Error(`Profile ${profileId} locked — will retry`);
  }

  try {
    await logger.updateStatus("RUNNING");
    await logger.log("INFO", `Health check for account ${account.name}`, {
      profileId,
    });

    const { debugUrl } = await adspower.openProfile(profileId);
    const page = await browser.connect(debugUrl);

    // Navigate to Google Account page to check login state
    await browser.navigateTo(GOOGLE_ACCOUNT_URL, {
      waitUntil: "load",
      timeout: 60000,
    });

    const currentUrl = page.url();
    await logger.log("INFO", `Page URL after navigation: ${currentUrl}`);

    const screenshotPath = await browser.takeScreenshot(taskId, "health");
    await logger.recordScreenshot("afterScreenshotPath", screenshotPath);

    // Determine account health based on the page state
    const healthStatus = await determineHealth(page, currentUrl);
    await logger.log("INFO", `Health status: ${healthStatus}`, { currentUrl });

    // Update account status
    await prisma.account.update({
      where: { id: accountId },
      data: {
        status: healthStatus,
        lastHealthCheckAt: new Date(),
      },
    });

    await logger.updateStatus("SUCCESS");
    await logger.log("INFO", `Health check complete: ${healthStatus}`);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);

    try {
      const errPath = await browser.takeScreenshot(taskId, "error");
      await logger.recordScreenshot("errorScreenshotPath", errPath);
    } catch {
      // noop
    }

    await logger.updateStatus("FAILED_RETRYABLE", {
      code: "HEALTH_CHECK_ERROR",
      message: errMsg,
    });

    throw error;
  } finally {
    await browser.disconnect().catch(() => {});
    await adspower.closeProfile(profileId).catch(() => {});
    await lock.release(profileId, workerId).catch(() => {});
  }
}

/**
 * Determine account health based on the page state after
 * navigating to Google Account page.
 */
async function determineHealth(
  page: import("playwright").Page,
  currentUrl: string
): Promise<"HEALTHY" | "LOGIN_REQUIRED" | "VERIFICATION_REQUIRED" | "RISKY"> {
  // If redirected to login page, login is required
  if (
    currentUrl.includes("accounts.google.com/signin") ||
    currentUrl.includes("accounts.google.com/ServiceLogin")
  ) {
    return "LOGIN_REQUIRED";
  }

  // If redirected to verification/challenge page
  if (
    currentUrl.includes("accounts.google.com/challenge") ||
    currentUrl.includes("accounts.google.com/speedbump")
  ) {
    return "VERIFICATION_REQUIRED";
  }

  // Check for security warning banners on the account page
  const hasSecurityWarning = await page
    .locator(
      '[data-security-warning], .security-warning, [aria-label*="security" i]'
    )
    .count();

  if (hasSecurityWarning > 0) {
    return "RISKY";
  }

  // If we're on the account page and no issues detected
  if (currentUrl.includes("myaccount.google.com")) {
    return "HEALTHY";
  }

  // Default to login required for unknown states
  return "LOGIN_REQUIRED";
}
