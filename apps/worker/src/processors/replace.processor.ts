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

    await browser.navigateTo(GOOGLE_FAMILY_URL, { waitUntil: "load", timeout: 60000 });

    // Look up the member's googleMemberId and displayName from DB
    const memberRecord = await prisma.familyMember.findFirst({
      where: { familyGroupId, email: targetMemberEmail },
      select: { displayName: true, googleMemberId: true }
    });
    const targetDisplayName = memberRecord?.displayName ?? undefined;
    const targetGaiaId = memberRecord?.googleMemberId ?? undefined;

    await logger.log("INFO",
      `Target member: email=${targetMemberEmail}, displayName=${targetDisplayName ?? 'unknown'}, gaiaId=${targetGaiaId ?? 'unknown'}`
    );

    // Step 1: Remove the target member on page
    await removeMemberOnPage(page, targetMemberEmail, logger, {
      password: account.loginPassword ?? undefined,
      totpSecret: account.totpSecret ?? undefined,
      displayName: targetDisplayName,
      googleMemberId: targetGaiaId,
    });

    // Step 2: Invite the new member on page
    await inviteMemberOnPage(page, newUserEmail, logger);

    // Both page operations succeeded — now update DB atomically
    await prisma.$transaction(async (tx) => {
      // Mark old member as REMOVED
      await tx.familyMember.updateMany({
        where: { familyGroupId, email: targetMemberEmail },
        data: { status: "REMOVED", removedAt: new Date() },
      });

      // Create placeholder for newly invited member
      await tx.familyMember.create({
        data: {
          familyGroupId,
          email: newUserEmail,
          displayName: newUserEmail.split("@")[0],
          role: "member",
          status: "PENDING",
        },
      });

      // Record invite
      await tx.familyInvite.create({
        data: { familyGroupId, email: newUserEmail, status: "SENT" },
      });
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
 * Matching strategies (tried in order):
 *   S0: Direct GAIA URL navigation (fastest, uses googleMemberId from DB)
 *   S1: Find email text directly on list page (pending invites without Google account)
 *   S2: Find member by displayName (accepted members show display name, not email)
 *   S3: Blind iteration — click each card, check body text (last resort)
 */
async function removeMemberOnPage(
  page: import("playwright").Page,
  email: string,
  logger: TaskLogger,
  credentials?: { password?: string; totpSecret?: string; displayName?: string; googleMemberId?: string }
): Promise<void> {
  await page.waitForLoadState("load", { timeout: 60000 });

  const displayName = credentials?.displayName;
  const googleMemberId = credentials?.googleMemberId;

  if (googleMemberId) {
    // Strategy 0: Direct navigation using GAIA ID — bypasses all text matching issues
    const directUrl = `https://myaccount.google.com/family/member/g/${googleMemberId}`;
    await logger.log("INFO", `S0: Navigating directly to member page via GAIA ID ${googleMemberId}`);
    await page.goto(directUrl, { waitUntil: "load", timeout: 60000 });
    await page.waitForLoadState("load", { timeout: 60000 });

    // Verify we landed on the right page (check for remove/cancel button)
    const hasAction = await page.locator(
      'button:has-text("移除"), button:has-text("取消邀請"), button:has-text("取消"), button:has-text("Cancel"), button:has-text("Remove")'
    ).count();

    if (hasAction > 0) {
      await logger.log("INFO", `S0 success: on member detail page for gaiaId=${googleMemberId}`);
      // Already on the detail page — proceed directly to remove button logic below
    } else {
      await logger.log("WARN", `S0: Landed on page but no action button found, falling back to list page matching`);
      await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "load", timeout: 60000 });
      await fallbackFindMember(page, email, displayName, logger);
    }
  } else {
    // No GAIA ID — fall back to text-based matching
    await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "load", timeout: 60000 });
    await fallbackFindMember(page, email, displayName, logger);
  }

  await logger.log("INFO", `On detail page for member ${email}`);
  // Save the member detail URL for potential re-navigation after password auth
  const memberDetailUrl = page.url();
  await page.waitForTimeout(1000);

  // Look for remove/cancel-invite button on the member detail page
  const removeButton = page.locator([
    'button:has-text("移除")',
    'button:has-text("取消邀請")',
    'button:has-text("取消邀请")',
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
  await page.waitForLoadState("load", { timeout: 60000 });

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
    await page.waitForLoadState("load", { timeout: 60000 });

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
          'div:has-text("Google Authenticator"), div:has-text("驗證器"), div:has-text("验证器"), div:has-text("Authenticator")'
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
        'button:has-text("Next"), button:has-text("下一步"), button:has-text("Verify"), button:has-text("驗證"), button:has-text("验证")'
      );
      await verifyButton.first().click();
      await logger.log("INFO", "TOTP code submitted");

      await page.waitForTimeout(5000);
      await page.waitForLoadState("load", { timeout: 60000 });
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
  await page.waitForLoadState("load", { timeout: 60000 });
}

/**
 * Fallback member finder when GAIA ID is not available.
 * Tries S1 (email text on page) → S2 (displayName) → S3 (click each card).
 * After this resolves, the page will be on the member's detail page.
 */
async function fallbackFindMember(
  page: import("playwright").Page,
  email: string,
  displayName: string | undefined,
  logger: TaskLogger
): Promise<void> {
  await page.waitForLoadState("load", { timeout: 60000 });

  // S1: Email visible directly on list (pending invites without a Google account name)
  const emailLocator = page.locator(`text="${email}"`);
  if ((await emailLocator.count()) > 0) {
    await logger.log("INFO", `S1: Found email text on list page, clicking`);
    await emailLocator.first().click();
    await page.waitForLoadState("load", { timeout: 60000 });
    return;
  }

  // S2: displayName match (accepted members show their Google display name)
  if (displayName) {
    await logger.log("INFO", `S2: Email not visible, trying displayName "${displayName}"`);
    const nameLocator = page.locator(`text="${displayName}"`);
    if ((await nameLocator.count()) > 0) {
      await logger.log("INFO", `S2: Found by displayName, clicking`);
      await nameLocator.first().click();
      await page.waitForLoadState("load", { timeout: 60000 });
      return;
    }
    await logger.log("WARN", `S2: displayName "${displayName}" not found on page either`);
  }

  // S3: Blind iteration — click each non-admin card and check detail page body
  await logger.log("INFO", `S3: Iterating all member cards to find "${email}"`);
  const memberLinks = page.locator('a.umngff[href*="family/member/"]');
  const count = await memberLinks.count();

  for (let i = 0; i < count; i++) {
    const links = page.locator('a.umngff[href*="family/member/"]');
    if (i >= (await links.count())) break;
    const link = links.nth(i);

    // Skip manager cards
    const roleText = await link.locator(".ImPZoc").textContent().catch(() => "");
    if (roleText?.includes("管理") || roleText?.toLowerCase().includes("manager")) continue;

    // Quick card-text check first
    const cardText = await link.textContent().catch(() => "");
    if (cardText?.includes(email)) {
      await logger.log("INFO", `S3: Found email in card #${i} text, clicking`);
      await link.click();
      await page.waitForLoadState("load", { timeout: 60000 });
      return;
    }

    // Navigate into detail page
    await link.click();
    await page.waitForLoadState("load", { timeout: 60000 });
    await page.waitForTimeout(800);

    const bodyText = await page.textContent("body").catch(() => "");
    if (bodyText?.includes(email)) {
      await logger.log("INFO", `S3: Matched on detail page for card #${i}`);
      return;
    }

    await logger.log("DEBUG", `S3: Card #${i} does not match, going back`);
    await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(800);
  }

  throw new Error(
    `Cannot find member "${email}" on family page. ` +
    `Checked ${count} cards via S1/S2/S3. Member may have left or DB is out of sync.`
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
  // Navigate back to family details if not already there
  if (!page.url().includes("/family/details")) {
    await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "load", timeout: 60000 });
  }

  // Click invite link: <a href="family/invitemembers">
  const inviteLink = page.locator('a[href*="invitemembers"]');

  if ((await inviteLink.count()) === 0) {
    throw new Error("Cannot find invite link on family page");
  }

  await inviteLink.first().click();
  await page.waitForLoadState("load", { timeout: 60000 });
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
  await page.waitForLoadState("load", { timeout: 60000 });
}
