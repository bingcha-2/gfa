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
import { handleLoginResult } from "../handle-login-result";
import { ensureFamilyGroup } from "../ensure-family-group";

const GOOGLE_FAMILY_URL = "https://myaccount.google.com/family/details?hl=en";

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
  let reuseSession = false;

  try {
    await logger.updateStatus("RUNNING");

    // Cooldown guard: skip immediately if this account recently failed login
    const cooldownSecs = await pool.isLoginCoolingDown(accountId);
    if (cooldownSecs > 0) {
      await logger.log("WARN", `[invite] Account ${accountId} in login cooldown (${cooldownSecs}s remaining), skipping`);
      await logger.updateStatus("FAILED_RETRYABLE", { code: "LOGIN_COOLDOWN", message: `Account in cooldown for ${cooldownSecs}s` });
      throw new UnrecoverableError("LOGIN_COOLDOWN");
    }

    // Try up to poolSize profiles: if AdsPower rejects one (stale/occupied),
    // release it and immediately acquire the next free profile.
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

    // Check if the same account last used this profile — if so, reuse its session
    const lastAccount = await pool.getLastAccount(profileId!);
    reuseSession = lastAccount === accountId;

    const page = await browser.connect(debugUrl!, reuseSession);
    await logger.log("INFO", "Browser connected via CDP");

    // Gmail auto-login (required every time — browser clears cache on start)
    const loginResult = await gmailLogin(page, account, logger);
    if (!loginResult.success) {
      await handleLoginResult(loginResult, { job, pool, prisma, logger, accountId });
    }
    // Record which account is now logged into this profile
    await pool.setLastAccount(profileId!, accountId);

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

    // --- Capture gaiaId from family page after invite ---
    // Google renders the new member card on the family details page right after invite.
    // We scan the page for the invited email to extract the card's gaiaId.
    let capturedGaiaId: string | undefined;
    try {
      // After invite, Google usually redirects back to family details.
      // Ensure we're on that page.
      if (!page.url().includes("family/details")) {
        await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "load", timeout: 60000 });
      }
      await page.waitForTimeout(1500);
      capturedGaiaId = await scanPageForMemberGaiaId(page, userEmail);
      if (capturedGaiaId) {
        await logger.log("INFO", `Captured gaiaId=${capturedGaiaId} for ${userEmail}`);
      } else {
        await logger.log("WARN", `Could not capture gaiaId for ${userEmail} — will be filled on next sync`);
      }
    } catch {
      // Non-fatal: gaiaId will be filled on next sync
      await logger.log("WARN", "gaiaId capture failed — will be filled on next sync");
    }

    // Upsert FamilyMember with gaiaId (so future remove/replace can use fast S0 path)
    try {
      await prisma.familyMember.upsert({
        where: { familyGroupId_email: { familyGroupId, email: userEmail } },
        update: {
          status: "PENDING",
          displayName: userEmail.split("@")[0],
          ...(capturedGaiaId ? { googleMemberId: capturedGaiaId } : {}),
        },
        create: {
          familyGroupId,
          email: userEmail,
          displayName: userEmail.split("@")[0],
          role: "member",
          status: "PENDING",
          googleMemberId: capturedGaiaId ?? undefined,
        },
      });

      // Idempotent: skip if a SENT invite already exists (prevents duplicates on BullMQ retry)
      const existingInvite = await prisma.familyInvite.findFirst({
        where: { familyGroupId, email: userEmail, status: "SENT" },
      });
      if (!existingInvite) {
        await prisma.familyInvite.create({ data: { familyGroupId, email: userEmail, status: "SENT" } });
      }
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

  // Wait for Google to process the invite.
  // After a successful invite, Google either:
  //   (a) redirects back to family/details page, or
  //   (b) shows a success toast/snackbar, or
  //   (c) the invite URL changes
  // We wait up to 15s for the page to leave the invite page.
  try {
    await page.waitForURL(
      (url) => !url.toString().includes("invitemembers"),
      { timeout: 15_000 }
    );
    await logger.log("INFO", "Invite page navigated away — invite confirmed");
  } catch {
    // If URL didn't change, check if we're still on invite page (could be an error)
    const currentUrl = page.url();
    if (currentUrl.includes("invitemembers")) {
      await logger.log("WARN", "Still on invite page after 15s — invite may not have been sent");
    }
  }
  // Extra buffer for any async processing
  await page.waitForTimeout(2000);
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
      // Check card container text for the email
      const card = link.closest("li") ?? link.parentElement;
      const cardText = card?.textContent?.toLowerCase() ?? "";
      if (cardText.includes(lowerTarget)) {
        const href = link.getAttribute("href") ?? "";
        // Extract gaiaId: /g/{id} for accepted, /member/i/{id} or /member/{id} for pending
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
