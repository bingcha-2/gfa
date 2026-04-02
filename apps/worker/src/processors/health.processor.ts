/**
 * Health check processor.
 *
 * Starts the AdsPower profile, checks Google login state,
 * and updates Account.status accordingly.
 */

import { Job, UnrecoverableError } from "bullmq";
import { PrismaClient } from "@prisma/client";
import type { HealthCheckAccountPayload } from "@gfa/shared";

import { AdsPowerClient } from "../adspower-client";
import { BrowserPool } from "../browser-pool";
import { WorkerBrowser } from "../browser-context";
import { TaskLogger } from "../task-logger";
import { gmailLogin } from "../gmail-login";
import { handleLoginResult } from "../handle-login-result";
import { scrapeSubscriptionInfo } from "../scrape-subscription";

const GOOGLE_ACCOUNT_URL = "https://myaccount.google.com/?hl=en";

export interface HealthProcessorDeps {
  prisma: PrismaClient;
  adspower: AdsPowerClient;
  pool: BrowserPool;
  workerId: string;
}

export async function processHealth(
  job: Job<HealthCheckAccountPayload>,
  deps: HealthProcessorDeps
): Promise<void> {
  const { prisma, adspower, pool, workerId } = deps;
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

  let profileId: string | null = null;

  try {
    // Cooldown guard: skip immediately if this account recently failed login
    const cooldownSecs = await pool.isLoginCoolingDown(accountId);
    if (cooldownSecs > 0) {
      await logger.log("WARN", `[health] Account ${accountId} in login cooldown (${cooldownSecs}s remaining), skipping`);
      await logger.updateStatus("FAILED_RETRYABLE", { code: "LOGIN_COOLDOWN", message: `Account in cooldown for ${cooldownSecs}s` });
      throw new UnrecoverableError(`LOGIN_COOLDOWN: ${cooldownSecs}s remaining`);
    }

    // Acquire profile + open AdsPower browser (retries other profiles on failure)
    const acquired = await pool.acquireAndOpen(workerId, accountId, adspower);
    profileId = acquired.profileId;
    await logger.log("INFO", `Health check for account ${account.name}`, { profileId });

    await logger.updateStatus("RUNNING");
    const page = await browser.connect(acquired.debugUrl);

    // Attempt Gmail auto-login to verify account health
    const loginResult = await gmailLogin(page, account, logger);
    if (!loginResult.success) {
      const handled = await handleLoginResult(loginResult, {
        job, pool, prisma, logger,
        accountId,
        returnOnFinal: true,
        unknownAccountStatus: "LOGIN_REQUIRED",
        extraAccountUpdate: { lastHealthCheckAt: new Date() },
      });
      if (handled) return; // Health processor returns gracefully on final failure
    }

    // Navigate to Google Account page to determine final health status
    await browser.navigateTo(GOOGLE_ACCOUNT_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    const currentUrl = page.url();
    await logger.log("INFO", `Page URL after navigation: ${currentUrl}`);

    const screenshotPath = await browser.takeScreenshot(taskId, "health");
    await logger.recordScreenshot("afterScreenshotPath", screenshotPath);

    // Determine account health based on the page state
    const healthStatus = await determineHealth(page, currentUrl);
    await logger.log("INFO", `Health status: ${healthStatus}`, { currentUrl });

    // Attempt to scrape subscription info from Google One page (non-fatal)
    let subUpdate: { subscriptionExpiresAt?: Date | null; subscriptionStatus?: string; subscriptionPlan?: string | null } = {};
    if (healthStatus === "HEALTHY") {
      const subInfo = await scrapeSubscriptionInfo(page).catch(() => null);
      if (subInfo) {
        subUpdate = {
          subscriptionExpiresAt: subInfo.expiresAt,
          subscriptionStatus: subInfo.status,
          subscriptionPlan: subInfo.planName,
        };
        await logger.log("INFO", `Subscription: ${subInfo.status}, plan: ${subInfo.planName ?? "unknown"}, expires: ${subInfo.expiresAt?.toISOString() ?? "unknown"}`);
      } else {
        await logger.log("WARN", "Could not scrape subscription info — skipping");
      }
    }

    // Update account status + subscription fields
    await prisma.account.update({
      where: { id: accountId },
      data: {
        status: healthStatus,
        lastHealthCheckAt: new Date(),
        ...subUpdate,
      },
    });

    await logger.updateStatus("SUCCESS");
    await logger.log("INFO", `Health check complete: ${healthStatus}`);
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

    await logger.updateStatus("FAILED_RETRYABLE", {
      code: profileId ? "HEALTH_CHECK_ERROR" : "PROFILE_ACQUIRE_FAILED",
      message: errMsg,
    });

    throw error;
  } finally {
    await browser.disconnect().catch(() => {});
    if (profileId) {
      await adspower.closeProfile(profileId).catch(() => {});
      await pool.release(profileId, workerId).catch(() => {});
    }
    await pool.releaseAccount(accountId, workerId).catch(() => {});
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
