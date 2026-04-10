/**
 * Phone verification automation module.
 *
 * Handles Google's "uplevelingstep" phone verification challenge:
 *   1. Detects if current page is a verification selection page
 *   2. Selects "Verify your phone number" option
 *   3. Inputs phone number
 *   4. Polls sms222.us for verification code (extracts G-XXXXXX)
 *   5. Submits verification code
 *   6. Confirms "Authentication successful"
 *
 * Used by both accept-invite and dedicated phone-verify flows.
 */

import type { Page } from "playwright";
import type { TaskLogger } from "./task-logger";
import type { PhoneInfo } from "@gfa/shared";

/** How long to poll for SMS code (ms) */
const SMS_POLL_TIMEOUT_MS = 30_000;
/** Interval between SMS polls */
const SMS_POLL_INTERVAL_MS = 3_000;

export interface PhoneVerifyResult {
  /** Whether verification was needed */
  needed: boolean;
  /** Whether verification was successfully completed */
  resolved: boolean;
  /** Phone number that was successfully used */
  usedPhone?: string;
  /** Phone numbers that failed / are unusable */
  disabledPhones: string[];
  /** Error message if failed */
  error?: string;
}

/**
 * Check if the current page is a Google verification page (uplevelingstep).
 */
export function isVerificationPage(url: string): boolean {
  return (
    url.includes("uplevelingstep") ||
    url.includes("InteractiveLogin/signconsent") ||
    url.includes("challenge/selection")
  );
}

/**
 * Main entry point: detect and handle phone verification.
 *
 * Call this after login when the browser might be on a verification page.
 * If the page is not a verification page, returns { needed: false }.
 * If no phones provided, returns { needed: true, resolved: false }.
 */
export async function handlePhoneVerification(
  page: Page,
  phones: PhoneInfo[],
  logger: TaskLogger
): Promise<PhoneVerifyResult> {
  const disabledPhones: string[] = [];

  // Check if we're on a verification page
  const currentUrl = page.url();
  if (!isVerificationPage(currentUrl)) {
    return { needed: false, resolved: false, disabledPhones };
  }

  await logger.log("INFO", `[phone-verify] Verification page detected: ${currentUrl}`);

  if (!phones || phones.length === 0) {
    await logger.log("WARN", "[phone-verify] No phone numbers available — skipping verification");
    return { needed: true, resolved: false, disabledPhones, error: "No phone numbers provided" };
  }

  // Force English for consistent element detection
  await forceEnglish(page, logger);

  // Try each phone number until one works
  for (const phone of phones) {
    await logger.log("INFO", `[phone-verify] Trying phone: ${maskPhone(phone.phoneNumber)}`);

    try {
      const result = await attemptVerification(page, phone, logger);
      if (result.success) {
        await logger.log("INFO", `[phone-verify] ✅ Verification successful with ${maskPhone(phone.phoneNumber)}`);
        return {
          needed: true,
          resolved: true,
          usedPhone: phone.phoneNumber,
          disabledPhones,
        };
      } else {
        await logger.log("WARN", `[phone-verify] Phone ${maskPhone(phone.phoneNumber)} failed: ${result.error}`);
        // Only disable if Google explicitly rejected the number (hard failure)
        // Soft failures (selector bug, timeout, network) are NOT the phone's fault
        const isHardFail = result.error && /too many|can.t use|unable to|invalid number|banned|blocked|not.*valid|not.*recogni|didn.t recogni|quota|limit/i.test(result.error);
        if (isHardFail) {
          disabledPhones.push(phone.phoneNumber);
          await logger.log("INFO", `[phone-verify] Hard failure — disabling phone ${maskPhone(phone.phoneNumber)}`);
        } else {
          await logger.log("INFO", `[phone-verify] Soft failure — keeping phone ${maskPhone(phone.phoneNumber)} available`);
        }

        // Navigate back to the verification selection page so the next phone
        // starts from the "enter phone number" step, not the "enter code" step.
        await resetToVerificationPage(page, logger);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await logger.log("WARN", `[phone-verify] Error with ${maskPhone(phone.phoneNumber)}: ${errMsg}`);
      // Exceptions are always soft failures — don't disable
      await logger.log("INFO", `[phone-verify] Exception (soft) — keeping phone ${maskPhone(phone.phoneNumber)} available`);

      // Also reset page for next attempt
      await resetToVerificationPage(page, logger);
    }
  }

  await logger.log("WARN", "[phone-verify] All phone numbers exhausted");
  return {
    needed: true,
    resolved: false,
    disabledPhones,
    error: "All phone numbers failed verification",
  };
}

// ────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────

async function forceEnglish(page: Page, logger: TaskLogger): Promise<void> {
  try {
    const url = new URL(page.url());
    if (url.hostname.includes("google") && url.searchParams.get("hl") !== "en") {
      url.searchParams.set("hl", "en");
      await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 15000 });
      // Wait for page content to actually render after language switch
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      await logger.log("DEBUG", "[phone-verify] Switched page language to English");
    }
  } catch {
    // ignore
  }
}

/**
 * Navigate back to the verification selection page so the next phone attempt
 * starts from a clean state (phone input step, not code input step).
 * Uses browser back to return to the selection step within the verification flow.
 */
async function resetToVerificationPage(page: Page, logger: TaskLogger): Promise<void> {
  try {
    // Try going back twice to get past the "enter code" and "enter phone" steps
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // If we're back on a verification page, wait for content to load
    if (isVerificationPage(page.url())) {
      await forceEnglish(page, logger);
      // Wait for the "Verify your phone number" option to appear
      await page.getByText("Verify your phone number", { exact: false }).first()
        .waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
      await logger.log("DEBUG", "[phone-verify] Reset to verification page via back navigation");
      return;
    }

    // Fallback: navigate to Google account page to re-trigger verification
    await page.goto("https://myaccount.google.com/?hl=en", {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await page.waitForTimeout(3000);
    await logger.log("DEBUG", `[phone-verify] Reset via myaccount, now at: ${page.url()}`);
  } catch {
    // ignore — best effort
  }
}

async function attemptVerification(
  page: Page,
  phone: PhoneInfo,
  logger: TaskLogger
): Promise<{ success: boolean; error?: string }> {
  // Step 1: Select "Verify your phone number" if on selection page
  const pageUrl = page.url();
  if (pageUrl.includes("selection") || pageUrl.includes("uplevelingstep")) {
    const selected = await selectPhoneVerificationOption(page, logger);
    if (!selected) {
      return { success: false, error: "Could not find phone verification option" };
    }
    // Wait for navigation to phone input page after clicking the option
    const selectionUrl = page.url();
    await Promise.race([
      page.waitForURL((url) => url.toString() !== selectionUrl, { timeout: 15000 }).catch(() => {}),
      page.locator('input[type="tel"]').first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {}),
      page.locator('#phoneNumberId').first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {}),
    ]);
  }

  // Step 2: Enter phone number
  const fullNumber = phone.countryCode + phone.phoneNumber.replace(/^0+/, "");
  const phoneEntered = await enterPhoneNumber(page, fullNumber, logger);
  if (!phoneEntered) {
    return { success: false, error: "Could not enter phone number" };
  }

  // Step 3: Click send/next button
  await clickSendCode(page, logger);
  await page.waitForTimeout(5000);

  // Check for errors (invalid number, etc.)
  const errorText = await getPageError(page);
  if (errorText) {
    await logger.log("WARN", `[phone-verify] Page error after sending: ${errorText}`);
    return { success: false, error: errorText };
  }

  // Step 4: Poll for SMS code
  await logger.log("INFO", `[phone-verify] Polling SMS from ${phone.smsUrl}`);
  const code = await pollSmsCode(phone.smsUrl, logger);
  if (!code) {
    // Before giving up, check if Google showed an error while we were polling
    const lateError = await getPageError(page);
    if (lateError) {
      await logger.log("WARN", `[phone-verify] Page error detected after SMS timeout: ${lateError}`);
      return { success: false, error: lateError };
    }
    return { success: false, error: "SMS code not received within timeout" };
  }

  await logger.log("INFO", `[phone-verify] Got verification code: ${code.substring(0, 2)}****`);

  // Step 5: Enter verification code
  const codeEntered = await enterVerificationCode(page, code, logger);
  if (!codeEntered) {
    return { success: false, error: "Could not enter verification code" };
  }

  // Step 6: Click verify/next
  await clickVerifyButton(page, logger);
  await page.waitForTimeout(5000);

  // Step 7: Check for success
  const success = await checkVerificationSuccess(page, logger);
  if (success) {
    return { success: true };
  }

  // Check for error — include page body for debugging
  const postError = await getPageError(page);
  if (!postError) {
    const bodyPreview = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    await logger.log("DEBUG", `[phone-verify] No error element found. Page body: ${bodyPreview.substring(0, 500)}`);
  }
  return { success: false, error: postError ?? "Verification did not succeed" };
}

/**
 * On the selection page, click "Verify your phone number" option.
 */
async function selectPhoneVerificationOption(page: Page, logger: TaskLogger): Promise<boolean> {
  // Strategy 1: Use Playwright's getByText to find the exact text element, then click it
  // Wait for the page content to be ready before looking for options
  await page.getByText("Verify your phone number", { exact: false }).first()
    .waitFor({ state: "visible", timeout: 15000 }).catch(() => {
    // If main text not found, try alternative
  });

  // This is more precise than div:has-text() which matches all ancestor elements
  const textPatterns = [
    "Verify your phone number",
    "phone number",
    "SMS",
    "text message",
  ];

  for (const pattern of textPatterns) {
    try {
      const el = page.getByText(pattern, { exact: false }).first();
      if ((await el.count()) > 0 && (await el.isVisible())) {
        await el.click();
        await logger.log("INFO", `[phone-verify] Clicked text element: "${pattern}"`);
        // Log post-click state
        await page.waitForTimeout(1000);
        await logger.log("DEBUG", `[phone-verify] Post-click URL: ${page.url()}`);
        return true;
      }
    } catch {
      // continue
    }
  }

  // Strategy 2: data-challengetype attributes (Google's internal markers)
  const challengeSelectors = [
    'div[data-challengetype="12"]',
    'li[data-challengetype="12"]',
    'div[data-challengetype="9"]',
    'li[data-challengetype="9"]',
  ];

  for (const selector of challengeSelectors) {
    try {
      const el = page.locator(selector).first();
      if ((await el.count()) > 0 && (await el.isVisible())) {
        await el.click();
        await logger.log("INFO", `[phone-verify] Selected phone option via: ${selector}`);
        return true;
      }
    } catch {
      // continue
    }
  }

  // Fallback: look for any clickable element with phone/SMS text
  try {
    const bodyText = await page.evaluate(() => document.body?.innerText ?? "");
    const hasPhoneOption =
      bodyText.includes("phone number") ||
      bodyText.includes("SMS") ||
      bodyText.includes("text message");

    if (hasPhoneOption) {
      // Try clicking by role
      const options = page.locator('[role="link"], [role="button"], li, div[tabindex]');
      const count = await options.count();
      for (let i = 0; i < count; i++) {
        const text = await options.nth(i).innerText().catch(() => "");
        if (
          text.toLowerCase().includes("phone") ||
          text.toLowerCase().includes("sms") ||
          text.toLowerCase().includes("text message") ||
          text.toLowerCase().includes("điện thoại") ||
          text.toLowerCase().includes("手机") ||
          text.toLowerCase().includes("電話")
        ) {
          await options.nth(i).click();
          await logger.log("INFO", `[phone-verify] Selected phone option by text match: "${text.substring(0, 50)}"`);
          return true;
        }
      }
    }
  } catch {
    // ignore
  }

  await logger.log("WARN", "[phone-verify] Could not find phone verification option on page");
  return false;
}

async function enterPhoneNumber(page: Page, number: string, logger: TaskLogger): Promise<boolean> {
  const phoneInput = page.locator(
    'input[type="tel"], input[autocomplete="tel"], input[name="phoneNumberId"], ' +
    'input[id*="phone" i], input[aria-label*="phone" i], input[placeholder*="phone" i]'
  );

  // Wait for phone input to appear
  try {
    await phoneInput.first().waitFor({ state: "visible", timeout: 10000 });
  } catch {
    await logger.log("WARN", "[phone-verify] Phone input not found");
    return false;
  }

  await phoneInput.first().fill(number);
  await logger.log("INFO", `[phone-verify] Entered phone number: ${maskPhone(number)}`);
  return true;
}

async function clickSendCode(page: Page, logger: TaskLogger): Promise<void> {
  const sendBtn = page.locator(
    [
      'button:has-text("Send")',
      'button:has-text("Next")',
      'button:has-text("Continue")',
      'button:has-text("Get code")',
      'button[type="submit"]',
      'button[jsname="LgbsSe"]',
      'div[role="button"][jsname="LgbsSe"]',
    ].join(", ")
  );

  if ((await sendBtn.count()) > 0) {
    await sendBtn.first().evaluate((el: HTMLElement) => el.click());
    await logger.log("INFO", "[phone-verify] Clicked send/next button");
  } else {
    await page.keyboard.press("Enter");
    await logger.log("INFO", "[phone-verify] Pressed Enter to submit phone");
  }
}

/**
 * Poll sms222.us for the verification code.
 * Expected response: {"message":"G-436128 ...","status":"success"}
 * Extract code via regex: G-(\d{6})
 */
async function pollSmsCode(smsUrl: string, logger: TaskLogger): Promise<string | null> {
  const deadline = Date.now() + SMS_POLL_TIMEOUT_MS;
  let lastMessage = "";
  let consecutiveFailCount = 0;

  while (Date.now() < deadline) {
    try {
      const resp = await fetch(smsUrl, { signal: AbortSignal.timeout(10000) });
      const text = await resp.text();

      let message = "";
      let isApiError = false;

      // Try parsing as JSON first
      try {
        const data = JSON.parse(text) as { message?: string; status?: string; code?: string; sms?: string };

        // Detect SMS API returning explicit failure/error status
        if (data.status === "fail" || data.status === "error") {
          consecutiveFailCount++;
          if (consecutiveFailCount >= 3) {
            await logger.log("WARN", `[phone-verify] SMS API returned fail/error ${consecutiveFailCount} times — number may not receive SMS`);
            // Don't return null immediately on first fail; Google might be slow to send
            // But after 3 consecutive fails, keep polling (the deadline will handle timeout)
          }
          isApiError = true;
        } else {
          consecutiveFailCount = 0;
        }

        if (data.code) {
          message = data.code;
        } else if (data.message && !isApiError) {
          message = data.message;
        } else if (data.sms) {
          message = data.sms;
        }
      } catch {
        // Not JSON — treat entire response as the SMS text
        message = text.trim();
        consecutiveFailCount = 0;
      }

      if (message && message !== lastMessage) {
        lastMessage = message;

        // Extract G-XXXXXX code
        const match = message.match(/G-(\d{6})/);
        if (match) {
          return match[1];
        }

        // Fallback: try any 6-digit code
        const fallback = message.match(/(\d{6})/);
        if (fallback) {
          await logger.log("DEBUG", `[phone-verify] Using fallback 6-digit code: ${fallback[1]}`);
          return fallback[1];
        }

        await logger.log("DEBUG", `[phone-verify] SMS response has no code: ${message.substring(0, 80)}`);
      }
    } catch (err) {
      // Network error — continue polling
      await logger.log("DEBUG", `[phone-verify] SMS poll error: ${err}`);
    }

    await new Promise((resolve) => setTimeout(resolve, SMS_POLL_INTERVAL_MS));
  }

  await logger.log("WARN", `[phone-verify] SMS code not received within ${SMS_POLL_TIMEOUT_MS / 1000}s`);
  return null;
}

async function enterVerificationCode(page: Page, code: string, logger: TaskLogger): Promise<boolean> {
  // NOTE: do NOT use input[type="tel"] here — it would match the phone number input
  const codeInput = page.locator(
    'input[autocomplete="one-time-code"], ' +
    'input[name="code"], input[name="pin"], input[id*="code" i], ' +
    'input[aria-label*="code" i], input[aria-label*="verification" i], ' +
    'input[type="tel"]'
  );

  try {
    await codeInput.first().waitFor({ state: "visible", timeout: 10000 });
  } catch {
    await logger.log("WARN", "[phone-verify] Verification code input not found");
    return false;
  }

  await codeInput.first().fill(code);
  await logger.log("INFO", "[phone-verify] Entered verification code");
  return true;
}

async function clickVerifyButton(page: Page, logger: TaskLogger): Promise<void> {
  const verifyBtn = page.locator(
    [
      'button:has-text("Verify")',
      'button:has-text("Next")',
      'button:has-text("Continue")',
      'button:has-text("Submit")',
      'button[type="submit"]',
      'button[jsname="LgbsSe"]',
      'div[role="button"][jsname="LgbsSe"]',
    ].join(", ")
  );

  if ((await verifyBtn.count()) > 0) {
    await verifyBtn.first().evaluate((el: HTMLElement) => el.click());
    await logger.log("INFO", "[phone-verify] Clicked verify/submit button");
  } else {
    await page.keyboard.press("Enter");
    await logger.log("INFO", "[phone-verify] Pressed Enter to submit code");
  }
}

async function checkVerificationSuccess(page: Page, logger: TaskLogger): Promise<boolean> {
  // After clicking verify, Google shows "Unlocking access / This might take
  // a few seconds" while processing, then either:
  //   a) Redirects to auth_success URL (from the continue= param)
  //   b) Shows "Authentication successful" text
  //   c) Navigates away from the verification page
  //   d) Shows an error (handled by caller)
  //
  // Use Promise.race to wait for whichever signal fires first.

  const startUrl = page.url();

  try {
    const signal = await Promise.race([
      // Signal 1: URL contains auth_success (Google's redirect after verification)
      page.waitForURL((url) => url.toString().includes("auth_success"), { timeout: 30000 })
        .then(() => "auth_success_url"),

      // Signal 2: Page navigated away from verification / accounts.google.com entirely
      page.waitForURL((url) => {
        const u = url.toString();
        return u !== startUrl && !isVerificationPage(u) && !u.includes("accounts.google.com/signin");
      }, { timeout: 30000 })
        .then(() => "left_verification"),

      // Signal 3: "Authentication successful" text appears on page
      page.getByText("Authentication successful", { exact: false }).first()
        .waitFor({ state: "visible", timeout: 30000 })
        .then(() => "auth_success_text"),

      // Signal 4: Chinese/Vietnamese variants of success text
      page.getByText(/验证成功|認證成功|確認成功|Xác minh thành công/).first()
        .waitFor({ state: "visible", timeout: 30000 })
        .then(() => "auth_success_i18n"),

      // Timeout fallback (shouldn't trigger before the 30s above, but just in case)
      page.waitForTimeout(32000).then(() => "timeout"),
    ]);

    if (signal === "timeout") {
      return false;
    }

    await logger.log("INFO", `[phone-verify] 🎉 Verification success detected (signal: ${signal})`);
    return true;
  } catch {
    // All promises rejected/timed out
    return false;
  }
}

async function getPageError(page: Page): Promise<string | null> {
  try {
    // Strategy 1: Google shows errors in specific elements
    const errorEl = page.locator(
      '[role="alert"], .OyEIQ, .dEOOab, .o6cuMc, ' +
      'div[jsname="B34EJ"], span[jsname="B34EJ"], ' +
      // Additional selectors for Google's verification error messages
      '.LXRPh, .GQ8Pzc, .EjBTad, ' +
      'div[class*="error" i], span[class*="error" i], ' +
      'div[aria-live="polite"][class*="err" i], div[aria-live="assertive"]'
    );
    if ((await errorEl.count()) > 0) {
      const text = await errorEl.first().innerText();
      if (text.trim()) return text.trim();
    }

    // Strategy 2: Scan page body for known error patterns
    // This catches errors displayed in elements we don't have selectors for
    const bodyText = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    const errorPatterns = [
      /this phone number has already been used too many times/i,
      /too many (failed )?attempts/i,
      /phone number .* not valid/i,
      /couldn.t verify .* number/i,
      /number .* can.t be used/i,
      /try again later/i,
      /temporarily blocked/i,
      /unusual activity/i,
      /sorry.*couldn.t verify/i,
      /didn.t recogni[sz]e the number/i,
      /check the country and number/i,
    ];

    for (const pattern of errorPatterns) {
      const match = bodyText.match(pattern);
      if (match) {
        // Extract the sentence containing the error for better context
        const idx = bodyText.indexOf(match[0]);
        const start = Math.max(0, bodyText.lastIndexOf('.', idx) + 1);
        const end = Math.min(bodyText.length, bodyText.indexOf('.', idx + match[0].length) + 1 || idx + 200);
        return bodyText.substring(start, end).trim() || match[0];
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function maskPhone(phone: string): string {
  if (phone.length <= 4) return "****";
  return phone.substring(0, phone.length - 4).replace(/\d/g, "*") + phone.substring(phone.length - 4);
}
