/**
 * Invite member processor.
 *
 * Flow (Browser Pool architecture):
 * 1. Acquire a free profile from BrowserPool
 * 2. Start AdsPower browser profile
 * 3. Connect via CDP, Gmail auto-login
 * 4. Ensure family group exists (create if needed)
 * 5. Navigate to Google Family page, send invite
 * 6. Take screenshots, update Task + Order status
 * 7. Release profile back to pool
 */

import { Job, UnrecoverableError } from "bullmq";
import { PrismaClient } from "@prisma/client";
import type { InviteMemberPayload } from "@gfa/shared";

import { AdsPowerClient } from "../adspower-client";
import { BrowserPool } from "../browser-pool";
import { WorkerBrowser } from "../browser-context";
import { TaskLogger } from "../task-logger";
import { gmailLogin } from "../gmail-login";
import { ensureFamilyGroup } from "../ensure-family-group";

const GOOGLE_FAMILY_URL = "https://myaccount.google.com/family/details";

export interface InviteProcessorDeps {
  prisma: PrismaClient;
  adspower: AdsPowerClient;
  pool: BrowserPool;
  workerId: string;
}

export async function processInvite(
  job: Job<InviteMemberPayload>,
  deps: InviteProcessorDeps
): Promise<void> {
  const { prisma, adspower, pool, workerId } = deps;
  const { orderId, accountId, userEmail } = job.data;
  const taskId = job.data.taskId ?? job.id ?? job.name;
  if (!taskId) {
    console.error(`[worker:${workerId}] invite job has no id or name, skipping`);
    return;
  }

  const logger = new TaskLogger(prisma, taskId, workerId);
  const browser = new WorkerBrowser();

  if (!accountId) {
    console.error(`[worker:${workerId}] invite job ${taskId} has no accountId — dropping stale job`);
    return;
  }

  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) {
    await logger.updateStatus("FAILED_FINAL", { code: "ACCOUNT_NOT_FOUND", message: `Account ${accountId} not found` });
    return;
  }

  // Acquire a free profile from pool (AFTER account validation to avoid resource leak)
  let profileId: string | null = null;

  try {
    await logger.updateStatus("RUNNING");

    // Try up to poolSize profiles: if AdsPower rejects one (stale/occupied),
    // release it and immediately acquire the next free profile.
    // failedProfiles tracks IDs that already failed so we don't re-acquire the same broken profile.
    let debugUrl: string | undefined;
    const maxProfileAttempts = pool.poolSize;
    const failedProfiles = new Set<string>();
    for (let profileAttempt = 1; profileAttempt <= maxProfileAttempts; profileAttempt++) {
      profileId = await pool.acquireExcluding(workerId, failedProfiles);
      await logger.log("INFO", `Starting invite for ${userEmail} (profile attempt ${profileAttempt}/${maxProfileAttempts})`, { profileId });
      try {
        debugUrl = (await adspower.openProfile(profileId)).debugUrl;
        break; // success — stop trying profiles
      } catch (profileErr) {
        const profileErrMsg = profileErr instanceof Error ? profileErr.message : String(profileErr);
        await logger.log("WARN", `Profile ${profileId} unavailable, switching to next: ${profileErrMsg}`);
        // Release this profile and mark it as failed before trying another
        failedProfiles.add(profileId!);
        await adspower.closeProfile(profileId!).catch(() => {});
        await pool.release(profileId!, workerId).catch(() => {});
        profileId = null;
        if (profileAttempt === maxProfileAttempts) {
          throw new Error(`All ${maxProfileAttempts} profiles unavailable: ${profileErrMsg}`);
        }
      }
    }

    const page = await browser.connect(debugUrl!);
    await logger.log("INFO", "Browser connected via CDP");

    // Gmail auto-login (required every time — browser clears cache on start)
    const loginResult = await gmailLogin(page, account, logger);
    if (!loginResult.success) {
      // TRANSIENT failures (e.g. password page didn't load) → let BullMQ retry
      if (loginResult.reason === "TRANSIENT") {
        throw new Error(`Login transient failure: ${loginResult.detail}`);
      }
      // VERIFICATION_REQUIRED or UNKNOWN → needs human intervention
      await prisma.account.update({ where: { id: accountId }, data: { status: "VERIFICATION_REQUIRED" } });
      await logger.updateStatus("MANUAL_REVIEW", { code: loginResult.reason, message: loginResult.detail });
      // Throw to ensure finally block runs (pool.release); catch block must not overwrite MANUAL_REVIEW status
      throw new UnrecoverableError("MANUAL_REVIEW");
    }

    // Ensure family group exists
    const { familyGroupId } = await ensureFamilyGroup(page, account, prisma, logger);

    const beforePath = await browser.takeScreenshot(taskId, "before");
    await logger.recordScreenshot("beforeScreenshotPath", beforePath);

    // Navigate to Google Family page, execute invite
    await browser.navigateTo(GOOGLE_FAMILY_URL, { waitUntil: "load", timeout: 60000 });
    await logger.log("INFO", "Navigated to Google Family page");
    await executeInviteOnPage(page, userEmail, logger);

    const afterPath = await browser.takeScreenshot(taskId, "after");
    await logger.recordScreenshot("afterScreenshotPath", afterPath);

    await logger.updateStatus("INVITE_SENT");

    if (orderId) {
      await logger.updateOrderStatus(orderId, "INVITE_SENT", `Invite sent to ${userEmail}`);
    }

    try {
      await prisma.familyInvite.create({ data: { familyGroupId, email: userEmail, status: "SENT" } });
    } catch (dbErr) {
      await logger.log("WARN", `Failed to record invite in DB: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
    }

    await logger.log("INFO", "Invite completed successfully");
  } catch (error) {
    // Don't overwrite MANUAL_REVIEW status if login challenge was detected
    if (error instanceof UnrecoverableError) throw error;

    const errMsg = error instanceof Error ? error.message : String(error);
    try {
      const errPath = await browser.takeScreenshot(taskId, "error");
      await logger.recordScreenshot("errorScreenshotPath", errPath);
    } catch { /* noop */ }

    await logger.updateStatus("FAILED_RETRYABLE", {
      code: profileId ? "INVITE_ERROR" : "PROFILE_ACQUIRE_FAILED",
      message: errMsg
    });
    await logger.log("ERROR", `Invite error (will retry): ${errMsg}`);
    throw error;
  } finally {
    await browser.disconnect().catch(() => {});
    if (profileId) {
      await adspower.closeProfile(profileId).catch(() => {});
      await pool.release(profileId, workerId).catch(() => {});
    }
  }
}

async function executeInviteOnPage(
  page: import("playwright").Page,
  email: string,
  logger: TaskLogger
): Promise<void> {
  await page.waitForLoadState("load", { timeout: 60000 });

  const inviteLink = page.locator('a[href*="invitemembers"]');
  if ((await inviteLink.count()) === 0) throw new Error("Cannot find invite link on family page");

  await inviteLink.first().click();
  await logger.log("INFO", "Clicked invite link");
  await page.waitForLoadState("load", { timeout: 60000 });
  await page.waitForTimeout(2000);

  await page.waitForURL(/invitemembers/, { timeout: 10000 }).catch(async () => {
    await page.waitForLoadState("load", { timeout: 60000 });
    if (!page.url().includes("invitemembers")) {
      throw new Error(`Expected invitemembers page, got: ${page.url()}`);
    }
  });

  const emailInput = page.locator([
    "input.I4p4db",
    'input[placeholder*="電子郵件"]',
    'input[placeholder*="电子邮件"]',
    'input[placeholder*="email" i]',
    'input[type="email"]',
  ].join(", "));

  // Wait up to 15s for the input to appear (Angular renders lazily)
  try {
    await emailInput.first().waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    // Dump page content for debugging
    const url = page.url();
    const bodySnippet = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? "").catch(() => "?");
    throw new Error(`Cannot find email input on invite page. URL: ${url}, body: ${bodySnippet}`);
  }

  await emailInput.first().fill(email);
  await logger.log("INFO", `Filled email: ${email}`);
  await page.waitForTimeout(1500);
  await emailInput.first().press("Enter");
  await page.waitForTimeout(1000);

  const sendButton = page.locator('button:has-text("傳送"), button:has-text("Send"), button:has-text("发送")');
  if ((await sendButton.count()) === 0) throw new Error("Cannot find send button on invite page");

  await sendButton.first().click();
  await logger.log("INFO", "Clicked send invite button");
  await page.waitForTimeout(3000);
  await page.waitForLoadState("load", { timeout: 60000 });
}
