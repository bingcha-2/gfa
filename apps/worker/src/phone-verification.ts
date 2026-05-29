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
import { captureStepScreenshot } from "./screenshot-capture";

/** How long to poll for SMS code (ms) */
const SMS_POLL_TIMEOUT_MS = 30_000;
/** Interval between SMS polls */
const SMS_POLL_INTERVAL_MS = 3_000;
/** How long to keep the browser open for a forced QR scan (ms) */
const QR_MANUAL_SCAN_TIMEOUT_MS = 10 * 60 * 1000;
const PHONE_OPTION_PATTERNS = [
    /verify (your )?phone number/i,
    /get a verification code/i,
    /send a verification code/i,
    /google will send a verification code/i,
    /use .*phone number/i,
  /text message/i,
  /\bSMS\b/i,
  /验证.*手机号/,
  /验证.*手机号码/,
  /驗證.*手機/,
  /驗證.*電話/,
  /手机号码/,
  /手机号/,
  /手機號碼/,
  /電話號碼/,
  /電話番号/,
  /số điện thoại/i,
  /tin nhắn/i,
  /n[uú]mero de tel[eé]fono/i,
  /mensaje de texto/i,
];
const QR_TEXT_PATTERNS = [
  /image of qr code to scan/i,
  /scan the qr code with your phone/i,
  /open your camera app/i,
  /you.ll need to switch back to your computer/i,
  /scan (the )?QR\s*code/i,
  /二维码/,
  /二維碼/,
  /扫码/,
  /掃描/,
  /扫描/,
  /QRコード/,
  /mã QR/i,
  /c[oó]digo QR/i,
];
const QR_VERIFICATION_ERROR = "验证失败（扫码）";

export interface PhoneVerifyResult {
  /** Whether verification was needed */
  needed: boolean;
  /** Whether verification was successfully completed */
  resolved: boolean;
  /** Phone numbers that were actually tried in this run */
  attemptedPhones?: string[];
  /** Phone number that was successfully used */
  usedPhone?: string;
  /** Full phone/SMS metadata that was successfully used */
  usedPhoneInfo?: PhoneInfo;
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
    url.includes("/challenge/iap") ||
    url.includes("/challenge/ipp") ||
    url.includes("/challenge/sk") ||
    url.includes("/challenge/dp") ||
    url.includes("challenge/selection")
  );
}

function isPreviousPhoneVerificationText(text: string): boolean {
  return (
    /get a verification code/i.test(text) ||
    /google will send a verification code/i.test(text) ||
    /verify it(?:'|’)?s you/i.test(text) ||
    /there is something unusual about your activity/i.test(text) ||
    /send a verification code/i.test(text)
  );
}

async function isPreviousPhoneVerificationPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (url.includes("/challenge/ipp") || url.includes("/challenge/sk") || url.includes("/challenge/dp")) {
    return true;
  }
  const bodyText = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  return isPreviousPhoneVerificationText(bodyText);
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
  const attemptedPhones: string[] = [];

  if (await isQrPhoneVerificationPage(page)) {
    const qrContinueUrl = getEmbeddedVerificationUrl(page.url());
    if (qrContinueUrl) {
      await logger.log("WARN", "[phone-verify] QR challenge opened but contains selection continue URL; trying selection before failing");
      await page.goto(qrContinueUrl, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
    }
  }

  if (await isQrPhoneVerificationPage(page)) {
    const qrResult = await waitForManualQrScan(page, logger, "phone-verify-qr-before-start");
    if (qrResult.success) {
      return { needed: true, resolved: true, disabledPhones };
    }
    if (qrResult.timedOut || await isQrPhoneVerificationPage(page)) {
      return { needed: true, resolved: false, disabledPhones, error: QR_VERIFICATION_ERROR };
    }
  }

  // Check if we're on a verification page
  const currentUrl = page.url();
  if (!isVerificationPage(currentUrl)) {
    return { needed: false, resolved: false, disabledPhones };
  }

  await logger.log("INFO", `[phone-verify] Verification page detected: ${currentUrl}`);
  await captureStepScreenshot(page, logger, "phone-verify-detected", "beforeScreenshotPath");
  const verificationStartUrl = await settleVerificationPage(page, logger, currentUrl);
  await captureStepScreenshot(page, logger, "phone-verify-settled-selection");

  if (await isQrPhoneVerificationPage(page)) {
    const qrResult = await waitForManualQrScan(page, logger, "phone-verify-qr-after-settle");
    if (qrResult.success) {
      return { needed: true, resolved: true, disabledPhones };
    }
    if (qrResult.timedOut || await isQrPhoneVerificationPage(page)) {
      return { needed: true, resolved: false, disabledPhones, error: QR_VERIFICATION_ERROR };
    }
  }

  if (!phones || phones.length === 0) {
    await logger.log("WARN", "[phone-verify] No phone numbers available — skipping verification");
    return { needed: true, resolved: false, disabledPhones, error: "No phone numbers provided" };
  }

  // Try each phone number until one works
  for (const phone of phones) {
    attemptedPhones.push(phone.phoneNumber);
    await logger.log("INFO", `[phone-verify] Trying phone: ${maskPhone(phone.phoneNumber)}`);
    await captureStepScreenshot(page, logger, `phone-verify-before-phone-${maskPhone(phone.phoneNumber)}`);

    try {
      const result = await attemptVerification(page, phone, logger, verificationStartUrl);
      if (result.success) {
        await captureStepScreenshot(page, logger, `phone-verify-success-${maskPhone(phone.phoneNumber)}`, "afterScreenshotPath");
        await logger.log("INFO", `[phone-verify] ✅ Verification successful with ${maskPhone(phone.phoneNumber)}`);
        return {
          needed: true,
          resolved: true,
          attemptedPhones,
          usedPhone: phone.phoneNumber,
          usedPhoneInfo: phone,
          disabledPhones,
        };
      } else {
        await captureStepScreenshot(page, logger, `phone-verify-failed-${maskPhone(phone.phoneNumber)}`, "errorScreenshotPath");
        await logger.log("WARN", `[phone-verify] Phone ${maskPhone(phone.phoneNumber)} failed: ${result.error}`);
        if (isQrVerificationError(result.error)) {
          await logger.log("WARN", "[phone-verify] QR-code flow is not retryable with another phone; stopping verification");
          return {
            needed: true,
            resolved: false,
            attemptedPhones,
            disabledPhones,
            error: QR_VERIFICATION_ERROR,
          };
        }
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
        await resetToVerificationPage(page, logger, verificationStartUrl);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await captureStepScreenshot(page, logger, `phone-verify-exception-${maskPhone(phone.phoneNumber)}`, "errorScreenshotPath");
      await logger.log("WARN", `[phone-verify] Error with ${maskPhone(phone.phoneNumber)}: ${errMsg}`);
      // Exceptions are always soft failures — don't disable
      await logger.log("INFO", `[phone-verify] Exception (soft) — keeping phone ${maskPhone(phone.phoneNumber)} available`);

      // Also reset page for next attempt
      await resetToVerificationPage(page, logger, verificationStartUrl);
    }
  }

  await logger.log("WARN", "[phone-verify] All phone numbers exhausted");
  await captureStepScreenshot(page, logger, "phone-verify-all-phones-exhausted", "errorScreenshotPath");
  return {
    needed: true,
    resolved: false,
    attemptedPhones,
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

function getEmbeddedVerificationUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes("accounts.google.com")) {
      return null;
    }
    const next = parsed.searchParams.get("continue");
    if (!next || !next.includes("accounts.google.com/uplevelingstep")) {
      return null;
    }
    return next;
  } catch {
    return null;
  }
}

async function settleVerificationPage(page: Page, logger: TaskLogger, fallbackUrl?: string): Promise<string> {
  // Check immediately before any load-state wait. signin/continue can auto-pick
  // the QR challenge while we're waiting, but the embedded continue URL still
  // points to the method selection page we need.
  const embeddedUrl = getEmbeddedVerificationUrl(page.url());
  if (embeddedUrl) {
    await logger.log("DEBUG", `[phone-verify] Opening embedded upleveling selection URL from ${page.url()}`);
    await page.goto(embeddedUrl, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
  } else if (fallbackUrl && page.url().includes("myaccount.google.com")) {
    await logger.log("DEBUG", "[phone-verify] Current page left verification flow; reopening saved validation URL");
    await page.goto(fallbackUrl, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
  }

  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

  const lateEmbeddedUrl = getEmbeddedVerificationUrl(page.url());
  if (lateEmbeddedUrl && !page.url().includes("/uplevelingstep/selection")) {
    await logger.log("DEBUG", `[phone-verify] Redirected away from selection; reopening embedded URL from ${page.url()}`);
    await page.goto(lateEmbeddedUrl, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  }

  await Promise.race([
    page.locator("[data-challengetype]").first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {}),
    page.locator(PHONE_INPUT_SELECTOR).first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {}),
    page.locator('button:has-text("Send"), button:has-text("Get a verification code"), div[role="button"]:has-text("Send")').first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {}),
    page.locator('[role="link"], [role="button"], li').first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {}),
  ]);

  await logger.log("DEBUG", `[phone-verify] Verification page settled at: ${page.url()}`);
  await captureStepScreenshot(page, logger, "phone-verify-page-settled");
  return isVerificationPage(page.url()) ? page.url() : (fallbackUrl ?? page.url());
}

/**
 * Navigate back to the verification selection page so the next phone attempt
 * starts from a clean state (phone input step, not code input step).
 * Uses browser back to return to the selection step within the verification flow.
 */
async function resetToVerificationPage(page: Page, logger: TaskLogger, fallbackUrl?: string): Promise<void> {
  try {
    // Try going back twice to get past the "enter code" and "enter phone" steps
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // If we're back on a verification page, wait for content to load
    if (isVerificationPage(page.url())) {
      await settleVerificationPage(page, logger, fallbackUrl);
      await logger.log("DEBUG", "[phone-verify] Reset to verification page via back navigation");
      return;
    }

    if (!fallbackUrl) {
      await logger.log("DEBUG", `[phone-verify] No saved verification URL for reset; current page: ${page.url()}`);
      return;
    }

    // Fallback: reopen the saved validation URL. Navigating to myaccount loses
    // the uplevelingstep context and makes later phone attempts fail.
    await page.goto(fallbackUrl, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    await settleVerificationPage(page, logger, fallbackUrl);
    await logger.log("DEBUG", `[phone-verify] Reset via saved validation URL, now at: ${page.url()}`);
  } catch {
    // ignore — best effort
  }
}

function isQrCompletionUrl(url: string): boolean {
  return (
    url.includes("auth_success") ||
    url.includes("auth_success_gemini") ||
    (
      !isVerificationPage(url) &&
      !url.includes("accounts.google.com/signin") &&
      !/\/challenge\/iap\/qrcode/i.test(url) &&
      !/[?&]challengeType=qrcode/i.test(url)
    )
  );
}

async function waitForManualQrScan(
  page: Page,
  logger: TaskLogger,
  label: string
): Promise<{ success: boolean; timedOut: boolean }> {
  if (!(await isQrPhoneVerificationPage(page))) {
    return { success: false, timedOut: false };
  }

  await captureStepScreenshot(page, logger, label, "errorScreenshotPath");
  await logger.log("WARN", "[phone-verify] Forced QR verification detected; manual QR waiting is disabled, closing browser session");

  // Manual QR scan waiting intentionally disabled. A QR challenge means this
  // account should be marked in the pool and replaced by an activated child.
  return { success: false, timedOut: true };
}

async function attemptVerification(
  page: Page,
  phone: PhoneInfo,
  logger: TaskLogger,
  verificationStartUrl?: string
): Promise<{ success: boolean; error?: string }> {
  if (await isQrPhoneVerificationPage(page)) {
    const qrContinueUrl = getEmbeddedVerificationUrl(page.url());
    if (qrContinueUrl) {
      await logger.log("WARN", "[phone-verify] QR challenge opened during attempt; trying embedded selection URL");
      await page.goto(qrContinueUrl, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
    }
  }

  if (await isQrPhoneVerificationPage(page)) {
    const qrResult = await waitForManualQrScan(page, logger, "phone-verify-qr-before-attempt");
    if (qrResult.success) {
      return { success: true };
    }
    if (qrResult.timedOut || await isQrPhoneVerificationPage(page)) {
      return { success: false, error: QR_VERIFICATION_ERROR };
    }
  }

  await settleVerificationPage(page, logger, verificationStartUrl);
  if (await isQrPhoneVerificationPage(page)) {
    const qrResult = await waitForManualQrScan(page, logger, "phone-verify-qr-after-attempt-settle");
    if (qrResult.success) {
      return { success: true };
    }
    if (qrResult.timedOut || await isQrPhoneVerificationPage(page)) {
      return { success: false, error: QR_VERIFICATION_ERROR };
    }
  }

  // Step 1: Select "Verify your phone number" if on selection page
  const pageUrl = page.url();
  if ((pageUrl.includes("selection") || pageUrl.includes("uplevelingstep")) && !(await isPreviousPhoneVerificationPage(page))) {
    let selected = await selectPhoneVerificationOption(page, logger);
    if (!selected) {
      await settleVerificationPage(page, logger, verificationStartUrl);
      selected = await selectPhoneVerificationOption(page, logger);
      if (!selected) {
        return { success: false, error: "Could not find phone verification option" };
      }
    }
    // Wait for navigation to phone input page after clicking the option
    const selectionUrl = page.url();
    await Promise.race([
      page.waitForURL((url) => url.toString() !== selectionUrl, { timeout: 15000 }).catch(() => {}),
      page.locator(PHONE_INPUT_SELECTOR).first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {}),
      page.locator('#phoneNumberId').first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {}),
    ]);
    if (await isQrPhoneVerificationPage(page)) {
      const qrResult = await waitForManualQrScan(page, logger, "phone-verify-qr-after-option");
      if (qrResult.success) {
        return { success: true };
      }
      if (qrResult.timedOut || await isQrPhoneVerificationPage(page)) {
        return { success: false, error: QR_VERIFICATION_ERROR };
      }
    }
  }

  // Step 2: Enter phone number. Some repeat challenges skip this step and
  // ask to send a code to the previously used phone number.
  if (await hasVisibleTotpInput(page)) {
    await logger.log(
      "WARN",
      "[phone-verify] TOTP input is still visible; refusing to enter phone number into a code field"
    );
    return { success: false, error: "Still on TOTP challenge; phone input not ready" };
  }

  const hasPhoneInput = await hasVisiblePhoneInput(page);
  if (hasPhoneInput) {
    const fullNumber = phone.countryCode + phone.phoneNumber.replace(/^0+/, "");
    const phoneEntered = await enterPhoneNumber(page, fullNumber, logger);
    await captureStepScreenshot(page, logger, `phone-verify-after-enter-phone-${maskPhone(phone.phoneNumber)}`);
    if (!phoneEntered) {
      return { success: false, error: "Could not enter phone number" };
    }
  } else {
    await logger.log(
      "INFO",
      `[phone-verify] No phone input found; using previous-phone send flow for ${maskPhone(phone.phoneNumber)}`
    );
    await captureStepScreenshot(page, logger, `phone-verify-before-send-previous-phone-${maskPhone(phone.phoneNumber)}`);
  }

  // Step 3: Click send/next button
  const sent = await clickSendCode(page, logger);
  if (!sent) {
    return { success: false, error: "Could not click send code button" };
  }
  await page.waitForTimeout(5000);
  await captureStepScreenshot(page, logger, `phone-verify-after-send-code-${maskPhone(phone.phoneNumber)}`);
  if (await isQrPhoneVerificationPage(page)) {
    const qrResult = await waitForManualQrScan(page, logger, "phone-verify-qr-after-send");
    if (qrResult.success) {
      return { success: true };
    }
    if (qrResult.timedOut || await isQrPhoneVerificationPage(page)) {
      return { success: false, error: QR_VERIFICATION_ERROR };
    }
  }

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
    if (await isQrPhoneVerificationPage(page)) {
      const qrResult = await waitForManualQrScan(page, logger, "phone-verify-qr-during-sms-poll");
      if (qrResult.success) {
        return { success: true };
      }
      if (qrResult.timedOut || await isQrPhoneVerificationPage(page)) {
        return { success: false, error: QR_VERIFICATION_ERROR };
      }
    }
    return { success: false, error: "SMS code not received within timeout" };
  }

  await logger.log("INFO", `[phone-verify] Got verification code: ${code.substring(0, 2)}****`);

  // Step 5: Enter verification code
  const codeEntered = await enterVerificationCode(page, code, logger);
  await captureStepScreenshot(page, logger, `phone-verify-after-enter-code-${maskPhone(phone.phoneNumber)}`);
  if (!codeEntered) {
    return { success: false, error: "Could not enter verification code" };
  }

  // Step 6: Click verify/next
  await clickVerifyButton(page, logger);
  await page.waitForTimeout(5000);
  await captureStepScreenshot(page, logger, `phone-verify-after-submit-code-${maskPhone(phone.phoneNumber)}`);
  if (await isQrPhoneVerificationPage(page)) {
    const qrResult = await waitForManualQrScan(page, logger, "phone-verify-qr-after-submit");
    if (qrResult.success) {
      return { success: true };
    }
    if (qrResult.timedOut || await isQrPhoneVerificationPage(page)) {
      return { success: false, error: QR_VERIFICATION_ERROR };
    }
  }

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
  await captureStepScreenshot(page, logger, "phone-verify-did-not-succeed", "errorScreenshotPath");
  return { success: false, error: postError ?? "Verification did not succeed" };
}

async function isQrPhoneVerificationPage(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    if (/\/challenge\/iap\/qrcode/i.test(url) || /[?&]challengeType=qrcode/i.test(url)) {
      return true;
    }
    if (url.includes("/uplevelingstep/selection") || url.includes("/challenge/selection")) {
      return false;
    }
    const bodyText = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    return isQrText(bodyText);
  } catch {
    return false;
  }
}

function isQrVerificationError(value: unknown): boolean {
  return String(value || "").includes(QR_VERIFICATION_ERROR);
}

function isQrText(text: string): boolean {
  return QR_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}

function isPhoneOptionText(text: string): boolean {
  if (!text.trim() || isQrText(text)) return false;
  return PHONE_OPTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * On the selection page, click "Verify your phone number" option.
 */
async function selectPhoneVerificationOption(page: Page, logger: TaskLogger): Promise<boolean> {
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});

  // Prefer the explicit SMS challenge marker when Google exposes it. This is
  // safer than selecting phone-prompt/device/QR methods.
  const smsChallengeSelectors = [
    'div[data-challengetype="9"]',
    'li[data-challengetype="9"]',
    'button[data-challengetype="9"]',
    '[data-challengetype="9"]',
  ];

  for (const selector of smsChallengeSelectors) {
    try {
      const el = page.locator(selector).first();
      if ((await el.count()) > 0 && (await el.isVisible())) {
        await el.click();
        await logger.log("INFO", `[phone-verify] Selected SMS phone option via: ${selector}`);
        await page.waitForTimeout(1000);
        await logger.log("DEBUG", `[phone-verify] Post-click URL: ${page.url()}`);
        await captureStepScreenshot(page, logger, "phone-verify-after-select-sms-option");
        return true;
      }
    } catch {
      // continue
    }
  }

  // Prefer clickable option containers. A broad getByText("phone number") can
  // match QR explanatory copy and accidentally enter the scan-code challenge.
  const options = page.locator(
    [
      '[role="link"]',
      '[role="button"]',
      'li',
      'div[tabindex]',
      'div[data-challengetype]',
      'li[data-challengetype]',
    ].join(", ")
  );
  const count = await options.count();
  for (let i = 0; i < count; i++) {
    const option = options.nth(i);
    const text = await option.innerText().catch(() => "");
    if (!isPhoneOptionText(text)) continue;
    if (!(await option.isVisible().catch(() => false))) continue;

    await option.click();
    await logger.log("INFO", `[phone-verify] Selected phone option by text match: "${text.substring(0, 80)}"`);
    await page.waitForTimeout(1000);
    await logger.log("DEBUG", `[phone-verify] Post-click URL: ${page.url()}`);
    await captureStepScreenshot(page, logger, "phone-verify-after-select-phone-option");
    return true;
  }

  const bodyPreview = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  const challengePreview = await page.locator("[data-challengetype]").evaluateAll((els) =>
    els.slice(0, 8).map((el) => ({
      type: el.getAttribute("data-challengetype"),
      text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 100),
    }))
  ).catch(() => []);
  await logger.log(
    "WARN",
    `[phone-verify] Could not find phone verification option on page. url=${page.url()} challenges=${JSON.stringify(challengePreview)} body=${bodyPreview.substring(0, 500)}`
  );
  await captureStepScreenshot(page, logger, "phone-verify-no-phone-option", "errorScreenshotPath");
  return false;
}
const PHONE_INPUT_SELECTOR = [
  'input[name="phoneNumberId"]',
  'input#phoneNumberId',
  'input#deviceAddress',
  'input[name="deviceAddress"]',
  'input#knowledgePreregisteredPhone',
  'input[name="knowledgePreregisteredPhone"]',
  'input[autocomplete="tel"]',
  'input[id*="phone" i]',
  'input[aria-label*="phone" i]',
  'input[placeholder*="phone" i]',
  'input[aria-label*="电话" i]',
  'input[placeholder*="电话" i]',
  'input[aria-label*="手机" i]',
  'input[placeholder*="手机" i]',
  'input[type="tel"]:not([name*="totp" i]):not([id*="totp" i]):not([autocomplete="one-time-code"])',
].join(", ");

const TOTP_INPUT_SELECTOR = [
  'input[name="totpPin"]',
  'input[id="totpPin"]',
  'input[autocomplete="one-time-code"]',
  'input[type="tel"][name*="totp" i]',
  'input[type="tel"][id*="totp" i]',
].join(", ");

async function enterPhoneNumber(page: Page, number: string, logger: TaskLogger): Promise<boolean> {
  if (await hasVisibleTotpInput(page)) {
    await logger.log(
      "WARN",
      "[phone-verify] Refusing to enter phone number because a TOTP input is visible"
    );
    return false;
  }

  const phoneInput = page.locator(PHONE_INPUT_SELECTOR);

  // Wait for phone input to appear
  try {
    await phoneInput.first().waitFor({ state: "visible", timeout: 10000 });
  } catch {
    await logger.log("WARN", "[phone-verify] Phone input not found");
    return false;
  }

  const input = await firstSafePhoneInput(page);
  if (!input) {
    await logger.log("WARN", "[phone-verify] No safe phone input found");
    return false;
  }

  await input.fill(number);
  await logger.log("INFO", `[phone-verify] Entered phone number: ${maskPhone(number)}`);
  return true;
}

async function hasVisiblePhoneInput(page: Page): Promise<boolean> {
  return Boolean(await firstSafePhoneInput(page));
}

async function hasVisibleTotpInput(page: Page): Promise<boolean> {
  const totpInput = page.locator(TOTP_INPUT_SELECTOR);
  const count = await totpInput.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    if (await totpInput.nth(i).isVisible().catch(() => false)) return true;
  }
  return false;
}

async function firstSafePhoneInput(page: Page) {
  const phoneInput = page.locator(PHONE_INPUT_SELECTOR);
  const count = await phoneInput.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const input = phoneInput.nth(i);
    if (!(await input.isVisible().catch(() => false))) continue;

    const attrs = await input.evaluate((el: HTMLInputElement) => ({
      id: el.id || "",
      name: el.name || "",
      autocomplete: el.autocomplete || "",
      ariaLabel: el.getAttribute("aria-label") || "",
      placeholder: el.getAttribute("placeholder") || "",
    })).catch(() => null);
    if (!attrs) continue;

    const marker = `${attrs.id} ${attrs.name} ${attrs.autocomplete} ${attrs.ariaLabel} ${attrs.placeholder}`;
    if (/totp|one-time-code|authenticator|verification code|enter code/i.test(marker)) {
      continue;
    }
    return input;
  }
  return null;
}

async function clickSendCode(page: Page, logger: TaskLogger): Promise<boolean> {
  const sendBtn = page.locator(
    [
      'button:has-text("Send")',
      'button:has-text("Send code")',
      'button:has-text("Next")',
      'button:has-text("Continue")',
      'button:has-text("Get code")',
      'button:has-text("Text")',
      'button:has-text("Text me")',
      'button:has-text("发送")',
      'button:has-text("获取验证码")',
      'button:has-text("短信")',
      'button[type="submit"]',
      'button[jsname="LgbsSe"]',
      'div[role="button"][jsname="LgbsSe"]',
      'div[role="button"]:has-text("Send")',
      'div[role="button"]:has-text("Send code")',
      'div[role="button"]:has-text("Next")',
      'div[role="button"]:has-text("Continue")',
      'div[role="button"]:has-text("发送")',
      'div[role="button"]:has-text("获取验证码")',
    ].join(", ")
  );

  const count = await sendBtn.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const btn = sendBtn.nth(i);
    if (!(await btn.isVisible().catch(() => false))) continue;
    await btn.evaluate((el: HTMLElement) => el.click());
    await logger.log("INFO", "[phone-verify] Clicked send/next button");
    return true;
  }

  await page.keyboard.press("Enter");
  await logger.log("INFO", "[phone-verify] Pressed Enter to submit phone");
  return true;
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

  const firstInput = codeInput.first();
  await firstInput.focus();
  await firstInput.fill(""); // 清空已有文本
  await firstInput.pressSequentially(code, { delay: 100 }); // 模拟真实按键，触发 Google 的前端状态监听器
  await logger.log("INFO", "[phone-verify] Entered verification code sequentially");
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

  const firstBtn = verifyBtn.first();
  if ((await firstBtn.count()) > 0 && await firstBtn.isVisible()) {
    try {
      // 1. 优先尝试 Playwright 原生物理点击（模拟真实鼠标动作，更加可靠）
      await firstBtn.click({ timeout: 5000 });
      await logger.log("INFO", "[phone-verify] Clicked verify/submit button via Playwright click");
    } catch (err) {
      await logger.log("WARN", `[phone-verify] Playwright click failed (${err}), trying JS evaluate click fallback...`);
      // 2. 备用方案：如因元素覆盖或点击拦截，回退到 JS click 触发
      await firstBtn.evaluate((el: HTMLElement) => el.click());
      await logger.log("INFO", "[phone-verify] Clicked verify/submit button via JS click fallback");
    }
  } else {
    await page.keyboard.press("Enter");
    await logger.log("INFO", "[phone-verify] No visible button, pressed Enter to submit code");
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
  //
  // IMPORTANT: After detecting the success signal, we must wait for the
  // FINAL page redirect to complete. Google's verification flow has a
  // multi-step redirect chain:
  //   uplevelingstep → auth_success_gemini → final landing page
  // If the browser closes before the final redirect finishes, the
  // verification state may NOT persist on Google's side.

  const startUrl = page.url();

  if (isQrCompletionUrl(startUrl)) {
    await logger.log("INFO", `[phone-verify] Verification already completed at: ${startUrl}`);
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    // Match the 5s stabilization wait used in the main success path (line ~916)
    // to ensure Google's server-side state is fully persisted before browser closes
    await page.waitForTimeout(5000);
    return true;
  }

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

    // ── Wait for the FINAL redirect chain to complete ──
    // Google's verification has a multi-step redirect:
    //   1. accounts.google.com/uplevelingstep → submit code
    //   2. Redirect to auth_success_gemini URL
    //   3. Final redirect to landing page (developers.google.com or other)
    // We need to wait for step 3 to finish for verification to persist.
    const urlAfterSignal = page.url();
    await logger.log("DEBUG", `[phone-verify] URL after success signal: ${urlAfterSignal}`);

    // Wait for the page to finish loading (networkidle = no network activity for 500ms)
    await logger.log("DEBUG", "[phone-verify] Waiting for final redirect chain to complete...");
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    // If the URL is still an auth_success or accounts.google.com URL,
    // there may be further redirects. Wait for the page to leave Google auth.
    const urlAfterIdle = page.url();
    await logger.log("DEBUG", `[phone-verify] URL after networkidle: ${urlAfterIdle}`);

    if (
      urlAfterIdle.includes("auth_success") ||
      urlAfterIdle.includes("accounts.google.com/signin")
    ) {
      // Still on an intermediate page — wait for the final navigation
      await logger.log("DEBUG", "[phone-verify] Still on intermediate page, waiting for final redirect...");
      await page.waitForURL(
        (url) => {
          const u = url.toString();
          return !u.includes("accounts.google.com/signin") && !u.includes("uplevelingstep");
        },
        { timeout: 15000 }
      ).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    }

    // Final stabilization wait — ensure cookies and server-side state are fully persisted
    const finalUrl = page.url();
    await logger.log("INFO", `[phone-verify] Final landing page: ${finalUrl}`);
    await logger.log("DEBUG", "[phone-verify] Waiting 5s for Google to finalize verification state...");
    await page.waitForTimeout(5000);

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
      /verify your info to continue/i,
      /google needs to verify some info about your device or phone number/i,
      /image of qr code to scan/i,
      /scan the qr code with your phone/i,
      /open your camera app/i,
      /you.ll need to switch back to your computer/i,
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
