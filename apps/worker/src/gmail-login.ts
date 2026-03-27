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

const GOOGLE_LOGIN_URL = "https://accounts.google.com?hl=en";
const SUCCESS_DOMAIN = "myaccount.google.com";
const LOGIN_TIMEOUT_MS = 60_000;

export type GmailLoginResult =
  | { success: true }
  | { success: false; reason: "VERIFICATION_REQUIRED" | "UNKNOWN" | "TRANSIENT" | "PHONE_CHALLENGE"; detail: string };

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
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
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
    await page.waitForURL((url) => !url.toString().includes("/identifier"), { timeout: 4000 }).catch(() => {});
    await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});

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
        await clickNext(page, logger, 0, "identifier");
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
      await passwordInput.first().waitFor({ state: "visible", timeout: 8_000 });
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
    await clickNext(page, logger, 0, "password");
    await page.waitForTimeout(3000);
    await page.waitForLoadState("domcontentloaded").catch(() => {});

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
        await page.waitForLoadState("domcontentloaded").catch(() => {});
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
        return { success: false, reason: "PHONE_CHALLENGE", detail };
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
 * Handle Google's account recovery / device security pages.
 * Covers both gds.google.com/web/recoveryoptions and gds.google.com/web/landing.
 * Attempts to dismiss by clicking skip/confirm/done variants.
 * Returns true if successfully dismissed, false if no actionable button found.
 */
async function handleRecoveryOptions(page: Page, logger: TaskLogger): Promise<boolean> {
  await logger.log("INFO", "[gmail-login] Account recovery/GDS page detected — trying to skip");

  // GDS pages are SPAs — wait for content to render
  await page.waitForTimeout(3000);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

  // Broad set of buttons that can dismiss GDS / recovery pages
  const dismissBtn = page.locator([
    // Skip / Not now variants
    'button:has-text("Skip")',
    'button:has-text("Not now")',
    'button:has-text("以后再说")',
    'button:has-text("以後再說")',
    'button:has-text("稍後")',
    'button:has-text("稍后")',
    'button:has-text("取消")',
    'a:has-text("Skip")',
    'a:has-text("Not now")',
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
  ].join(", "));

  if ((await dismissBtn.count()) > 0) {
    const btnText = await dismissBtn.first().textContent().catch(() => "?");
    await dismissBtn.first().click();
    await logger.log("INFO", `[gmail-login] Clicked "${btnText?.trim()}" on recovery/GDS page`);
    await page.waitForTimeout(3000);
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    return true;
  }

  // Dump page text to help debug what buttons are present
  const bodySnippet = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? "").catch(() => "?");
  await logger.log("WARN", `[gmail-login] No dismiss button found on recovery/GDS page. Body: ${bodySnippet}`);
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
