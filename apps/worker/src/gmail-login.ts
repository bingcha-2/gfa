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
  | { success: false; reason: "VERIFICATION_REQUIRED" | "UNKNOWN" | "TRANSIENT"; detail: string };

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
    await clickNext(page, logger);
    await page.waitForTimeout(4000);
    await page.waitForLoadState("domcontentloaded").catch(() => {});

    // Verify the page actually advanced past the email step.
    // If still on identifier page, retry with escalating click methods.
    for (let nextRetry = 0; nextRetry < 3; nextRetry++) {
      if (!page.url().includes("/identifier")) break;
      await logger.log("WARN", `[gmail-login] Still on identifier page after Next click — retry ${nextRetry + 1}`);
      const retryEmailInput = page.locator('input[type="email"], input[id="identifierId"]');
      if ((await retryEmailInput.count()) > 0) {
        await retryEmailInput.first().fill(loginEmail);
      }
      await clickNext(page, logger, nextRetry);
      await page.waitForTimeout(5000);
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    }

    // Handle "Something went wrong" error popup (up to 2 rounds — it can appear multiple times).
    // If Restart was clicked, the page resets to the email input — re-fill email then continue.
    for (let dismissRound = 0; dismissRound < 2; dismissRound++) {
      const dismissed = await dismissErrorPopup(page, logger);
      if (!dismissed) break;

      await logger.log("INFO", `[gmail-login] Re-filling email after Restart (round ${dismissRound + 1})`);
      const emailRetry = page.locator('input[type="email"], input[id="identifierId"]');
      if ((await emailRetry.count()) > 0) {
        await emailRetry.first().fill(loginEmail);
        await clickNext(page, logger);
        await page.waitForTimeout(2000);
        await page.waitForLoadState("domcontentloaded").catch(() => {});
      }
    }

    // Step 3: Fill password — explicitly exclude aria-hidden backup fields.
    // Google has a hidden `name="hiddenPassword"` input that must never be targeted.
    // Use waitFor instead of count() to handle Angular's lazy rendering of the password step.
    const passwordInput = page.locator(
      'input[type="password"]:not([aria-hidden="true"]):not([name="hiddenPassword"])'
    );
    try {
      await passwordInput.first().waitFor({ state: "visible", timeout: 15_000 });
    } catch {
      // Password field never appeared — dump page state for debugging
      const allPwd = await page.evaluate(() =>
        Array.from(document.querySelectorAll('input[type="password"]')).map(e => ({
          name: e.getAttribute('name'), ariaHidden: e.getAttribute('aria-hidden'), visible: (e as HTMLElement).offsetParent !== null
        }))
      );
      const url = page.url();
      // TRANSIENT: page may not have advanced past email step; safe to retry
      return { success: false, reason: "TRANSIENT" as const, detail: `Password input never became visible (15s). URL: ${url} | pwd fields: ${JSON.stringify(allPwd)}` };
    }

    await passwordInput.first().fill(loginPassword);
    await clickNext(page, logger);
    await page.waitForTimeout(3000);
    await page.waitForLoadState("domcontentloaded").catch(() => {});

    // Step 4: Handle post-login challenges (up to 4 rounds)
    for (let round = 0; round < 4; round++) {
      await logger.log("INFO", `[gmail-login] Round ${round + 1}, URL: ${page.url()}`);

      // Dismiss any error popup before checking success/challenges.
      // Must re-read URL after dismiss, as Restart may navigate the page.
      await dismissErrorPopup(page, logger);
      const roundUrl = page.url();

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

      // Account recovery options page (gds.google.com/web/recoveryoptions)
      // Google shows this when it detects unusual login activity.
      // Try to dismiss it by clicking "Skip" / "Not now" variants.
      if (roundUrl.includes("recoveryoptions") || roundUrl.includes("gds.google.com")) {
        const skipResult = await handleRecoveryOptions(page, logger);
        if (!skipResult) {
          return {
            success: false,
            reason: "VERIFICATION_REQUIRED",
            detail: `Account recovery verification required (could not skip). URL: ${roundUrl}`,
          };
        }
        await page.waitForTimeout(3000);
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
async function clickNext(page: Page, logger: TaskLogger, retryRound = 0): Promise<void> {
  const nextButton = page.locator(
    'button:has-text("Next"), button:has-text("下一步"), ' +
    'button:has-text("繼續"), button:has-text("继续"), ' +
    '#identifierNext, #passwordNext'
  );
  if ((await nextButton.count()) > 0) {
    const btn = nextButton.first();
    if (retryRound >= 2) {
      // Escalation: use JavaScript click to bypass any overlay
      try {
        await btn.evaluate((el: HTMLElement) => el.click());
        await logger.log("INFO", "[gmail-login] Used JS click for Next button");
      } catch {
        // Element may have been removed — fall back to Enter key
        await page.keyboard.press("Enter");
      }
    } else {
      try {
        await btn.click({ timeout: 5000 });
      } catch {
        // Playwright click failed (intercepted/timeout) — try JS click, then Enter
        try {
          await btn.evaluate((el: HTMLElement) => el.click());
          await logger.log("WARN", "[gmail-login] Playwright click failed, used JS click fallback");
        } catch {
          await page.keyboard.press("Enter");
          await logger.log("WARN", "[gmail-login] Both click methods failed, used Enter key");
        }
      }
    }
  } else {
    await page.keyboard.press("Enter");
  }
}

/**
 * Detect and dismiss Google's "Something went wrong / Restart" error popup.
 * Returns true if the popup was found and Restart was clicked (caller should retry the step).
 */
async function dismissErrorPopup(page: Page, logger: TaskLogger): Promise<boolean> {
  const restartBtn = page.locator(
    'button:has-text("Restart"), button:has-text("重新開始"), button:has-text("重新启动"), ' +
    'button:has-text("重试"), button:has-text("重試")'
  );
  if ((await restartBtn.count()) === 0) return false;

  await logger.log("WARN", "[gmail-login] 'Something went wrong' popup detected — clicking Restart");
  await restartBtn.first().click();
  await page.waitForTimeout(3000);
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  return true;
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

  // Submit via Enter key — more reliable than clicking the Verify button,
  // because Google's kPY6ve overlay div intercepts pointer events during processing.
  await page.keyboard.press("Enter");

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

/**
 * Handle Google's account recovery options page (gds.google.com/web/recoveryoptions).
 * Attempts to dismiss it by clicking "Skip" / "Not now" variants.
 * Returns true if successfully dismissed, false if no skip button found.
 */
async function handleRecoveryOptions(page: Page, logger: TaskLogger): Promise<boolean> {
  await logger.log("INFO", "[gmail-login] Account recovery options page detected — trying to skip");

  const skipBtn = page.locator([
    'button:has-text("Skip")',
    'button:has-text("Not now")',
    'button:has-text("以后再说")',
    'button:has-text("以後再說")',
    'button:has-text("稍後")',
    'button:has-text("稍后")',
    'button:has-text("取消")',
    'a:has-text("Skip")',
    'a:has-text("Not now")',
  ].join(", "));

  if ((await skipBtn.count()) > 0) {
    await skipBtn.first().click();
    await logger.log("INFO", "[gmail-login] Clicked skip on recovery options page");
    return true;
  }

  // Dump page text to help debug what buttons are present
  const bodySnippet = await page.evaluate(() => document.body?.innerText?.slice(0, 400) ?? "").catch(() => "?");
  await logger.log("WARN", `[gmail-login] No skip button found on recovery page. Body: ${bodySnippet}`);
  return false;
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
