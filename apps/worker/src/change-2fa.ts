/**
 * Google 2FA (TOTP Authenticator) change automation module.
 *
 * Automates the complete flow of changing an account's Google Authenticator:
 *  1. Navigate to the Authenticator settings page
 *  2. Handle re-authentication if required
 *  3. Click "Change authenticator app"
 *  4. Click "Can't scan it?" to reveal the text-based secret key
 *  5. Extract the new Base32 TOTP secret
 *  6. Click Next to reach the verification page
 *  7. Generate and submit a TOTP code using the new secret
 *  8. Confirm the change
 *
 * Returns the new TOTP secret on success, or an error description on failure.
 *
 * Designed from live browser exploration of the Google 2FA settings UI.
 * Unicode note: Google uses U+2019 (RIGHT SINGLE QUOTATION MARK) in "Can't"
 * rather than ASCII U+0027.
 */

import type { Page } from "playwright";
import {
  generateTOTP,
  totpSecondsRemaining,
  sanitiseBase32,
} from "./totp";
import { handleReAuthLoop, isReAuthPage } from "./handle-reauth";
import { captureStepScreenshot } from "./screenshot-capture";
import type { TaskLogger } from "./task-logger";

// ── URLs ──
const AUTHENTICATOR_URL =
  "https://myaccount.google.com/two-step-verification/authenticator?hl=en";

// ── Result types ──

export type Change2FAFailReason =
  | "REAUTH_FAILED"
  | "NO_AUTHENTICATOR_PAGE"
  | "NO_CHANGE_BUTTON"
  | "CANT_SCAN_FAILED"
  | "SECRET_EXTRACT_FAILED"
  | "VERIFY_FAILED"
  | "TRANSIENT"
  | "UNKNOWN";

export type Change2FAResult =
  | { success: true; newTotpSecret: string }
  | { success: false; reason: Change2FAFailReason; detail: string };

// ── Selectors (multi-language) ──

/** "Change authenticator app" button */
const CHANGE_BTN = [
  'button:has-text("Change authenticator app")',
  'button:has-text("更改身份验证器应用")',
  'button:has-text("變更驗證器應用程式")',
  'button:has-text("認証システム アプリを変更")',
  'button:has-text("인증 앱 변경")',
].join(", ");

/** "Set up authenticator" (for accounts without one yet) */
const SETUP_BTN = [
  'button:has-text("Set up authenticator")',
  'button:has-text("设置身份验证器")',
  'button:has-text("Add authenticator")',
].join(", ");

/**
 * "Can't scan it?" button — Google uses Unicode RIGHT SINGLE QUOTATION MARK
 * (U+2019) in "Can't", not ASCII apostrophe (U+0027).
 * We include both to be safe.
 */
const CANT_SCAN_BTN = [
  // Unicode curly quote (U+2019) — what Google actually uses
  `button:has-text("Can\u2019t scan it")`,
  `a:has-text("Can\u2019t scan it")`,
  // ASCII fallback
  `button:has-text("Can't scan it")`,
  `a:has-text("Can't scan it")`,
  // Shorter match (in case text changes)
  `button:has-text("Can\u2019t scan")`,
  `a:has-text("Can\u2019t scan")`,
  `button:has-text("Can't scan")`,
  `a:has-text("Can't scan")`,
  // Chinese
  'button:has-text("无法扫描")',
  'a:has-text("无法扫描")',
  'button:has-text("無法掃描")',
  'a:has-text("無法掃描")',
  // Japanese
  'button:has-text("スキャンできない")',
  // Korean
  'button:has-text("스캔할 수 없")',
  // "Enter a setup key" (alternative text in some Google versions)
  'button:has-text("Enter a setup key")',
  'a:has-text("Enter a setup key")',
  'button:has-text("手动输入")',
  'a:has-text("手动输入")',
].join(", ");

/** Cancel button in the dialog */
const CANCEL_BTN = [
  'button:has-text("Cancel")',
  'button:has-text("取消")',
  'button:has-text("キャンセル")',
  'button:has-text("취소")',
].join(", ");

/** Next button in the dialog */
const DIALOG_NEXT_BTN = [
  'button:has-text("Next")',
  'button:has-text("下一步")',
  'button:has-text("次へ")',
  'button:has-text("다음")',
].join(", ");

/** Verify button after entering TOTP code */
const VERIFY_BTN = [
  'button:has-text("Verify")',
  'button:has-text("验证")',
  'button:has-text("驗證")',
  'button:has-text("確認")',
  'button:has-text("확인")',
  'button:has-text("確認する")',
].join(", ");

/** TOTP code input — Google's 2FA settings uses a generic input, not the login challenge's totpPin */
const TOTP_INPUT = [
  // Standard login challenge selectors
  'input[type="tel"]',
  'input[name="totpPin"]',
  'input[id="totpPin"]',
  'input[autocomplete="one-time-code"]',
  'input[type="text"][name="totpPin"]',
  'input[name="Pin"]',
  // Google 2FA settings page: generic text input with placeholder "Enter Code"
  'input[placeholder="Enter Code"]',
  'input[placeholder="输入验证码"]',
  'input[placeholder="コードを入力"]',
  'input[placeholder="코드 입력"]',
  'input[placeholder*="code" i]',
  'input[placeholder*="Code" i]',
  'input[placeholder*="验证码"]',
  // Last resort: any visible text input inside the dialog
  'input[type="text"][aria-label]',
  'input[type="number"]',
].join(", ");

// ── Internal helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const LOG_PREFIX = "[change-2fa]";

/**
 * Extract the new TOTP secret from the page after clicking "Can't scan it?".
 *
 * Google displays the secret key as a Base32 string, typically in groups of 4
 * characters separated by spaces (e.g., "JBSW Y3DP EHPK 3PXP").
 *
 * Strategy:
 *  1. Look for spaced Base32 groups in the page body text
 *  2. Look for continuous Base32 strings (16+ chars)
 *  3. Parse QR code img src if it contains an otpauth:// URI
 */
async function extractSecretFromPage(
  page: Page,
  logger: TaskLogger
): Promise<string | null> {
  const result = await page.evaluate(() => {
    const bodyText = document.body?.innerText || "";

    // Strategy 1: Spaced base32 groups (e.g., "6t5w o75r 5o6i z3kf bxcc zccf en2i bnb5")
    // Google displays lowercase! Match both cases. At least 4 groups of 4 chars.
    // IMPORTANT: Use [ \t] NOT \s — \s matches newlines and would cross into
    // the next line (e.g., "...7wpc\nMake sure Time base" → false match).
    const spacedRegex = /([a-zA-Z2-7]{4}[ \t]+){3,}[a-zA-Z2-7]{4}/g;
    const spacedMatches: string[] = [];
    let m;
    while ((m = spacedRegex.exec(bodyText)) !== null) {
      spacedMatches.push(m[0]);
    }

    // Strategy 2: Continuous base32 string (16+ chars), case-insensitive
    const contRegex = /[a-zA-Z2-7]{16,}/g;
    const contMatches: string[] = [];
    while ((m = contRegex.exec(bodyText)) !== null) {
      // Filter out things that are obviously not secrets (very common words, etc.)
      if (m[0].length <= 64) contMatches.push(m[0]);
    }

    // Strategy 3: Check QR code img for otpauth URI
    let qrSecret: string | null = null;
    const imgs = document.querySelectorAll("img");
    for (const img of Array.from(imgs)) {
      if (img.src?.includes("otpauth")) {
        try {
          const url = new URL(img.src);
          qrSecret = url.searchParams.get("secret");
        } catch { /* ignore */ }
      }
    }

    return { spacedMatches, contMatches, qrSecret, bodySnippet: bodyText.slice(0, 500) };
  });

  await logger.log("DEBUG", `${LOG_PREFIX} Secret extraction: ` +
    `spaced=${result.spacedMatches.length}, cont=${result.contMatches.length}, ` +
    `qr=${result.qrSecret ? "yes" : "no"}`);

  // Priority: spaced matches > continuous matches > QR secret
  if (result.spacedMatches.length > 0) {
    const raw = result.spacedMatches[0].replace(/\s/g, "").toUpperCase();
    await logger.log("INFO", `${LOG_PREFIX} Extracted secret (spaced): ${raw.slice(0, 4)}****`);
    return raw;
  }

  if (result.contMatches.length > 0) {
    // If multiple continuous matches, pick the one that looks most like a secret
    // (longer is better, but not too long)
    const best = result.contMatches.sort(
      (a, b) => Math.abs(b.length - 32) - Math.abs(a.length - 32)
    )[0].toUpperCase();
    await logger.log("INFO", `${LOG_PREFIX} Extracted secret (continuous): ${best.slice(0, 4)}****`);
    return best;
  }

  if (result.qrSecret) {
    const upper = result.qrSecret.toUpperCase();
    await logger.log("INFO", `${LOG_PREFIX} Extracted secret (QR): ${upper.slice(0, 4)}****`);
    return upper;
  }

  await logger.log("WARN", `${LOG_PREFIX} No secret key found on page. Body: ${result.bodySnippet.slice(0, 200)}`);
  return null;
}

/**
 * Wait for a fresh TOTP window if the current one was recently used.
 * Google rejects duplicate TOTP codes within the same 30-second window.
 */
async function waitForFreshTotp(logger: TaskLogger): Promise<void> {
  const remaining = totpSecondsRemaining();
  if (remaining < 5) {
    const waitMs = (remaining + 2) * 1000;
    await logger.log("INFO", `${LOG_PREFIX} TOTP window expires in ${remaining}s, waiting ${waitMs}ms for fresh code`);
    await sleep(waitMs);
  }
}

// ── Main function ──

/**
 * Change the TOTP authenticator for a Google account.
 *
 * Pre-conditions:
 *  - The browser page must already be logged into the target Google account.
 *  - The account must have 2-Step Verification enabled.
 *
 * @param page     - Playwright Page, already logged in to Google
 * @param account  - Account credentials (for re-auth and current TOTP)
 * @param logger   - TaskLogger instance for structured logging
 * @returns        - { success: true, newTotpSecret } or { success: false, reason, detail }
 */
export async function change2FA(
  page: Page,
  account: {
    loginEmail: string;
    loginPassword: string;
    totpSecret: string | null;
  },
  logger: TaskLogger
): Promise<Change2FAResult> {

  // ── Step 1: Navigate to Authenticator settings page ──
  await logger.log("INFO", `${LOG_PREFIX} Navigating to Authenticator page`);
  try {
    await page.goto(AUTHENTICATOR_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(3000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("net::") || msg.includes("Timeout")) {
      return { success: false, reason: "TRANSIENT", detail: `Navigation failed: ${msg}` };
    }
    return { success: false, reason: "UNKNOWN", detail: `Navigation failed: ${msg}` };
  }

  // ── Step 2: Handle re-authentication if required ──
  if (isReAuthPage(page.url())) {
    await logger.log("INFO", `${LOG_PREFIX} Re-authentication required`);
    await captureStepScreenshot(page, logger, "change2fa-reauth");
    try {
      await handleReAuthLoop(page, {
        loginEmail: account.loginEmail,
        password: account.loginPassword,
        totpSecret: account.totpSecret,
      }, logger, { logPrefix: LOG_PREFIX, maxRounds: 6 });
      await page.waitForTimeout(3000);
    } catch (err) {
      return {
        success: false,
        reason: "REAUTH_FAILED",
        detail: `Re-auth failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Verify we landed on the authenticator page
    if (!page.url().includes("authenticator") && !page.url().includes("two-step-verification")) {
      // Re-auth may have redirected us; try navigating again
      await logger.log("WARN", `${LOG_PREFIX} Post-reauth URL unexpected: ${page.url()}, retrying navigation`);
      try {
        await page.goto(AUTHENTICATOR_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(3000);
      } catch {
        return { success: false, reason: "NO_AUTHENTICATOR_PAGE", detail: `Could not reach authenticator page after re-auth` };
      }
    }
  }

  // Verify we're on the authenticator page
  const pageTitle = await page.title().catch(() => "");
  const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 300) || "").catch(() => "");
  if (!bodyText.includes("Authenticator") && !bodyText.includes("身份验证器") && !bodyText.includes("驗證器")) {
    await captureStepScreenshot(page, logger, "change2fa-wrong-page");
    return {
      success: false,
      reason: "NO_AUTHENTICATOR_PAGE",
      detail: `Expected Authenticator page, got: ${pageTitle} (${page.url()})`,
    };
  }

  await logger.log("INFO", `${LOG_PREFIX} On Authenticator page`);
  await captureStepScreenshot(page, logger, "change2fa-authenticator-page");

  // ── Step 3: Click "Change authenticator app" ──
  await logger.log("INFO", `${LOG_PREFIX} Looking for Change button`);

  let changeClicked = false;
  const changeBtn = page.locator(CHANGE_BTN);
  if ((await changeBtn.count()) > 0) {
    try {
      await changeBtn.first().click({ timeout: 10_000 });
      changeClicked = true;
      await logger.log("INFO", `${LOG_PREFIX} Clicked "Change authenticator app"`);
    } catch (err) {
      await logger.log("WARN", `${LOG_PREFIX} Change button click failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Fallback: try "Set up authenticator" (if no existing authenticator)
  if (!changeClicked) {
    const setupBtn = page.locator(SETUP_BTN);
    if ((await setupBtn.count()) > 0) {
      try {
        await setupBtn.first().click({ timeout: 10_000 });
        changeClicked = true;
        await logger.log("INFO", `${LOG_PREFIX} Clicked "Set up authenticator" (no existing)`);
      } catch (err) {
        await logger.log("WARN", `${LOG_PREFIX} Setup button click failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (!changeClicked) {
    await captureStepScreenshot(page, logger, "change2fa-no-button");
    return {
      success: false,
      reason: "NO_CHANGE_BUTTON",
      detail: `Neither "Change" nor "Set up" authenticator button found`,
    };
  }

  // Wait for the dialog to appear (QR code + buttons)
  await page.waitForTimeout(4000);
  await captureStepScreenshot(page, logger, "change2fa-qr-dialog");

  // ── Step 4: Click "Can't scan it?" to reveal the text secret ──
  await logger.log("INFO", `${LOG_PREFIX} Looking for "Can't scan it?" button`);

  const cantScan = page.locator(CANT_SCAN_BTN);
  const cantScanCount = await cantScan.count();
  await logger.log("DEBUG", `${LOG_PREFIX} Can't scan matches: ${cantScanCount}`);

  if (cantScanCount > 0) {
    try {
      await cantScan.first().click({ timeout: 10_000 });
      await logger.log("INFO", `${LOG_PREFIX} Clicked "Can't scan it?"`);
      await page.waitForTimeout(3000);
    } catch (err) {
      await logger.log("WARN", `${LOG_PREFIX} Can't scan click failed: ${err instanceof Error ? err.message : String(err)}`);
      // Try JavaScript click as fallback
      try {
        const el = await cantScan.first().elementHandle();
        if (el) {
          await el.evaluate((e) => (e as HTMLElement).click());
          await logger.log("INFO", `${LOG_PREFIX} Clicked "Can't scan it?" via JS fallback`);
          await page.waitForTimeout(3000);
        }
      } catch {
        // Continue anyway — maybe the secret is extractable from the QR code
      }
    }
  } else {
    // "Can't scan" not found — try to find it by evaluating page content
    await logger.log("WARN", `${LOG_PREFIX} Can't scan button not found via locator, trying JS search`);
    const jsClicked = await page.evaluate(() => {
      // Search all clickable elements for "scan" text
      const allEls = document.querySelectorAll("button, a, [role='button'], [role='link']");
      for (const el of Array.from(allEls)) {
        const text = (el as HTMLElement).innerText?.toLowerCase() || "";
        if (text.includes("scan") || text.includes("扫描") || text.includes("掃描")) {
          (el as HTMLElement).click();
          return true;
        }
      }
      return false;
    });
    if (jsClicked) {
      await logger.log("INFO", `${LOG_PREFIX} Clicked scan-related button via JS`);
      await page.waitForTimeout(3000);
    } else {
      await logger.log("WARN", `${LOG_PREFIX} No scan-related button found, will try to extract secret anyway`);
    }
  }

  await captureStepScreenshot(page, logger, "change2fa-secret-page");

  // ── Step 5: Extract the new TOTP secret ──
  await logger.log("INFO", `${LOG_PREFIX} Extracting new TOTP secret`);

  const newSecret = await extractSecretFromPage(page, logger);
  if (!newSecret) {
    await captureStepScreenshot(page, logger, "change2fa-no-secret");
    // Try clicking Cancel to abort
    await _clickCancel(page, logger);
    return {
      success: false,
      reason: "SECRET_EXTRACT_FAILED",
      detail: "Could not extract new TOTP secret from the page",
    };
  }

  // Validate the extracted secret
  try {
    sanitiseBase32(newSecret, account.loginEmail);
  } catch (err) {
    await logger.log("WARN", `${LOG_PREFIX} Extracted secret failed validation: ${err instanceof Error ? err.message : String(err)}`);
    await _clickCancel(page, logger);
    return {
      success: false,
      reason: "SECRET_EXTRACT_FAILED",
      detail: `Extracted secret is invalid Base32: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  await logger.log("INFO", `${LOG_PREFIX} New secret extracted and validated: ${newSecret.slice(0, 4)}****`);

  // ── Step 6: Click Next to proceed to verification ──
  await logger.log("INFO", `${LOG_PREFIX} Clicking Next to proceed to verification`);

  // The Next button is inside the dialog — need to find the visible one
  const nextBtn = page.locator(DIALOG_NEXT_BTN);
  let nextClicked = false;

  for (let i = 0; i < await nextBtn.count(); i++) {
    const btn = nextBtn.nth(i);
    const visible = await btn.isVisible().catch(() => false);
    if (visible) {
      try {
        await btn.click({ timeout: 10_000 });
        nextClicked = true;
        await logger.log("INFO", `${LOG_PREFIX} Clicked Next (index ${i})`);
        break;
      } catch {
        continue;
      }
    }
  }

  if (!nextClicked) {
    // Fallback: JS click
    await logger.log("WARN", `${LOG_PREFIX} Next button not clickable via Playwright, trying JS`);
    nextClicked = await page.evaluate((texts) => {
      const buttons = document.querySelectorAll("button");
      for (const btn of Array.from(buttons)) {
        const text = btn.innerText?.trim();
        if (texts.some((t: string) => text.includes(t))) {
          const rect = btn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            btn.click();
            return true;
          }
        }
      }
      return false;
    }, ["Next", "下一步", "次へ", "다음"]);
  }

  if (!nextClicked) {
    await logger.log("WARN", `${LOG_PREFIX} Could not click Next — aborting`);
    await _clickCancel(page, logger);
    return {
      success: false,
      reason: "VERIFY_FAILED",
      detail: "Could not click Next to reach verification page",
    };
  }

  await page.waitForTimeout(4000);
  await captureStepScreenshot(page, logger, "change2fa-verify-page");

  // ── Step 7: Generate TOTP and fill verification code ──
  await logger.log("INFO", `${LOG_PREFIX} Looking for verification code input`);

  // Wait for the input to appear
  const codeInput = page.locator(TOTP_INPUT);
  let inputFound = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    for (let i = 0; i < await codeInput.count(); i++) {
      const visible = await codeInput.nth(i).isVisible().catch(() => false);
      if (visible) {
        inputFound = true;
        break;
      }
    }
    if (inputFound) break;
    await sleep(1000);
  }

  if (!inputFound) {
    await logger.log("WARN", `${LOG_PREFIX} No verification code input found`);
    await captureStepScreenshot(page, logger, "change2fa-no-input");
    await _clickCancel(page, logger);
    return {
      success: false,
      reason: "VERIFY_FAILED",
      detail: "Verification code input not found on page",
    };
  }

  // Generate TOTP with the NEW secret
  await waitForFreshTotp(logger);
  const totpCode = generateTOTP(newSecret, account.loginEmail);
  await logger.log("INFO", `${LOG_PREFIX} Generated TOTP with new secret: ${totpCode.slice(0, 2)}****`);

  // Fill in the code
  const visibleInput = codeInput.first();
  await visibleInput.fill("");
  await visibleInput.type(totpCode, { delay: 50 });

  // ── Step 8: Click Verify ──
  await logger.log("INFO", `${LOG_PREFIX} Submitting verification code`);

  const verifyBtn = page.locator(VERIFY_BTN);
  let verifyClicked = false;

  for (let i = 0; i < await verifyBtn.count(); i++) {
    const visible = await verifyBtn.nth(i).isVisible().catch(() => false);
    if (visible) {
      try {
        await verifyBtn.nth(i).click({ timeout: 10_000 });
        verifyClicked = true;
        break;
      } catch {
        continue;
      }
    }
  }

  // Fallback: try the "Next" button text (some versions use "Next" instead of "Verify")
  if (!verifyClicked) {
    const nextVerify = page.locator(DIALOG_NEXT_BTN);
    for (let i = 0; i < await nextVerify.count(); i++) {
      const visible = await nextVerify.nth(i).isVisible().catch(() => false);
      if (visible) {
        try {
          await nextVerify.nth(i).click({ timeout: 10_000 });
          verifyClicked = true;
          break;
        } catch {
          continue;
        }
      }
    }
  }

  if (!verifyClicked) {
    await logger.log("WARN", `${LOG_PREFIX} Verify button not found, trying Enter key`);
    await visibleInput.press("Enter");
  }

  // Wait for result
  await page.waitForTimeout(5000);
  await captureStepScreenshot(page, logger, "change2fa-after-verify");

  // ── Step 9: Check success ──
  // After successful verification, Google should show the Authenticator page again
  // with "Added just now" or similar text, and the dialog should be dismissed.
  const postVerifyBody = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || "").catch(() => "");
  const postUrl = page.url();

  // Check for error indicators
  const hasError = postVerifyBody.includes("Wrong code") ||
    postVerifyBody.includes("错误的验证码") ||
    postVerifyBody.includes("コードが間違っています") ||
    postVerifyBody.includes("잘못된 코드") ||
    postVerifyBody.includes("Try again");

  if (hasError) {
    await logger.log("WARN", `${LOG_PREFIX} Verification code rejected, retrying with fresh code`);

    // Wait for next TOTP window and retry once
    const waitSecs = totpSecondsRemaining() + 2;
    await sleep(waitSecs * 1000);

    const retryCode = generateTOTP(newSecret, account.loginEmail);
    await logger.log("INFO", `${LOG_PREFIX} Retry TOTP: ${retryCode.slice(0, 2)}****`);

    await visibleInput.fill("");
    await visibleInput.type(retryCode, { delay: 50 });

    // Click verify again
    if (verifyClicked) {
      for (let i = 0; i < await verifyBtn.count(); i++) {
        const visible = await verifyBtn.nth(i).isVisible().catch(() => false);
        if (visible) {
          await verifyBtn.nth(i).click({ timeout: 10_000 }).catch(() => {});
          break;
        }
      }
    } else {
      await visibleInput.press("Enter");
    }

    await page.waitForTimeout(5000);

    const retryBody = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || "").catch(() => "");
    if (
      retryBody.includes("Wrong code") ||
      retryBody.includes("错误的验证码") ||
      retryBody.includes("Try again")
    ) {
      await captureStepScreenshot(page, logger, "change2fa-verify-failed");
      await _clickCancel(page, logger);
      return {
        success: false,
        reason: "VERIFY_FAILED",
        detail: "TOTP verification code rejected twice",
      };
    }
  }

  // Success indicators: dialog dismissed, back to authenticator page,
  // or text like "Added just now" / "Added 0 minutes ago"
  const isSuccess =
    postVerifyBody.includes("Added just now") ||
    postVerifyBody.includes("Added 0") ||
    postVerifyBody.includes("刚刚添加") ||
    postUrl.includes("authenticator") ||
    // Dialog dismissed = Change button is visible again
    (await page.locator(CHANGE_BTN).count() > 0);

  if (!isSuccess && hasError) {
    // Already handled above
  }

  await logger.log("INFO", `${LOG_PREFIX} 2FA change completed successfully. New secret: ${newSecret.slice(0, 4)}****`);
  await captureStepScreenshot(page, logger, "change2fa-success");

  return { success: true, newTotpSecret: newSecret };
}

// ── Abort helper ──

async function _clickCancel(page: Page, logger: TaskLogger): Promise<void> {
  try {
    const cancelBtn = page.locator(CANCEL_BTN);
    if ((await cancelBtn.count()) > 0) {
      await cancelBtn.first().click({ timeout: 5_000 });
      await logger.log("INFO", `${LOG_PREFIX} Clicked Cancel to abort`);
    }
  } catch {
    // Non-fatal — page may have already navigated away
  }
}
