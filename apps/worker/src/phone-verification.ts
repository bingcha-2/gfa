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
        const isHardFail = result.error && /too many|can.t use|unable to|invalid number|banned|blocked|not.*valid|quota|limit/i.test(result.error);
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
      await page.waitForTimeout(2000);
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

    // If we're back on a verification page, good
    if (isVerificationPage(page.url())) {
      await forceEnglish(page, logger);
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
    return { success: false, error: `Phone rejected: ${errorText}` };
  }

  // Step 4: Poll for SMS code
  await logger.log("INFO", `[phone-verify] Polling SMS from ${phone.smsUrl}`);
  const code = await pollSmsCode(phone.smsUrl, logger);
  if (!code) {
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

  // Check for error
  const postError = await getPageError(page);
  return { success: false, error: postError ?? "Verification did not succeed" };
}

/**
 * On the selection page, click "Verify your phone number" option.
 */
async function selectPhoneVerificationOption(page: Page, logger: TaskLogger): Promise<boolean> {
  // Strategy 1: Use Playwright's getByText to find the exact text element, then click it
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

  while (Date.now() < deadline) {
    try {
      const resp = await fetch(smsUrl, { signal: AbortSignal.timeout(10000) });
      const text = await resp.text();

      let message = "";

      // Try parsing as JSON first
      try {
        const data = JSON.parse(text) as { message?: string; status?: string; code?: string; sms?: string };
        if (data.code) {
          message = data.code;
        } else if (data.message) {
          message = data.message;
        } else if (data.sms) {
          message = data.sms;
        }
      } catch {
        // Not JSON — treat entire response as the SMS text
        message = text.trim();
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
  // Wait a bit for the page to settle
  await page.waitForTimeout(3000);

  const currentUrl = page.url();
  const bodyText = await page.evaluate(() => document.body?.innerText ?? "");

  // Success indicators
  if (
    bodyText.includes("Authentication successful") ||
    bodyText.includes("authentication successful") ||
    bodyText.includes("Xác minh thành công") ||
    bodyText.includes("验证成功") ||
    bodyText.includes("認證成功") ||
    bodyText.includes("確認成功")
  ) {
    await logger.log("INFO", "[phone-verify] 🎉 Authentication successful detected");
    return true;
  }

  // If we've left the verification page, that's also success
  if (!isVerificationPage(currentUrl)) {
    await logger.log("INFO", `[phone-verify] Left verification page → success (now at: ${currentUrl})`);
    return true;
  }

  return false;
}

async function getPageError(page: Page): Promise<string | null> {
  try {
    // Google shows errors in specific elements
    const errorEl = page.locator(
      '[role="alert"], .OyEIQ, .dEOOab, .o6cuMc, ' +
      'div[jsname="B34EJ"], span[jsname="B34EJ"]'
    );
    if ((await errorEl.count()) > 0) {
      const text = await errorEl.first().innerText();
      if (text.trim()) return text.trim();
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
