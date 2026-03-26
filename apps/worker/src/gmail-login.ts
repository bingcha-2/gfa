/**
 * Gmail login automation module.
 *
 * Handles the full Google account login flow on accounts.google.com,
 * including 5 types of occasional verification challenges:
 *
 *  1. Normal email + password flow
 *  2. TOTP 2FA (Google Authenticator)
 *  3. Age/birthday verification → auto-fill adult birthdate (1990-01-01)
 *  4. Terms of service / privacy confirmation → auto-accept
 *  5. Phone/SMS verification code → fall back to MANUAL_REVIEW
 *
 * Returns { success: true } on successful login, or
 * { success: false, reason, detail } when manual intervention is required.
 */

import type { Page } from "playwright";
import { generateTOTP, totpSecondsRemaining } from "./totp";
import type { TaskLogger } from "./task-logger";

const GOOGLE_LOGIN_URL = "https://accounts.google.com";
const SUCCESS_DOMAIN = "myaccount.google.com";
const LOGIN_TIMEOUT_MS = 60_000;

export type GmailLoginResult =
  | { success: true }
  | { success: false; reason: "VERIFICATION_REQUIRED" | "UNKNOWN"; detail: string };

export interface LoginCredentials {
  loginEmail: string;
  loginPassword: string | null;  // null = not configured, will return VERIFICATION_REQUIRED
  totpSecret?: string | null;
}


export async function gmailLogin(
  page: Page,
  credentials: LoginCredentials,
  logger: TaskLogger
): Promise<GmailLoginResult> {
  const { loginEmail, loginPassword, totpSecret } = credentials;

  await logger.log("INFO", `[gmail-login] Starting login for ${loginEmail}`);

  // Preserve compatibility for accounts that rely on an already-authenticated session.
  const currentUrl = page.url();
  if (currentUrl.includes(SUCCESS_DOMAIN) || currentUrl.includes("mail.google.com")) {
    await logger.log("INFO", "[gmail-login] Existing logged-in session detected");
    return { success: true };
  }

  // Guard: password is required for automated login
  if (!loginPassword) {
    return {
      success: false,
      reason: "VERIFICATION_REQUIRED",
      detail: "Account loginPassword is not configured — manual login required",
    };
  }


  try {
    // Step 1: Navigate to Google login
    await page.goto(GOOGLE_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: LOGIN_TIMEOUT_MS });
    await page.waitForTimeout(2000);

    // Step 2: Fill email
    const emailInput = page.locator(
      'input[type="email"], input[id="identifierId"]'
    );
    if ((await emailInput.count()) === 0) {
      // Already logged in?
      if (page.url().includes(SUCCESS_DOMAIN)) {
        await logger.log("INFO", "[gmail-login] Already logged in, skipping login");
        return { success: true };
      }
      return { success: false, reason: "UNKNOWN", detail: "Cannot find email input field" };
    }

    await emailInput.first().fill(loginEmail);
    await clickNext(page);
    await page.waitForTimeout(2000);
    await page.waitForLoadState("domcontentloaded").catch(() => {});

    // Step 3: Fill password
    const passwordInput = page.locator('input[type="password"]');
    if ((await passwordInput.count()) === 0) {
      return { success: false, reason: "UNKNOWN", detail: "Cannot find password input field after email step" };
    }

    await passwordInput.first().fill(loginPassword);
    await clickNext(page);
    await page.waitForTimeout(3000);
    await page.waitForLoadState("domcontentloaded").catch(() => {});

    // Step 4: Handle post-login challenges (up to 4 rounds)
    for (let round = 0; round < 4; round++) {
      const roundUrl = page.url();
      await logger.log("INFO", `[gmail-login] Round ${round + 1}, URL: ${roundUrl}`);

      // Success: landed on myaccount.google.com
      if (roundUrl.includes(SUCCESS_DOMAIN) || roundUrl.includes("mail.google.com")) {
        await logger.log("INFO", "[gmail-login] Login successful");
        return { success: true };
      }

      // --- Challenge detection ---

      // TOTP 2FA
      const totpInput = page.locator(
        'input[type="tel"], input[name="totpPin"], input[id="totpPin"], input[autocomplete="one-time-code"]'
      );
      if ((await totpInput.count()) > 0) {
        const result = await handleTotp(page, totpInput.first(), totpSecret, logger);
        if (!result.success) return result;
        await page.waitForTimeout(3000);
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        continue;
      }

      // Age / birthday verification
      const birthdayInput = page.locator(
        'input[id*="day" i], input[name*="day" i], input[id*="year" i], input[name*="year" i]'
      );
      const monthSelect = page.locator(
        'select[id*="month" i], select[name*="month" i]'
      );
      if ((await birthdayInput.count()) > 0 || (await monthSelect.count()) > 0) {
        await handleAgVerification(page, logger);
        await page.waitForTimeout(3000);
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        continue;
      }

      // Terms of service / privacy confirmation
      const agreeButton = page.locator(
        'button:has-text("I agree"), button:has-text("同意"), button:has-text("接受"), ' +
        'button:has-text("Accept"), button:has-text("Confirm"), button:has-text("確認")'
      );
      if ((await agreeButton.count()) > 0) {
        await agreeButton.first().click();
        await logger.log("INFO", "[gmail-login] Accepted ToS/privacy prompt");
        await page.waitForTimeout(2000);
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        continue;
      }

      // Phone / SMS / push notification challenge (unhandled)
      const phoneChallenge = page.locator(
        'div[data-challengetype="12"], div[data-challengetype="9"], ' +
        'input[autocomplete="tel"], input[name="phoneNumberId"], ' +
        '[aria-label*="phone" i], [aria-label*="电话" i], [aria-label*="手機" i]'
      );
      if ((await phoneChallenge.count()) > 0 || await isPhoneChallengePage(page)) {
        const detail = `Phone/SMS verification required at ${roundUrl}`;
        await logger.log("WARN", `[gmail-login] Unhandled phone challenge: ${detail}`);
        return { success: false, reason: "VERIFICATION_REQUIRED", detail };
      }

      // Unknown state — wait briefly before next round
      await page.waitForTimeout(2000);
    }

    // Exhausted rounds without success
    const finalUrl = page.url();
    if (finalUrl.includes(SUCCESS_DOMAIN)) return { success: true };

    return {
      success: false,
      reason: "UNKNOWN",
      detail: `Login did not complete after challenge handling. Final URL: ${finalUrl}`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await logger.log("ERROR", `[gmail-login] Error during login: ${detail}`);
    return { success: false, reason: "UNKNOWN", detail };
  }
}

/** Click the "Next" button (multiple language variants) */
async function clickNext(page: Page): Promise<void> {
  const nextButton = page.locator(
    'button:has-text("Next"), button:has-text("下一步"), ' +
    'button:has-text("繼續"), button:has-text("继续"), ' +
    '#identifierNext, #passwordNext'
  );
  if ((await nextButton.count()) > 0) {
    await nextButton.first().click();
  } else {
    await page.keyboard.press("Enter");
  }
}

/** Handle TOTP 2FA challenge */
async function handleTotp(
  page: Page,
  input: import("playwright").Locator,
  totpSecret: string | null | undefined,
  logger: TaskLogger
): Promise<GmailLoginResult> {
  await logger.log("INFO", "[gmail-login] TOTP 2FA challenge detected");

  if (!totpSecret) {
    return {
      success: false,
      reason: "VERIFICATION_REQUIRED",
      detail: "TOTP 2FA required but Account.totpSecret is not configured",
    };
  }

  // Wait for a fresh TOTP code if current one is about to expire
  const remaining = totpSecondsRemaining();
  if (remaining < 5) {
    await logger.log("INFO", `[gmail-login] Waiting ${remaining + 1}s for fresh TOTP`);
    await page.waitForTimeout((remaining + 1) * 1000);
  }

  const code = generateTOTP(totpSecret);
  await logger.log("INFO", `[gmail-login] Generated TOTP: ${code.slice(0, 2)}****`);

  await input.fill(code);

  const verifyBtn = page.locator(
    'button:has-text("Next"), button:has-text("下一步"), ' +
    'button:has-text("Verify"), button:has-text("驗證"), button:has-text("验证")'
  );
  if ((await verifyBtn.count()) > 0) {
    await verifyBtn.first().click();
  } else {
    await page.keyboard.press("Enter");
  }

  await logger.log("INFO", "[gmail-login] TOTP submitted");
  return { success: true }; // Provisional — outer loop will verify URL
}

/** Handle age / birthday verification — fill 1990-01-01 */
async function handleAgVerification(page: Page, logger: TaskLogger): Promise<void> {
  await logger.log("INFO", "[gmail-login] Age/birthday verification detected, filling 1990-01-01");

  // Month (select element)
  const monthSelect = page.locator('select[id*="month" i], select[name*="month" i]');
  if ((await monthSelect.count()) > 0) {
    await monthSelect.first().selectOption({ value: "1" }); // January
  }

  // Day (input)
  const dayInput = page.locator('input[id*="day" i], input[name*="day" i]');
  if ((await dayInput.count()) > 0) {
    await dayInput.first().fill("1");
  }

  // Year (input)
  const yearInput = page.locator('input[id*="year" i], input[name*="year" i]');
  if ((await yearInput.count()) > 0) {
    await yearInput.first().fill("1990");
  }

  // Confirm
  const nextBtn = page.locator(
    'button:has-text("Next"), button:has-text("下一步"), ' +
    'button:has-text("Confirm"), button:has-text("確認"), button:has-text("确认")'
  );
  if ((await nextBtn.count()) > 0) {
    await nextBtn.first().click();
  } else {
    await page.keyboard.press("Enter");
  }

  await logger.log("INFO", "[gmail-login] Birthday submitted");
}

/** Detect phone/push/SMS challenge pages heuristically */
async function isPhoneChallengePage(page: Page): Promise<boolean> {
  const url = page.url();
  if (url.includes("challenge/dp") || url.includes("challenge/ipp") || url.includes("challenge/sk")) {
    return true;
  }
  // Check for "Get a verification code" type text
  const bodyText = await page.evaluate(() => document.body?.innerText ?? "");
  return (
    bodyText.includes("verification code") ||
    bodyText.includes("验证码") ||
    bodyText.includes("驗證碼") ||
    bodyText.includes("Google prompt") ||
    bodyText.includes("Check your phone")
  );
}
