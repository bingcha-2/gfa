/**
 * Shared Google re-authentication handler.
 *
 * Extracts duplicated re-auth logic from remove, replace, and automation
 * processors into a single reusable module. All post-login re-authentication
 * challenges (password, TOTP, challenge selection) go through here.
 *
 * Handles:
 *  1. Challenge selection page → auto-select TOTP (Google Authenticator)
 *  2. TOTP 2FA challenge → generate & submit code (with retry on rejection)
 *  3. Password re-auth → fill & submit
 *  4. Identifier/email page → click Next
 *  5. Inline password/TOTP overlays on same page
 */

import type { Page } from "playwright";
import { generateTOTP, totpSecondsRemaining, isTotpWindowUsed, markTotpUsed } from "./totp";
import type { TaskLogger } from "./task-logger";

export interface ReAuthCredentials {
  loginEmail?: string;
  password?: string | null;
  totpSecret?: string | null;
}

// ── Consolidated selectors ──
// All text selectors cover: English, 简体中文, 繁體中文, 日本語, 한국어, Tiếng Việt

const TOTP_INPUT = [
  'input[type="tel"]',
  'input[name="totpPin"]',
  'input[id="totpPin"]',
  'input[autocomplete="one-time-code"]',
  'input[type="text"][name="totpPin"]',
  'input[name="Pin"]',
].join(", ");

const TOTP_SUBMIT = [
  // EN
  'button:has-text("Next")', 'button:has-text("Verify")',
  // 简中
  'button:has-text("下一步")', 'button:has-text("验证")',
  // 繁中
  'button:has-text("驗證")', 'button:has-text("繼續")',
  // 日本語
  'button:has-text("次へ")', 'button:has-text("確認")',
  // 한국어
  'button:has-text("다음")', 'button:has-text("확인")',
  // Tiếng Việt
  'button:has-text("Tiếp theo")', 'button:has-text("Xác minh")',
  // Structural (language-independent)
  'button[type="submit"]',
  '#totpNext', 'div[id="totpNext"] button',
  'button[jsname="LgbsSe"]', 'div[role="button"][jsname="LgbsSe"]',
].join(", ");

const PASSWORD_INPUT =
  'input[type="password"]:not([aria-hidden="true"]):not([name="hiddenPassword"])';

const PASSWORD_SUBMIT = [
  // EN
  'button:has-text("Next")', 'button:has-text("Sign in")',
  // 简中
  'button:has-text("下一步")', 'button:has-text("登录")',
  // 繁中
  'button:has-text("繼續")', 'button:has-text("登入")',
  // 日本語
  'button:has-text("次へ")', 'button:has-text("ログイン")',
  // 한국어
  'button:has-text("다음")', 'button:has-text("로그인")',
  // Tiếng Việt
  'button:has-text("Tiếp theo")', 'button:has-text("Đăng nhập")',
  // Structural (language-independent)
  'button[type="submit"]',
  'button[jsname="LgbsSe"]', 'div[role="button"][jsname="LgbsSe"]',
  '#passwordNext button',
].join(", ");

const CHALLENGE_TOTP_DATA = [
  'div[data-challengetype="6"]',
  'li[data-challengetype="6"]',
  'button[data-challengetype="6"]',
  '[data-challengeindex][data-challengetype="6"]',
].join(", ");

const CHALLENGE_TOTP_TEXT = [
  // EN
  'li:has-text("Google Authenticator")',
  'li:has-text("Authenticator")',
  'li:has-text("verification code")',
  // 简中
  'li:has-text("身份验证器")',
  'li:has-text("验证器")',
  'li:has-text("验证码")',
  // 繁中
  'li:has-text("驗證器")',
  'li:has-text("驗證碼")',
  // 日本語
  'li:has-text("認証システム")',
  'li:has-text("確認コード")',
  // 한국어
  'li:has-text("Google OTP")',
  'li:has-text("인증 앱")',
  'li:has-text("인증기")',
  'li:has-text("인증 코드")',
  // Tiếng Việt
  'li:has-text("Trình xác thực")',
  'li:has-text("Mã xác minh")',
  // div[role="link"] variants (same keywords)
  'div[role="link"]:has-text("Google Authenticator")',
  'div[role="link"]:has-text("Authenticator")',
  'div[role="link"]:has-text("身份验证器")',
  'div[role="link"]:has-text("驗證器")',
  'div[role="link"]:has-text("認証システム")',
  'div[role="link"]:has-text("Google OTP")',
  'div[role="link"]:has-text("Trình xác thực")',
  // <a> variants
  'a:has-text("Google Authenticator")',
  'a:has-text("Authenticator")',
  'a:has-text("認証システム")',
  'a:has-text("Google OTP")',
  // Plain div variants (Google sometimes renders options as plain divs with jscontroller)
  'div[jscontroller]:has-text("Google Authenticator")',
  'div[jscontroller]:has-text("Authenticator")',
  'div[jscontroller]:has-text("身份验证器")',
  'div[jscontroller]:has-text("验证器")',
  'div[jscontroller]:has-text("驗證器")',
  'div[jscontroller]:has-text("認証システム")',
  'div[jscontroller]:has-text("Google OTP")',
  'div[jscontroller]:has-text("인증 앱")',
  'div[jscontroller]:has-text("Trình xác thực")',
].join(", ");

const NEXT_BUTTON = [
  // EN
  'button:has-text("Next")',
  // 简中
  'button:has-text("下一步")', 'button:has-text("继续")',
  // 繁中
  'button:has-text("繼續")',
  // 日本語
  'button:has-text("次へ")',
  // 한국어
  'button:has-text("다음")',
  // Tiếng Việt
  'button:has-text("Tiếp theo")', 'button:has-text("Tiếp tục")',
].join(", ");

/**
 * Check if the current URL indicates a Google re-authentication challenge page.
 *
 * Matches known challenge sub-types explicitly, plus a guarded catch-all for
 * any accounts.google.com/…/challenge/… path we haven't enumerated yet.
 *
 * IMPORTANT: Do NOT match the generic accounts.google.com domain without a
 * challenge/signin path. Google uses many transitional pages on that domain
 * (CheckCookie, ServiceLogin redirect, etc.) that are NOT challenges.
 * Matching the whole domain causes false positives → spurious throws.
 */
export function isReAuthPage(url: string): boolean {
  return (
    url.includes("challenge/pwd") ||
    url.includes("challenge/totp") ||
    url.includes("challenge/az") ||
    url.includes("challenge/sk") ||
    url.includes("challenge/dp") ||
    url.includes("challenge/ipp") ||
    url.includes("challenge/selection") ||
    url.includes("signin/challenge") ||
    url.includes("signin/v2/challenge") ||
    url.includes("signin/identifier") ||
    url.includes("signin/v2/identifier") ||
    // Re-auth entry points — Google may redirect here before the actual challenge
    url.includes("accounts.google.com/ServiceLogin") ||
    url.includes("accounts.google.com/webreauth") ||
    // Catch-all: any /challenge/<type> on accounts.google.com we haven't
    // enumerated (e.g. challenge/recaptcha, challenge/ootp).
    (url.includes("accounts.google.com/") && /\/challenge\/[a-z]/.test(url))
  );
}

/**
 * Handle a single re-auth challenge on the current page.
 *
 * Detection priority (to avoid false matches):
 *  1. Challenge selection page (pick TOTP if available)
 *  2. TOTP challenge (by URL)
 *  3. Non-automatable challenge (sk/dp/ipp → click "Try another way")
 *  4. Password challenge (by URL or visible input)
 *  5. Identifier/email page (click Next)
 *  6. Inline TOTP input (overlay on non-challenge URL)
 *  7. Inline password input (overlay on non-challenge URL)
 *  8. Unknown challenge/ URL (probe for delayed inputs)
 *
 * @returns true if a challenge was handled (caller should re-check page state)
 * @returns false if no re-auth detected or challenge is not automatable
 */
export async function handleReAuth(
  page: Page,
  credentials: ReAuthCredentials,
  logger: TaskLogger,
  logPrefix = "[re-auth]"
): Promise<boolean> {
  const preUrl = page.url();

  // Only attempt hl=en on dedicated accounts.google.com challenge pages.
  // NEVER on myaccount.google.com/family/... — inline overlays (password/TOTP
  // dialogs) would be destroyed by the page.goto() reload.
  if (preUrl.includes("accounts.google.com/") && (preUrl.includes("challenge/") || preUrl.includes("signin/"))) {
    await _tryEnsureEnglish(page, logger, logPrefix);
  }

  const currentUrl = page.url();

  // ── 1. Challenge selection page (must check FIRST) ──
  if (currentUrl.includes("challenge/selection")) {
    return _handleChallengeSelection(page, credentials, logger, logPrefix);
  }

  // ── 2. TOTP challenge (URL-based) ──
  if (currentUrl.includes("challenge/totp") || currentUrl.includes("challenge/az")) {
    return _handleTotp(page, credentials, logger, logPrefix);
  }

  // ── 3. Non-automatable challenge (sk/dp/ipp) — try "Try another way" link ──
  // MUST come before the generic signin/challenge password check, because URLs
  // like signin/challenge/sk contain "signin/challenge" but are NOT password pages.
  if (
    currentUrl.includes("challenge/sk") ||
    currentUrl.includes("challenge/dp") ||
    currentUrl.includes("challenge/ipp")
  ) {
    const tryAnotherWay = page.locator([
      // EN
      'a:has-text("Try another way")',
      'button:has-text("Try another way")',
      // 简中
      'a:has-text("尝试其他方式")',
      'a:has-text("换一种方式")',
      'a:has-text("其他验证方式")',
      // 繁中
      'a:has-text("嘗試其他方式")',
      'a:has-text("其他驗證方式")',
      // 日本語
      'a:has-text("別の方法を試す")',
      'a:has-text("別の方法")',
      // 한국어
      'a:has-text("다른 방법 시도")',
      'a:has-text("다른 방법으로")',
      // Tiếng Việt
      'a:has-text("Thử cách khác")',
      'a:has-text("Thử một cách khác")',
      // Structural fallback
      'a[jsname="Njthtb"]',
    ].join(", "));

    // Wait for Google's JS to render the link (often lazy-loaded)
    try {
      await tryAnotherWay.first().waitFor({ state: "visible", timeout: 5_000 });
    } catch {
      // Link didn't render in time — fall through to step 8 probe
    }

    if ((await tryAnotherWay.count()) > 0) {
      await tryAnotherWay.first().click();
      await logger.log("INFO", `${logPrefix} Clicked "Try another way" on ${currentUrl}`);
      await page.waitForTimeout(3000);
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      return true;
    }
    // Link not found after wait — fall through; step 4 won't false-match
    // because we removed the broad "signin/challenge" condition from it.
  }

  // ── 4. Password challenge ──
  // Match by specific URL (challenge/pwd) or by actual VISIBLE password input.
  // Do NOT use the broad "signin/challenge" — that substring appears in ALL
  // challenge URLs (signin/challenge/sk, signin/challenge/totp, etc.) and would
  // hijack non-password challenges into _handlePassword.
  // Use :visible for the DOM fallback to avoid matching hidden password fields
  // that Google may pre-render on non-password pages.
  const hasPwdInput = (await page.locator(`${PASSWORD_INPUT}:visible`).count()) > 0;
  if (currentUrl.includes("challenge/pwd") || hasPwdInput) {
    return _handlePassword(page, credentials, logger, logPrefix);
  }

  // ── 5. Identifier/email page ──
  const identifierInput = page.locator('input[type="email"]');
  if ((await identifierInput.count()) > 0) {
    // Fill email if the field is empty and we have credentials
    const currentValue = await identifierInput.first().inputValue().catch(() => "");
    if (!currentValue && credentials.loginEmail) {
      await identifierInput.first().fill(credentials.loginEmail);
      await logger.log("INFO", `${logPrefix} Filled email on identifier page`);
    }
    const nextBtn = page.locator(NEXT_BUTTON);
    if ((await nextBtn.count()) > 0) {
      await nextBtn.first().click();
      await logger.log("INFO", `${logPrefix} Clicked Next on identifier page`);
      await page.waitForTimeout(3000);
      await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
      return true;
    }
  }

  // ── 6. Inline TOTP input (not on accounts.google.com but visible) ──
  if (credentials.totpSecret) {
    const inlineTotp = page.locator(TOTP_INPUT);
    let hasVisibleTotp = false;
    for (let i = 0; i < await inlineTotp.count(); i++) {
      if (await inlineTotp.nth(i).isVisible().catch(() => false)) {
        hasVisibleTotp = true;
        break;
      }
    }
    if (hasVisibleTotp) {
      return _handleTotp(page, credentials, logger, logPrefix);
    }
  }

  // ── 7. Inline password input ──
  if (credentials.password) {
    const inlinePwd = page.locator('input[type="password"]:visible');
    if ((await inlinePwd.count()) > 0) {
      return _handlePassword(page, credentials, logger, logPrefix);
    }
  }

  // ── 8. Unknown challenge URL — wait for delayed TOTP or password input ──
  // Google may render inputs after JS hydration on non-standard challenge pages.
  // Also covers bare "signin/challenge" (no sub-type) which doesn't contain "challenge/".
  if (currentUrl.includes("challenge/") || currentUrl.includes("signin/challenge")) {
    await logger.log(
      "INFO",
      `${logPrefix} Unknown challenge URL (${currentUrl}), probing for delayed inputs...`
    );

    const totpProbe = credentials.totpSecret
      ? page.locator(TOTP_INPUT).first().waitFor({ state: "visible", timeout: 10_000 })
          .then(() => "totp" as const).catch(() => null)
      : null;
    const pwdProbe = credentials.password
      ? page.locator(PASSWORD_INPUT).first().waitFor({ state: "visible", timeout: 10_000 })
          .then(() => "pwd" as const).catch(() => null)
      : null;

    const probes = [totpProbe, pwdProbe].filter(Boolean) as Promise<"totp" | "pwd" | null>[];
    if (probes.length > 0) {
      const winner = await Promise.race([
        ...probes,
        page.waitForTimeout(10_000).then(() => null),
      ]);
      if (winner === "totp") return _handleTotp(page, credentials, logger, logPrefix);
      if (winner === "pwd") return _handlePassword(page, credentials, logger, logPrefix);
    }
  }

  return false;
}

/**
 * Run re-auth handling in a loop until no more challenges are detected.
 * Useful for flows where Google may chain multiple challenges
 * (e.g. identifier → password → TOTP).
 *
 * @returns true if any re-auth was performed
 */
export async function handleReAuthLoop(
  page: Page,
  credentials: ReAuthCredentials,
  logger: TaskLogger,
  options?: { maxRounds?: number; logPrefix?: string }
): Promise<boolean> {
  const maxRounds = options?.maxRounds ?? 8;
  const logPrefix = options?.logPrefix ?? "[re-auth]";
  let anyHandled = false;
  // Capture prevUrl AFTER the first handleReAuth call (which may add hl=en),
  // so the comparison isn't thrown off by _tryEnsureEnglish's URL rewrite.
  let prevUrl: string | null = null;
  // Google's SPA-style challenge pages (signin/challenge, signin/v2/challenge)
  // can transition from email → password → TOTP without URL changes.
  // Allow 2 consecutive same-URL rounds before stopping, so that at least one
  // SPA step transition is tolerated.  A threshold of 1 would block legitimate
  // email→password progression on the same URL.
  let sameUrlCount = 0;

  for (let round = 0; round < maxRounds; round++) {
    const handled = await handleReAuth(page, credentials, logger, logPrefix);
    if (!handled) break;
    anyHandled = true;

    const newUrl = _stripHlParam(page.url());
    if (prevUrl !== null && newUrl === prevUrl) {
      sameUrlCount++;
      if (sameUrlCount >= 2) {
        await logger.log(
          "WARN",
          `${logPrefix} Page URL unchanged for ${sameUrlCount} consecutive rounds (${page.url()}) — stopping to avoid repeat submissions`
        );
        break;
      }
    } else {
      sameUrlCount = 0;
    }
    prevUrl = newUrl;
  }

  return anyHandled;
}

/** Strip the hl= query param for URL comparison so _tryEnsureEnglish doesn't cause false "changed" signals. */
function _stripHlParam(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete("hl");
    return u.toString();
  } catch {
    return url;
  }
}

// ── Internal handlers ──

async function _handleChallengeSelection(
  page: Page,
  credentials: ReAuthCredentials,
  logger: TaskLogger,
  logPrefix: string
): Promise<boolean> {
  await logger.log("INFO", `${logPrefix} Challenge selection page detected`);

  if (!credentials.totpSecret) {
    const msg = `${logPrefix} Challenge selection page detected but no totpSecret configured — cannot proceed`;
    await logger.log("ERROR", msg);
    throw new Error(msg);
  }

  // Priority 1: data-challengetype="6" (TOTP / Google Authenticator)
  const totpOption = page.locator(CHALLENGE_TOTP_DATA);
  if ((await totpOption.count()) > 0) {
    await totpOption.first().click();
    await logger.log("INFO", `${logPrefix} Selected TOTP from challenge selection (data-challengetype)`);
    await page.waitForTimeout(3000);
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    return true;
  }

  // Priority 2: text-based TOTP option
  const totpTextOption = page.locator(CHALLENGE_TOTP_TEXT);
  if ((await totpTextOption.count()) > 0) {
    await totpTextOption.first().click();
    await logger.log("INFO", `${logPrefix} Selected TOTP from challenge selection (text match)`);
    await page.waitForTimeout(3000);
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    return true;
  }

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
  const msg = `${logPrefix} No automatable challenge option found. Available: ${JSON.stringify(allOptions)}`;
  await logger.log("ERROR", msg);
  throw new Error(msg);
}

async function _handleTotp(
  page: Page,
  credentials: ReAuthCredentials,
  logger: TaskLogger,
  logPrefix: string
): Promise<boolean> {
  if (!credentials.totpSecret) {
    const msg = `${logPrefix} TOTP challenge detected but no totpSecret configured — cannot proceed`;
    await logger.log("ERROR", msg);
    throw new Error(msg);
  }

  await logger.log("INFO", `${logPrefix} TOTP challenge detected`);

  // Wait for fresh TOTP code if about to expire OR if this window's code was already used
  // (Google rejects reuse of the same code within the same 30s period)
  const remaining = totpSecondsRemaining();
  const secret = credentials.totpSecret!;
  if (isTotpWindowUsed(secret) || remaining < 5) {
    const waitSecs = remaining + 1;
    await logger.log(
      "INFO",
      `${logPrefix} Waiting ${waitSecs}s for fresh TOTP (${isTotpWindowUsed(secret) ? "window already used" : "about to expire"})`
    );
    await page.waitForTimeout(waitSecs * 1000);
  }

  const code = generateTOTP(credentials.totpSecret, credentials.loginEmail);
  await logger.log("INFO", `${logPrefix} Generated TOTP: ${code.slice(0, 2)}****`);

  // Locate TOTP input — may need to click "Google Authenticator" option first
  let totpInput = page.locator(TOTP_INPUT);
  try {
    await totpInput.first().waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    const authOption = page.locator(CHALLENGE_TOTP_TEXT);
    if ((await authOption.count()) > 0) {
      await authOption.first().click();
      await logger.log("INFO", `${logPrefix} Clicked Authenticator option to reveal TOTP input`);
      await page.waitForTimeout(3000);
    }
    totpInput = page.locator(TOTP_INPUT);
  }

  if ((await totpInput.count()) === 0) {
    await logger.log("WARN", `${logPrefix} Cannot find TOTP input field`);
    return false;
  }

  await totpInput.first().fill(code);

  // Submit via button or Enter key
  const submitBtn = page.locator(TOTP_SUBMIT);
  if ((await submitBtn.count()) > 0) {
    try {
      await submitBtn.first().evaluate((el: HTMLElement) => el.click());
    } catch {
      await page.keyboard.press("Enter");
    }
  } else {
    await page.keyboard.press("Enter");
  }

  await logger.log("INFO", `${logPrefix} TOTP submitted`);
  markTotpUsed(secret);
  await page.waitForTimeout(5000);
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});

  // Retry with fresh code if still on TOTP page (first code may have been rejected)
  const postUrl = page.url();
  const stillOnTotp =
    postUrl.includes("challenge/totp") ||
    postUrl.includes("challenge/az");

  if (stillOnTotp) {
    await logger.log("WARN", `${logPrefix} Still on TOTP page, retrying with fresh code`);
    const retryRemaining = totpSecondsRemaining();
    await logger.log("INFO", `${logPrefix} Waiting ${retryRemaining + 1}s for next TOTP window`);
    await page.waitForTimeout((retryRemaining + 1) * 1000);

    const freshCode = generateTOTP(credentials.totpSecret!, credentials.loginEmail);
    await logger.log("INFO", `${logPrefix} TOTP retry: ${freshCode.slice(0, 2)}****`);

    const retryInput = page.locator(TOTP_INPUT);
    if ((await retryInput.count()) > 0) {
      await retryInput.first().fill("");
      await page.waitForTimeout(300);
      await retryInput.first().fill(freshCode);

      const retryBtn = page.locator(TOTP_SUBMIT);
      if ((await retryBtn.count()) > 0) {
        try {
          await retryBtn.first().evaluate((el: HTMLElement) => el.click());
        } catch {
          await page.keyboard.press("Enter");
        }
      } else {
        await page.keyboard.press("Enter");
      }
      markTotpUsed(secret);
      await page.waitForTimeout(5000);
      await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
    }

    const postRetryUrl = page.url();
    if (postRetryUrl.includes("challenge/totp") || postRetryUrl.includes("challenge/az")) {
      await logger.log("ERROR", `${logPrefix} TOTP verification failed after retry — still on challenge page. URL: ${postRetryUrl}`);
      return false;
    }
  }

  return true;
}

async function _handlePassword(
  page: Page,
  credentials: ReAuthCredentials,
  logger: TaskLogger,
  logPrefix: string
): Promise<boolean> {
  const password = credentials.password;
  if (!password) {
    const msg = `${logPrefix} Password challenge detected but no password configured — cannot proceed`;
    await logger.log("ERROR", msg);
    throw new Error(msg);
  }

  await logger.log("INFO", `${logPrefix} Password challenge detected`);

  // Wait for password input to become visible
  const pwdInput = page.locator(PASSWORD_INPUT);
  try {
    await pwdInput.first().waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    await logger.log("WARN", `${logPrefix} Password input not visible, waiting...`);
    await page.waitForTimeout(3000);
  }

  // Fill visible password input
  const visiblePwd = page.locator(
    `${PASSWORD_INPUT}:visible, input[type="password"]:visible`
  );
  if ((await visiblePwd.count()) > 0) {
    await visiblePwd.first().fill(password);

    const submitBtn = page.locator(PASSWORD_SUBMIT);
    if ((await submitBtn.count()) > 0) {
      try {
        await submitBtn.first().evaluate((el: HTMLElement) => el.click());
      } catch {
        await page.keyboard.press("Enter");
      }
    } else {
      await page.keyboard.press("Enter");
    }

    await logger.log("INFO", `${logPrefix} Password submitted`);
    await page.waitForTimeout(5000);
    await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
    return true;
  }

  await logger.log("WARN", `${logPrefix} Password input still not visible after wait`);
  return false;
}

/**
 * Try to switch a Google page to English by appending hl=en.
 * Only call on pages where no form input has been started (e.g. challenge/selection).
 * Silently no-ops if the page is already English or not on Google.
 */
async function _tryEnsureEnglish(
  page: Page,
  logger: TaskLogger,
  logPrefix: string
): Promise<void> {
  try {
    const url = new URL(page.url());
    if (url.hostname.includes("google") && url.searchParams.get("hl") !== "en") {
      url.searchParams.set("hl", "en");
      await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(1500);
      await logger.log("INFO", `${logPrefix} Switched page to English (hl=en)`);
    }
  } catch {
    // Non-fatal — fall back to multi-language selectors
  }
}
