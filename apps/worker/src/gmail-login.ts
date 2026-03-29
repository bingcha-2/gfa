/**
 * Gmail login automation module.
 *
 * Handles the full Google account login flow on accounts.google.com,
 * including 6 types of occasional verification challenges:
 *
 *  1. Normal email + password flow
 *  2. TOTP 2FA (Google Authenticator)
 *  3. Age/birthday verification → auto-fill adult birthdate (1990-01-01)
 *  4. Terms of service / privacy confirmation → auto-accept
 *  5. Phone/SMS verification code → fall back to MANUAL_REVIEW
 *  6. Challenge selection page → auto-select TOTP if available
 *
 * Returns { success: true } on successful login, or
 * { success: false, reason, detail } when manual intervention is required.
 */

import type { Page } from "playwright";
import { generateTOTP, totpSecondsRemaining } from "./totp";
import type { TaskLogger } from "./task-logger";

const GOOGLE_LOGIN_URL = "https://accounts.google.com?hl=en";
const SUCCESS_DOMAIN = "myaccount.google.com";
const LOGIN_TIMEOUT_MS = 60_000;

export type GmailLoginResult =
  | { success: true }
  | { success: false; reason: "VERIFICATION_REQUIRED" | "UNKNOWN" | "TRANSIENT" | "PHONE_CHALLENGE" | "ACCOUNT_LOCKED" | "CAPTCHA"; detail: string };

export interface LoginCredentials {
  loginEmail: string;
  loginPassword: string | null;  // null = not configured, will return VERIFICATION_REQUIRED
  totpSecret?: string | null;
}

/**
 * Verify that the currently logged-in Google account matches the target email.
 * Checks the page body text on myaccount.google.com for the expected email.
 * Returns false on any error (safe fallback: will trigger fresh login).
 */
async function verifyLoggedInAccount(
  page: Page,
  targetEmail: string,
  logger: TaskLogger
): Promise<boolean> {
  try {
    // myaccount.google.com shows the logged-in user's email in the page
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => { });
    const bodyText = await page.textContent("body", { timeout: 5_000 }).catch(() => "") ?? "";
    const match = bodyText.toLowerCase().includes(targetEmail.toLowerCase());
    if (!match) {
      await logger.log("WARN", `[gmail-login] Session email mismatch: expected ${targetEmail}, not found in page`);
    }
    return match;
  } catch {
    // On any error, return false to safely trigger fresh login
    return false;
  }
}

export async function gmailLogin(
  page: Page,
  credentials: LoginCredentials,
  logger: TaskLogger
): Promise<GmailLoginResult> {
  const { loginEmail, loginPassword, totpSecret } = credentials;

  await logger.log("INFO", `[gmail-login] Starting login for ${loginEmail}`);

  // --- Session reuse: check if browser already has a valid session ---
  const currentUrl = page.url();
  if (currentUrl.includes(SUCCESS_DOMAIN) || currentUrl.includes("mail.google.com")) {
    // Verify the session belongs to the correct account
    const isCorrect = await verifyLoggedInAccount(page, loginEmail, logger);
    if (isCorrect) {
      await logger.log("INFO", "[gmail-login] Existing session verified — correct account, skipping login");
      return { success: true };
    }
    // Wrong account — clear cookies and proceed with fresh login
    await logger.log("WARN", `[gmail-login] Session exists but for WRONG account, clearing cookies`);
    await page.context().clearCookies();
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
      // Already logged in? (redirect after navigation)
      if (page.url().includes(SUCCESS_DOMAIN)) {
        const isCorrect = await verifyLoggedInAccount(page, loginEmail, logger);
        if (isCorrect) {
          await logger.log("INFO", "[gmail-login] Already logged in (correct account), skipping login");
          return { success: true };
        }
        // Wrong account — clear and restart login
        await logger.log("WARN", "[gmail-login] Redirected to myaccount but wrong account, clearing cookies");
        await page.context().clearCookies();
        await page.goto(GOOGLE_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: LOGIN_TIMEOUT_MS });
        await page.waitForTimeout(2000);
        // Re-check for email input after fresh navigation
        const emailInput2 = page.locator('input[type="email"], input[id="identifierId"]');
        if ((await emailInput2.count()) === 0) {
          return { success: false, reason: "UNKNOWN", detail: "Cannot find email input field after cookie clear" };
        }
      } else {
        return { success: false, reason: "UNKNOWN", detail: "Cannot find email input field" };
      }
    }

    await emailInput.first().fill(loginEmail);
    await clickNext(page, logger, 0, "identifier");
    // Wait for page to advance past identifier step (smart wait, up to 4s)
    await page.waitForURL((url) => !url.toString().includes("/identifier"), { timeout: 4000 }).catch(() => { });
    await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => { });

    // Verify the page actually advanced past the email step.
    // If still on identifier page, retry with escalating click methods.
    for (let nextRetry = 0; nextRetry < 3; nextRetry++) {
      if (!page.url().includes("/identifier")) break;
      await logger.log("WARN", `[gmail-login] Still on identifier page after Next click — retry ${nextRetry + 1}`);
      const retryEmailInput = page.locator('input[type="email"], input[id="identifierId"]');
      if ((await retryEmailInput.count()) > 0) {
        await retryEmailInput.first().fill(loginEmail);
      }
      await clickNext(page, logger, nextRetry, "identifier");
      await page.waitForTimeout(5000);
      await page.waitForLoadState("domcontentloaded").catch(() => { });
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
        await clickNext(page, logger, 0, "identifier");
        await page.waitForTimeout(2000);
        await page.waitForLoadState("domcontentloaded").catch(() => { });
      }
    }

    // Step 3: Fill password — explicitly exclude aria-hidden backup fields.
    // Google has a hidden `name="hiddenPassword"` input that must never be targeted.
    // Use waitFor instead of count() to handle Angular's lazy rendering of the password step.
    const passwordInput = page.locator(
      'input[type="password"]:not([aria-hidden="true"]):not([name="hiddenPassword"])'
    );
    try {
      await passwordInput.first().waitFor({ state: "visible", timeout: 8_000 });
    } catch {
      // Password field never appeared — check if page redirected to a known challenge
      const url = page.url();

      // CAPTCHA triggered before password step
      if (await isCaptchaPage(page, url)) {
        const detail = `CAPTCHA challenge before password step at ${url}`;
        await logger.log("WARN", `[gmail-login] Pre-password CAPTCHA: ${detail}`);
        return { success: false, reason: "CAPTCHA", detail };
      }

      // Account locked/disabled before password step
      if (await isAccountLockedPage(page, url)) {
        const detail = `Account locked/disabled before password step at ${url}`;
        await logger.log("WARN", `[gmail-login] Pre-password account lock: ${detail}`);
        return { success: false, reason: "ACCOUNT_LOCKED", detail };
      }

      // Phone challenge before password step
      if (await isPhoneChallengePage(page)) {
        const detail = `Phone challenge before password step at ${url}`;
        await logger.log("WARN", `[gmail-login] Pre-password phone challenge: ${detail}`);
        return { success: false, reason: "PHONE_CHALLENGE", detail };
      }

      // Dump page state for debugging unknown cases
      const allPwd = await page.evaluate(() =>
        Array.from(document.querySelectorAll('input[type="password"]')).map(e => ({
          name: e.getAttribute('name'), ariaHidden: e.getAttribute('aria-hidden'), visible: (e as HTMLElement).offsetParent !== null
        }))
      );
      // TRANSIENT: page may not have advanced past email step; safe to retry
      return { success: false, reason: "TRANSIENT" as const, detail: `Password input never became visible (15s). URL: ${url} | pwd fields: ${JSON.stringify(allPwd)}` };
    }

    await passwordInput.first().fill(loginPassword);
    await clickNext(page, logger, 0, "password");
    await page.waitForTimeout(3000);
    await page.waitForLoadState("domcontentloaded").catch(() => { });

    // Step 4: Handle post-login challenges (up to 8 rounds)
    let totpSubmitted = false;
    for (let round = 0; round < 8; round++) {
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

      // Password page still showing (e.g. Google needed extra time to process)
      // Re-click Next to submit and avoid wasting a round
      if (roundUrl.includes("/challenge/pwd")) {
        const pwdInput = page.locator(
          'input[type="password"]:not([aria-hidden="true"]):not([name="hiddenPassword"])'
        );
        if ((await pwdInput.count()) > 0 && await pwdInput.first().isVisible()) {
          await logger.log("WARN", "[gmail-login] Still on password page — re-submitting");
          await pwdInput.first().fill(loginPassword);
          await clickNext(page, logger);
        } else {
          await logger.log("WARN", "[gmail-login] On pwd URL but no visible input — waiting");
        }
        await page.waitForTimeout(3000);
        await page.waitForLoadState("domcontentloaded").catch(() => { });
        continue;
      }

      // TOTP 2FA
      const totpInput = page.locator(
        'input[type="tel"], input[name="totpPin"], input[id="totpPin"], input[autocomplete="one-time-code"]'
      );
      if ((await totpInput.count()) > 0) {
        // If TOTP was already submitted in a previous round, the code was rejected.
        // Wait for the next 30s TOTP window to get a fresh code.
        if (totpSubmitted) {
          const waitSecs = totpSecondsRemaining() + 2;
          await logger.log("WARN", `[gmail-login] TOTP rejected — waiting ${waitSecs}s for next code window`);
          await page.waitForTimeout(waitSecs * 1000);
        }
        const result = await handleTotp(page, totpInput.first(), totpSecret, logger);
        if (!result.success) return result;
        totpSubmitted = true;
        await page.waitForTimeout(3000);
        await page.waitForLoadState("domcontentloaded").catch(() => { });
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
        await page.waitForLoadState("domcontentloaded").catch(() => { });
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
        await page.waitForLoadState("domcontentloaded").catch(() => { });
        continue;
      }

      // GDS setup pages (gds.google.com): recovery options, welcome, home address.
      // Google shows these on first login for new accounts.
      // handleRecoveryOptions clicks through dismiss buttons and falls back to
      // direct myaccount navigation if no dismiss button is found.
      if (roundUrl.includes("gds.google.com")) {
        await handleRecoveryOptions(page, logger);
        continue;
      }

      // Account locked / disabled by Google
      if (await isAccountLockedPage(page, roundUrl)) {
        const detail = `Account locked/disabled by Google at ${roundUrl}`;
        await logger.log("WARN", `[gmail-login] Account locked: ${detail}`);
        return { success: false, reason: "ACCOUNT_LOCKED", detail };
      }

      // CAPTCHA / reCAPTCHA challenge
      if (await isCaptchaPage(page, roundUrl)) {
        const detail = `CAPTCHA challenge required at ${roundUrl}`;
        await logger.log("WARN", `[gmail-login] CAPTCHA detected: ${detail}`);
        return { success: false, reason: "CAPTCHA", detail };
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
        return { success: false, reason: "PHONE_CHALLENGE", detail };
      }

      // Challenge selection page — Google asks user to pick a verification method.
      // Try to select TOTP (Google Authenticator) if available, then let the outer
      // loop handle the actual TOTP input on the next round.
      if (roundUrl.includes("challenge/selection")) {
        const handled = await handleChallengeSelection(page, totpSecret, logger);
        if (!handled) {
          const detail = `Challenge selection page with no automated option at ${roundUrl}`;
          await logger.log("WARN", `[gmail-login] Cannot auto-select challenge: ${detail}`);
          return { success: false, reason: "VERIFICATION_REQUIRED", detail };
        }
        await page.waitForTimeout(3000);
        await page.waitForLoadState("domcontentloaded").catch(() => { });
        continue;
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

    // Network errors are transient — BullMQ should retry, never MANUAL_REVIEW
    const NETWORK_ERROR_PATTERNS = [
      "ERR_CONNECTION_RESET",
      "ERR_CONNECTION_REFUSED",
      "ERR_CONNECTION_CLOSED",
      "ERR_TIMED_OUT",
      "ERR_NAME_NOT_RESOLVED",
      "ERR_INTERNET_DISCONNECTED",
      "ERR_NETWORK_CHANGED",
      "ERR_PROXY_CONNECTION_FAILED",
      "ERR_EMPTY_RESPONSE",
      "ERR_SSL",
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "Target closed",
      "Browser closed",
      "Session closed",
      "browser has been closed",
      "Execution context was destroyed",
    ];
    const isNetworkError = NETWORK_ERROR_PATTERNS.some((p) => detail.includes(p));
    if (isNetworkError) {
      return { success: false, reason: "TRANSIENT" as const, detail };
    }

    return { success: false, reason: "UNKNOWN", detail };
  }
}

/**
 * Click the "Next" button with step-aware selectors.
 * @param step  "identifier" → only #identifierNext; "password" → only #passwordNext;
 *              omitted → generic selector for TOTP/other steps.
 */
async function clickNext(
  page: Page,
  logger: TaskLogger,
  retryRound = 0,
  step?: "identifier" | "password"
): Promise<void> {
  let selector: string;
  if (step === "identifier") {
    // Only match the email-step Next button — never the password-step one
    selector = '#identifierNext';
  } else if (step === "password") {
    // Only match the password-step Next button — never the email-step one
    selector = '#passwordNext';
  } else {
    // Generic: TOTP verify, age confirm, etc. — no #identifierNext/#passwordNext
    selector =
      'button:has-text("Next"), button:has-text("下一步"), ' +
      'button:has-text("繼續"), button:has-text("继续")';
  }

  const nextButton = page.locator(selector);
  if ((await nextButton.count()) > 0) {
    // Find the first VISIBLE button to avoid clicking hidden step buttons
    let btn = nextButton.first();
    for (let i = 0; i < await nextButton.count(); i++) {
      if (await nextButton.nth(i).isVisible().catch(() => false)) {
        btn = nextButton.nth(i);
        break;
      }
    }

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
  await page.waitForLoadState("domcontentloaded").catch(() => { });
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
 * Handle Google's account recovery / device security pages.
 * Covers both gds.google.com/web/recoveryoptions and gds.google.com/web/landing.
 * Attempts to dismiss by clicking skip/confirm/done variants.
 * Returns true if successfully dismissed, false if no actionable button found.
 */
async function handleRecoveryOptions(page: Page, logger: TaskLogger): Promise<boolean> {
  await logger.log("INFO", "[gmail-login] Account recovery/GDS page detected — trying to skip");

  // GDS pages are SPAs — wait for content to render
  await page.waitForTimeout(3000);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => { });

  // Broad set of buttons that can dismiss GDS / recovery pages.
  // GDS is a multi-card flow: recoveryoptions → welcome → homeaddress.
  // Try up to 3 rounds to click through all cards.
  for (let cardRound = 0; cardRound < 3; cardRound++) {
    // Check if we already left GDS
    const currentUrl = page.url();
    if (!currentUrl.includes("gds.google.com")) {
      await logger.log("INFO", `[gmail-login] Left GDS flow after ${cardRound} card(s)`);
      return true;
    }

    const dismissBtn = page.locator([
      // Cancel variants (recoveryoptions page)
      'button:has-text("Cancel")',
      'a:has-text("Cancel")',
      'button:has-text("取消")',
      // Skip / Not now variants
      'button:has-text("Skip")',
      'button:has-text("Not now")',
      'button:has-text("No thanks")',
      'button:has-text("以后再说")',
      'button:has-text("以後再說")',
      'button:has-text("稍後")',
      'button:has-text("稍后")',
      'button:has-text("不用了")',
      'a:has-text("Skip")',
      'a:has-text("Not now")',
      'a:has-text("No thanks")',
      'a:has-text("不用了")',
      // GDS landing page — confirm / done variants
      'button:has-text("Yes, it was me")',
      'button:has-text("Yes")',
      'button:has-text("Done")',
      'button:has-text("Continue")',
      'button:has-text("Confirm")',
      'button:has-text("完成")',
      'button:has-text("继续")',
      'button:has-text("繼續")',
      'button:has-text("確認")',
      'button:has-text("确认")',
      'button:has-text("是的")',
      'button:has-text("是，是我本人")',
      'a:has-text("Done")',
      'a:has-text("Continue")',
      'a:has-text("完成")',
      'a:has-text("继续")',
      // Material design raised buttons (GDS uses these)
      'div[role="button"]:has-text("Yes")',
      'div[role="button"]:has-text("Done")',
      'div[role="button"]:has-text("Continue")',
      'div[role="button"]:has-text("Skip")',
      'div[role="button"]:has-text("No thanks")',
      'div[role="button"]:has-text("Cancel")',
    ].join(", "));

    if ((await dismissBtn.count()) > 0) {
      const btnText = await dismissBtn.first().textContent().catch(() => "?");
      await dismissBtn.first().click();
      await logger.log("INFO", `[gmail-login] Clicked "${btnText?.trim()}" on GDS card ${cardRound + 1}`);
      await page.waitForTimeout(3000);
      await page.waitForLoadState("domcontentloaded").catch(() => { });
      continue;
    }

    // No dismiss button found on this card (e.g. homeaddress has only ← and Save)
    await logger.log("WARN", `[gmail-login] No dismiss button on GDS card ${cardRound + 1} — breaking to fallback`);
    break;
  }

  // Fallback: if still on gds.google.com, navigate directly to myaccount.
  // This reliably exits any GDS setup flow while preserving the login session.
  const afterUrl = page.url();
  if (afterUrl.includes("gds.google.com")) {
    await logger.log("INFO", "[gmail-login] GDS flow still active — navigating directly to myaccount");
    await page.goto("https://myaccount.google.com/?hl=en", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForTimeout(2000);
  }

  return true;
}

/**
 * Handle Google's challenge/selection page (verification method picker).
 *
 * When Google requires additional verification, it sometimes presents a page
 * listing available methods (TOTP, SMS, phone prompt, security key, etc.).
 * This function scans the list and clicks the TOTP / Google Authenticator
 * option so the outer loop can handle the TOTP input on the next round.
 *
 * Returns true if a suitable option was clicked, false if no automatable
 * method was found (caller should return VERIFICATION_REQUIRED).
 */
async function handleChallengeSelection(
  page: Page,
  totpSecret: string | null | undefined,
  logger: TaskLogger
): Promise<boolean> {
  await logger.log("INFO", "[gmail-login] Challenge selection page detected — scanning options");

  // Wait for the page to fully render
  await page.waitForTimeout(2000);
  await page.waitForLoadState("domcontentloaded").catch(() => { });

  // Google's challenge selection uses a list with data-challengetype attributes
  // or plain text links. Try data-challengetype first (more reliable).
  //
  // Known challenge types:
  //   6  = TOTP (Google Authenticator)
  //   12 = Phone prompt (push notification)
  //   9  = SMS verification
  //   13 = Phone call
  //   8  = Backup codes

  // Priority 1: TOTP (challengetype=6) — fully automatable if totpSecret is set
  if (totpSecret) {
    const totpOption = page.locator(
      'div[data-challengetype="6"], ' +
      'li[data-challengetype="6"], ' +
      'button[data-challengetype="6"], ' +
      '[data-challengeindex][data-challengetype="6"]'
    );
    if ((await totpOption.count()) > 0) {
      await totpOption.first().click();
      await logger.log("INFO", "[gmail-login] Selected TOTP (Google Authenticator) challenge option");
      return true;
    }

    // Fallback: look for text-based TOTP option
    const totpTextOption = page.locator([
      'li:has-text("Google Authenticator")',
      'li:has-text("Authenticator")',
      'li:has-text("authenticator")',
      'li:has-text("身份验证器")',
      'li:has-text("驗證器")',
      'div[role="link"]:has-text("Google Authenticator")',
      'div[role="link"]:has-text("Authenticator")',
      'div[role="link"]:has-text("身份验证器")',
      'a:has-text("Google Authenticator")',
      'a:has-text("Authenticator")',
      // Google may show "Enter a code from Google Authenticator" or
      // "从 Google 身份验证器获取验证码"
      'li:has-text("verification code")',
      'li:has-text("验证码")',
      'li:has-text("驗證碼")',
    ].join(", "));
    if ((await totpTextOption.count()) > 0) {
      await totpTextOption.first().click();
      await logger.log("INFO", "[gmail-login] Selected TOTP option via text match");
      return true;
    }
  }

  // Priority 2: Backup codes (challengetype=8) — not yet automated,
  // but could be in the future. Skip for now.

  // No automatable option found — log available options for debugging
  const allOptions = await page.evaluate(() => {
    const items = document.querySelectorAll(
      '[data-challengetype], li[role="link"], div[role="link"]'
    );
    return Array.from(items).map((el) => ({
      type: el.getAttribute("data-challengetype"),
      text: (el as HTMLElement).innerText?.trim().slice(0, 80),
    }));
  });
  await logger.log(
    "WARN",
    `[gmail-login] No automatable challenge option found. Available: ${JSON.stringify(allOptions)}`
  );

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

/** Detect account locked/disabled pages */
async function isAccountLockedPage(page: Page, url: string): Promise<boolean> {
  if (
    url.includes("deniedsignin") ||
    url.includes("AccountDisabled") ||
    url.includes("/disabled") ||     // path segment, not substring
    url.includes("disabled?") ||     // disabled as final path with query
    url.includes("account/suspended")
  ) {
    return true;
  }
  const bodyText = await page.evaluate(() => document.body?.innerText ?? "");
  return (
    bodyText.includes("account has been disabled") ||
    bodyText.includes("account is disabled") ||
    bodyText.includes("此帐号已被停用") ||
    bodyText.includes("此帳戶已被停用") ||
    bodyText.includes("帐号已被暂停") ||
    bodyText.includes("帳號已被暫停") ||
    bodyText.includes("Your account has been suspended")
  );
}

/** Detect CAPTCHA / reCAPTCHA challenge pages */
async function isCaptchaPage(page: Page, url: string): Promise<boolean> {
  if (url.includes("challenge/recaptcha") || url.includes("challenge/coaptcha")) {
    return true;
  }
  // Check for reCAPTCHA iframe
  const hasRecaptcha = await page
    .locator('iframe[src*="recaptcha"], iframe[title*="reCAPTCHA"], #captcha, .g-recaptcha')
    .count();
  return hasRecaptcha > 0;
}
