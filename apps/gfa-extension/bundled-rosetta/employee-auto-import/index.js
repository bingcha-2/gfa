#!/usr/bin/env node
/**
 * Employee Auto-Import — Local AdsPower OAuth Worker
 *
 * Spawned by the VS Code extension. Reads a single JSON line from stdin,
 * connects to a local AdsPower browser profile via CDP (puppeteer-core),
 * performs Google OAuth login + consent + token exchange, and writes
 * a result JSON line to stdout.
 *
 * Usage:
 *   echo '{"adspowerUrl":"http://localhost:50325","adspowerApiKey":"...","profileId":"xxx",...}' | node index.js
 *
 * Input JSON:
 *   { adspowerUrl, adspowerApiKey?, profileId, email, password, recoveryEmail?, totpSecret? }
 *
 * Output JSON lines (one per event):
 *   { type: "progress", message: "..." }
 *   { type: "result", ok: true, refreshToken: "...", email: "..." }
 *   { type: "result", ok: false, error: "..." }
 */

"use strict";

const puppeteer = require("puppeteer-core");
const { generateTOTP, totpSecondsRemaining } = require("./totp-helper");
const fs = require("fs");
const path = require("path");
const { HeroSmsClient, HERO_SMS_COUNTRIES } = require("./hero-sms-client");

// Cross-platform log path: use Rosetta data dir (shared/paths.js)
const LOG_FILE = (() => {
  try {
    const paths = require("../shared/paths");
    const logsDir = path.join(paths.DATA_DIR, "logs");
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    return path.join(logsDir, "employee-debug.log");
  } catch {
    // Fallback: write next to this script
    return path.join(__dirname, "employee-debug.log");
  }
})();
const HERO_SMS_API_KEY = "9d47259de8ff5d5ef0B449ecc9d168ff";

// ─── Constants ────────────────────────────────────────────────────────────────
const OAUTH_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const OAUTH_CLIENT_SECRET = "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";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_LOGIN_URL = "https://accounts.google.com?hl=en";
const SUCCESS_DOMAIN = "myaccount.google.com";
// Port is assigned dynamically per worker to avoid collisions
let OAUTH_PORT = 19876 + Math.floor(Math.random() * 100); // 19876-19975
let REDIRECT_URI = `http://127.0.0.1:${OAUTH_PORT}/oauth-callback`;
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
].join(" ");
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

const LOGIN_TIMEOUT_MS = 120_000; // 2 min total login budget
const OAUTH_TIMEOUT_MS = 120_000; // 2 min OAuth consent budget
const MANUAL_WAIT_MS = 10 * 60 * 1000; // 10 min manual wait for challenges

// ─── Helpers ──────────────────────────────────────────────────────────────────

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function progress(message) {
  emit({ type: "progress", message });
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`);
  } catch (e) {}
}

function resultOk(data) {
  emit({ type: "result", ok: true, ...data });
}

function resultFail(error) {
  emit({ type: "result", ok: false, error: String(error) });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Safe click helper — handles "Node is either not clickable or not an Element"
 * and "Protocol error" by falling back to a JS-based click.
 */
async function safeClick(el, label) {
  try {
    await el.click();
  } catch (e) {
    const msg = String(e.message || e);
    if (
      msg.includes('not clickable') ||
      msg.includes('not an Element') ||
      msg.includes('Node is detached') ||
      msg.includes('Protocol error') ||
      msg.includes('timed out') ||
      msg.includes('context') ||
      msg.includes('detached') ||
      msg.includes('describeNode')
    ) {
      // Fallback: click via JavaScript
      try {
        await el.evaluate((node) => node.click());
        if (label) progress(`[safeClick] JS fallback succeeded for: ${label}`);
      } catch (jsErr) {
        if (label) progress(`[safeClick] JS fallback also failed for ${label}: ${jsErr.message}`);
      }
    } else {
      throw e;
    }
  }
}

async function waitUrlChange(page, oldUrl, maxWaitSecs = 15) {
  let changed = false;
  for (let i = 0; i < maxWaitSecs; i++) {
    await sleep(1000);
    if (page.url() !== oldUrl) {
      changed = true;
      break;
    }
  }
  await sleep(1500);
  return changed;
}

async function waitForNextState(page, timeoutMs = 30000) {
  const currentUrl = page.url();
  const signals = [
    page.waitForFunction((url) => window.location.href !== url, { timeout: timeoutMs }, currentUrl).then(() => "url-changed").catch(() => ""),
    page.waitForSelector('input[type="password"]:not([aria-hidden="true"]):not([name="hiddenPassword"])', { visible: true, timeout: timeoutMs }).then(() => "password-visible").catch(() => ""),
    page.waitForSelector('input[type="tel"], input[name="totpPin"], input[id="totpPin"], input[autocomplete="one-time-code"]', { visible: true, timeout: timeoutMs }).then(() => "totp-visible").catch(() => ""),
    sleep(timeoutMs).then(() => "timeout")
  ];
  await Promise.race(signals);
  await sleep(200);
}

async function detectPageLoading(page) {
  return await page.evaluate(() => {
    if (document.querySelector('[role="progressbar"], .progress-bar, .eLNT1d, .sZwd7c, .OZJlec')) return true;
    const nextBtn = document.querySelector('#identifierNext button, #passwordNext button');
    if (nextBtn && nextBtn.disabled) return true;
    const emailInput = document.querySelector('input[type="email"], input[id="identifierId"]');
    if (emailInput && (emailInput.offsetParent === null)) return true;
    return false;
  }).catch(() => false);
}

async function dismissErrorPopup(page) {
  const dismissed = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const restartBtn = btns.find(b => {
      const t = (b.textContent || '').trim();
      return t === 'Restart' || t === '重试' || t === '重新开始' || t === '重新啟動' || t === 'Try again';
    });
    if (restartBtn) {
      restartBtn.click();
      return true;
    }
    return false;
  }).catch(() => false);
  if (dismissed) {
    progress("检测到'出现问题'弹窗，已自动点击重试...");
    await sleep(2000);
  }
  return dismissed;
}

// ─── AdsPower API ─────────────────────────────────────────────────────────────

async function adspowerOpenProfile(baseUrl, profileId, apiKey) {
  const url = new URL("/api/v1/browser/start", baseUrl);
  url.searchParams.set("user_id", profileId);
  // Build fetch options: newer AdsPower versions require Authorization header
  const fetchOpts = {};
  if (apiKey) {
    fetchOpts.headers = { "Authorization": `Bearer ${apiKey}` };
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url.toString(), fetchOpts);
      const json = await res.json();
      if (json.code === 0 && json.data?.ws?.puppeteer) {
        return json.data.ws.puppeteer; // CDP websocket URL
      }
      if (attempt < 3) {
        // If profile is busy, try closing first
        if (json.msg && (json.msg.includes("is being used") || json.msg.includes("not allowed"))) {
          await adspowerCloseProfile(baseUrl, profileId, apiKey);
          await sleep(2000);
        } else {
          await sleep(3000);
        }
        continue;
      }
      throw new Error(`AdsPower open failed: ${json.msg || "unknown"}`);
    } catch (err) {
      if (attempt >= 3) throw err;
      await sleep(3000);
    }
  }
}

async function adspowerCloseProfile(baseUrl, profileId, apiKey) {
  try {
    const url = new URL("/api/v1/browser/stop", baseUrl);
    url.searchParams.set("user_id", profileId);
    const fetchOpts = {};
    if (apiKey) {
      fetchOpts.headers = { "Authorization": `Bearer ${apiKey}` };
    }
    await fetch(url.toString(), fetchOpts);
  } catch { /* best effort */ }
}

// ─── Gmail Login (simplified) ─────────────────────────────────────────────────

async function gmailLogin(page, creds) {
  const { email, password, totpSecret } = creds;
  progress(`正在登录 ${email}...`);

  await page.goto(GOOGLE_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: LOGIN_TIMEOUT_MS });
  await sleep(2000);

  // Email
  const emailInput = await page.waitForSelector(
    'input[type="email"], input[id="identifierId"]',
    { visible: true, timeout: 30000 }
  ).catch(() => null);
  if (!emailInput) {
    if (page.url().includes(SUCCESS_DOMAIN)) {
      progress("已登录（免密码）");
      return true;
    }
    throw new Error("找不到邮箱输入框（可能网络极慢或被拦截）");
  }
  await atomicType(page, emailInput, email);
  try { await page.keyboard.press("Enter"); } catch(e) {}
  await waitForNextState(page, 8000);

  // Robust email submission retry
  for (let nextRetry = 0; nextRetry < 4; nextRetry++) {
    if (!page.url().includes("/identifier")) break;
    const isTransitioning = await detectPageLoading(page);
    if (isTransitioning) {
      progress("页面正在加载中，耐心等待...");
      await waitForNextState(page, 15000);
      if (!page.url().includes("/identifier")) break;
    }
    progress(`仍在邮箱页面，重试提交 (${nextRetry + 1})...`);
    await dismissErrorPopup(page);
    const retryInput = await page.$('input[type="email"], input[id="identifierId"]');
    if (retryInput) {
      try { await retryInput.click({ clickCount: 3 }); } catch(e) { if(e.message.includes('context') || e.message.includes('detached') || e.message.includes('describeNode')) { emit({ type: "progress", message: "页面跳转，忽略交互错误" }); } else throw e; }
      await atomicType(page, retryInput, email);
    }
    try { await page.keyboard.press("Enter"); } catch(e) {}
    await waitForNextState(page, 8000);
  }

  // reCAPTCHA detection — immediately abort
  if (page.url().includes("recaptcha") || page.url().includes("challenge/recaptcha")) {
    throw new Error("检测到人机验证 (reCAPTCHA)，由于策略更改，直接结束任务，请更换账号或手动处理");
  }

  // Password
  progress("等待密码输入框...");
  let passwordInput = await page.waitForSelector(
    'input[type="password"]:not([aria-hidden="true"]):not([name="hiddenPassword"])',
    { visible: true, timeout: 15000 }
  ).catch(() => null);

  if (!passwordInput) {
    if (page.url().includes(SUCCESS_DOMAIN)) {
      progress("已登录（免密码）");
      return true;
    }
    // Check for reCAPTCHA again
    if (page.url().includes("recaptcha")) {
      throw new Error("密码页前遇到人机验证 (reCAPTCHA)，由于策略更改，直接结束任务");
    }
    if (!passwordInput) {
      const currentUrl = page.url();
      progress(`密码框未出现 (URL: ${currentUrl})，尝试刷新重载...`);
      await page.goto(GOOGLE_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      const retryEmail = await page.waitForSelector('input[type="email"]', { visible: true, timeout: 10000 }).catch(() => null);
      if (retryEmail) {
        await atomicType(page, retryEmail, email);
        try { await page.keyboard.press("Enter"); } catch(e) {}
        await waitForNextState(page, 15000);
      }
      passwordInput = await page.waitForSelector(
        'input[type="password"]:not([aria-hidden="true"]):not([name="hiddenPassword"])',
        { visible: true, timeout: 20000 }
      ).catch(() => null);

      if (!passwordInput) {
        progress(`重新加载后仍遇到未知页面，请手动处理: ${page.url()}`);
        const resolved = await waitForManualResolution(page);
        if (!resolved) throw new Error(`登录需要手动验证: ${page.url()}`);
        if (page.url().includes(SUCCESS_DOMAIN)) return true;
        passwordInput = await page.$('input[type="password"]:not([aria-hidden="true"]):not([name="hiddenPassword"])');
        if (!passwordInput) throw new Error(`手动验证后仍无法找到密码框: ${page.url()}`);
      }
    }
  }

  const pwdUrl = page.url();
  await atomicType(page, passwordInput, password);
  try { await page.keyboard.press("Enter"); } catch(e) {}
  await waitUrlChange(page, pwdUrl, 10);

  // Post-login challenges (up to 8 rounds, matching GFA-master)
  let totpSubmitted = false;
  for (let round = 0; round < 8; round++) {
   try {
    await dismissErrorPopup(page);
    const url = page.url();
    progress(`登录后处理 (round ${round + 1}): ${url.substring(0, 80)}`);

    if (url.includes(SUCCESS_DOMAIN) || url.includes("mail.google.com")) {
      return true;
    }

    // Google redirected to support page — account locked
    if (url.includes("support.google.com")) {
      throw new Error(`账号被锁定或验证失败: ${url}`);
    }

    // reCAPTCHA in post-login challenge
    if (url.includes("recaptcha") || url.includes("challenge/recaptcha")) {
      throw new Error("登录后遇到人机验证 (reCAPTCHA)，由于策略更改，直接结束任务");
    }

    // Password re-entry
    if (url.includes("challenge/pwd")) {
      const pwdInput = await page.waitForSelector(
        'input[type="password"]:not([aria-hidden="true"]):not([name="hiddenPassword"])',
        { visible: true, timeout: 8000 }
      ).catch(() => null);
      if (pwdInput) {
        const rePwdUrl = page.url();
        await atomicType(page, pwdInput, password);
        try { await page.keyboard.press("Enter"); } catch(e) {}
        await waitUrlChange(page, rePwdUrl, 10);
        continue;
      }
    }

    // TOTP 2FA — detect by INPUT PRESENCE (not just URL), matching GFA-master approach
    // Extended timeout if on /challenge/totp to wait out network delays
    const totpTimeout = url.includes("challenge/totp") ? 30000 : 3000;
    const totpInput = await page.waitForSelector(
      'input[type="tel"], input[name="totpPin"], input[id="totpPin"], input[autocomplete="one-time-code"]',
      { visible: true, timeout: totpTimeout }
    ).catch(() => null);
    
    if (totpInput && totpSecret) {
      if (totpSubmitted) {
        const waitSecs = totpSecondsRemaining() + 2;
        progress(`TOTP 被拒绝，等待 ${waitSecs}s 获取新验证码...`);
        await sleep(waitSecs * 1000);
        const urlAfterWait = page.url();
        if (urlAfterWait.includes(SUCCESS_DOMAIN) || urlAfterWait.includes("mail.google.com") || urlAfterWait.includes("/o/oauth2")) {
          progress("TOTP 实际已通过（等待期间页面跳转）");
          return true;
        }
      }

      progress("检测到 TOTP 验证...");
      const remaining = totpSecondsRemaining();
      if (remaining < 5) {
        progress(`等待 ${remaining + 1}s 获取新 TOTP...`);
        await sleep((remaining + 1) * 1000);
      }
      const code = generateTOTP(totpSecret);

      try { await totpInput.click({ clickCount: 3 }); } catch(e) { if(e.message.includes('context') || e.message.includes('detached') || e.message.includes('describeNode')) { emit({ type: "progress", message: "页面跳转，忽略交互错误" }); } else throw e; }
      await atomicType(page, totpInput, code);
      try { await page.keyboard.press("Enter"); } catch(e) {}
      progress(`TOTP 已提交: ${code.substring(0, 2)}****`);
      totpSubmitted = true;
      // 提交后切勿直接使用 waitForNextState，因为输入框依然可见会导致立刻触发，造成过早判定为失败
      const preSubmitUrl = page.url();
      progress("等待 TOTP 验证通过并跳转...");
      let navigated = false;
      for (let i = 0; i < 15; i++) {
        await sleep(1000);
        if (page.url() !== preSubmitUrl) {
          navigated = true;
          break;
        }
      }
      if (!navigated) {
        progress("警告：TOTP 提交后 15 秒内页面 URL 未发生变化");
      }
      await sleep(2000); // Give DOM a moment to settle after URL change
      continue;
    }

    // Challenge selection page — auto-select TOTP option (from GFA-master)
    if (url.includes("challenge/selection") && totpSecret) {
      progress("检测到验证方式选择页面，尝试选择 TOTP...");
      // Try data-challengetype=6 (TOTP / Google Authenticator)
      let totpOption = await page.$('div[data-challengetype="6"], li[data-challengetype="6"], [data-challengeindex][data-challengetype="6"]');
      if (!totpOption) {
        // Fallback: text-based search
        totpOption = await page.evaluateHandle(() => {
          const items = document.querySelectorAll('li, div[role="link"]');
          for (const item of items) {
            const text = item.textContent || "";
            if (/authenticator|身份验证器|驗證器|verification code|验证码/i.test(text)) {
              return item;
            }
          }
          return null;
        }).then(h => h.asElement());
      }
      if (totpOption) {
        await safeClick(totpOption, "TOTP option");
        progress("已选择 TOTP 验证方式");
        await sleep(3000);
        continue;
      }
      progress("未找到 TOTP 选项");
    }

    // Speedbump / passkey enrollment / GDS recovery pages — skip
    if (url.includes("/speedbump/") || url.includes("gds.google.com")) {
      const skipBtn = await findButton(page, ["Not now", "Skip", "Cancel", "以后再说", "跳过", "暂不", "取消", "No thanks", "不用了", "Done", "完成", "Continue", "继续", "Yes", "是的"]);
      if (skipBtn) {
        await safeClick(skipBtn, "GDS skip");
        await sleep(3000);
        continue;
      }
      // Fallback: navigate directly to myaccount to exit GDS flow
      if (url.includes("gds.google.com")) {
        progress("GDS 页面无可用按钮，直接跳转 myaccount...");
        await page.goto("https://myaccount.google.com/?hl=en", { waitUntil: "domcontentloaded", timeout: 30000 });
        await sleep(2000);
        continue;
      }
    }

    // ToS / privacy
    const agreeBtn = await findButton(page, ["I agree", "同意", "接受", "Accept", "Confirm", "確認", "确认"]);
    if (agreeBtn) {
      await safeClick(agreeBtn, "ToS agree");
      progress("已接受条款");
      await sleep(3000);
      continue;
    }

    // Age / birthday
    const monthSelect = await page.$('select[id*="month" i], select[name*="month" i]');
    if (monthSelect) {
      await monthSelect.select("1");
      const dayInput = await page.$('input[id*="day" i], input[name*="day" i]');
      if (dayInput) await atomicType(page, dayInput, "1");
      const yearInput = await page.$('input[id*="year" i], input[name*="year" i]');
      if (yearInput) await atomicType(page, yearInput, "1990");
      const nextBtn = await findButton(page, ["Next", "下一步"]);
      if (nextBtn) await safeClick(nextBtn, "Age next");
      await sleep(3000);
      continue;
    }

    // Any other challenge — wait for manual handling
    progress(`遇到验证页面，请在 AdsPower 浏览器中手动处理...`);
    const resolved = await waitForManualResolution(page);
    if (!resolved) throw new Error(`登录挂起: ${url}`);
    if (page.url().includes(SUCCESS_DOMAIN)) return true;
   } catch (loopErr) {
      const errMsg = String(loopErr.message || loopErr);
      if (
        errMsg.includes("Execution context") ||
        errMsg.includes("detached") ||
        errMsg.includes("not clickable") ||
        errMsg.includes("not an Element") ||
        errMsg.includes("timed out") ||
        errMsg.includes("Protocol error")
      ) {
        progress(`页面临时错误，重试... (${errMsg.substring(0, 60)})`);
        await sleep(2000);
        continue;
      }
      throw loopErr; // re-throw non-navigation errors
   }
  }

  if (page.url().includes(SUCCESS_DOMAIN)) return true;
  throw new Error(`登录未完成: ${page.url()}`);
}


async function atomicType(page, element, text) {
  try {
    // Use element.evaluate (not page.evaluate) to stay in the same JS world
    await element.evaluate((el, val) => {
      el.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      nativeSetter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, text);
  } catch(e) {
    if (e.message.includes('context') || e.message.includes('detached') || e.message.includes('describeNode')) {
      emit({ type: "progress", message: "页面跳转，忽略交互错误" });
    } else if (e.message.includes('world') || e.message.includes('Argument should belong')) {
      // Fallback: use click-to-clear + type if evaluate fails due to world mismatch
      progress("[atomicType] evaluate 失败，回退到 type() 方式");
      try { await element.click({ clickCount: 3 }); } catch(_) {}
      try { await page.keyboard.press('Backspace'); } catch(_) {}
      try { await element.type(text); } catch(_) {}
    } else throw e;
  }
}

async function findButton(page, texts) {
  try {
    const btns = await page.$$(`button, input[type="submit"], div[role="button"], a[role="button"], span[role="button"]`);
    for (let i = btns.length - 1; i >= 0; i--) {
      const btn = btns[i];
      try {
        const info = await btn.evaluate((el) => ({
          text: (el.textContent || el.value || "").trim(),
          visible: el.offsetWidth > 0 && el.offsetHeight > 0 && !el.disabled,
        }));
        if (!info.visible) continue;
        for (const text of texts) {
          if (info.text.toLowerCase() === text.toLowerCase() || info.text.toLowerCase().includes(text.toLowerCase())) {
            return btn;
          }
        }
      } catch { /* element detached or context destroyed — skip */ }
    }
  } catch { /* page navigated — no button found */ }
  return null;
}

async function waitForManualResolution(page) {
  progress(`等待手动操作（最长 ${MANUAL_WAIT_MS / 60000} 分钟）...`);
  const start = Date.now();
  while (Date.now() - start < MANUAL_WAIT_MS) {
    await sleep(3000);
    const url = page.url();
    if (url.includes(SUCCESS_DOMAIN) || url.includes("mail.google.com")) {
      progress("手动验证完成，已成功登录");
      return true;
    }
    // Check if page has moved past the challenge
    if (!url.includes("challenge") && !url.includes("signin") && !url.includes("accounts.google.com")) {
      progress("页面已跳转，继续流程");
      return true;
    }
  }
  progress("手动等待超时");
  return false;
}

// ─── OAuth Page Detector (URL state machine) ──────────────────────────────────

function detectOAuthPage(url) {
  if (url.includes("accountchooser") || url.includes("selectaccount")) return "account_chooser";
  if (url.includes("ServiceLogin") || url.includes("/signin/identifier")) return "email_entry";
  if (url.includes("challenge/pwd") || url.includes("challenge/sk/")) return "password_entry";
  if (url.includes("challenge/totp") || url.includes("challenge/az")) return "totp_challenge";
  if (url.includes("challenge/selection")) return "challenge_selection";
  if (url.includes("signin/oauth/consent") || url.includes("/o/oauth2/auth")) return "consent";
  if (url.includes("firstparty/nativeapp") || url.includes("oauthchooseaccount")) return "native_consent";
  if (url.includes("/speedbump/") || url.includes("gds.google.com")) return "speedbump";
  if (url.includes("support.google.com")) return "locked";
  if (url.includes("challenge/")) return "unknown_challenge";
  return "unknown";
}

async function findAnyButton(page, texts) {
  try {
    // Search: <button>, <input type=submit>, <div role=button>, <a>, <span role=button>
    const allClickable = await page.$$('button, input[type="submit"], div[role="button"], a[role="button"], span[role="button"], a.button, a, [jsname]');
    // Iterate from bottom to top so we hit the main form button before header buttons
    for (let i = allClickable.length - 1; i >= 0; i--) {
      const el = allClickable[i];
      try {
        const info = await el.evaluate((e) => ({
          text: (e.textContent || e.value || "").trim(),
          visible: e.offsetWidth > 0 && e.offsetHeight > 0 && !e.disabled,
        }));
        if (!info.visible) continue;
        for (const t of texts) {
          // Exact equality or strict includes to avoid matching random text blocks
          if (info.text.toLowerCase() === t.toLowerCase() || info.text.toLowerCase().includes(t.toLowerCase())) {
            return el;
          }
        }
      } catch { /* element detached */ }
    }
  } catch { /* page navigated */ }
  return null;
}

async function captureOAuthToken(page, creds) {
  progress("开始 OAuth 授权流程...");
  const http = require("http");

  const state = `employee-auto-import-${Date.now()}`;
  const oauthParams = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    hl: "en",
  });
  const oauthUrl = `${AUTH_URL}?${oauthParams.toString()}`;

  // ── Step 1: Start local HTTP server to catch the OAuth redirect ──
  let authCode = null;
  let authError = null;

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${OAUTH_PORT}`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const returnedState = url.searchParams.get("state");

      if (error) {
        authError = error;
        progress(`OAuth 返回错误: ${error}`);
      } else if (code) {
        // Verify state matches
        if (returnedState && returnedState !== state) {
          progress(`OAuth state 不匹配，忽略 (expected: ${state.slice(-6)}, got: ${(returnedState || "").slice(-6)})`);
        } else {
          authCode = code;
          progress("✅ 已通过 HTTP 回调捕获授权码");
        }
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2>${authCode ? "✅ 授权成功" : "❌ 授权失败"}</h2>
        <p>${authCode ? "已获取授权码，可以关闭此页面。" : (authError || "未知错误")}</p>
        <script>setTimeout(()=>window.close(),2000)</script>
      </body></html>`);
    } catch (e) {
      res.writeHead(500);
      res.end("Internal error");
    }
  });

  // Try to listen on dynamic port (retry with different port if collision)
  for (let portAttempt = 0; portAttempt < 5; portAttempt++) {
    const listenOk = await new Promise((resolve) => {
      server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
          OAUTH_PORT = 19876 + Math.floor(Math.random() * 100);
          REDIRECT_URI = `http://127.0.0.1:${OAUTH_PORT}/oauth-callback`;
          progress(`端口被占用，尝试新端口 ${OAUTH_PORT}...`);
          resolve(false);
        } else {
          progress(`OAuth 服务器启动失败: ${err.message}`);
          resolve(false);
        }
      });
      server.listen(OAUTH_PORT, "127.0.0.1", () => {
        progress(`OAuth 回调服务器已启动 (127.0.0.1:${OAUTH_PORT})`);
        resolve(true);
      });
    });
    if (listenOk) break;
    // Need a new server instance after error
    server.removeAllListeners("error");
  }

  // Update OAuth URL with the correct port
  oauthParams.set("redirect_uri", REDIRECT_URI);
  const finalOauthUrl = `${AUTH_URL}?${oauthParams.toString()}`;

  try {
    // ── Step 2: Navigate to OAuth URL ──
    // The browser is already logged into Google from gmailLogin.
    // Google should show the consent page directly (or at most an account chooser).
    await page.goto(finalOauthUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(2000);

    // ── Step 3: Page-aware automation (state machine) ──────────────────────────
    // Detects current page by URL pattern and handles each type accordingly
    const OAUTH_WAIT_TIMEOUT = 3 * 60 * 1000; // 3 minutes total
    const startTime = Date.now();
    let oauthTotpSubmitted = false;

    while (!authCode && !authError && (Date.now() - startTime) < OAUTH_WAIT_TIMEOUT) {
      if (authCode) break;
     try {
      const nowUrl = page.url();
      const elapsed = Math.round((Date.now() - startTime) / 1000);

      // ── Callback: browser redirected to our local server ──
      if (nowUrl.includes("127.0.0.1:19876") || nowUrl.includes("localhost:19876")) {
        try {
          const code = new URL(nowUrl).searchParams.get("code");
          if (code && !authCode) { authCode = code; break; }
        } catch { /* ignore */ }
      }

      // ── Detect page type by URL ──
      const pageType = detectOAuthPage(nowUrl);
      if (elapsed % 10 === 0 || pageType !== "unknown") {
        progress(`OAuth [${elapsed}s] 页面: ${pageType} — ${nowUrl.substring(0, 70)}...`);
      }

      switch (pageType) {

        case "account_chooser": {
          // Select matching account or first available
          const accountOpt = await page.$(`[data-email="${creds.email}"]`);
          if (accountOpt) {
            await safeClick(accountOpt, "OAuth acc matching");
            progress("OAuth: 选择了匹配账号");
            await sleep(3000);
            continue;
          }
          const firstAcc = await page.$('ul li[role="presentation"], div[data-authuser], div.JDAKTe');
          if (firstAcc) {
            await safeClick(firstAcc, "OAuth acc first");
            progress("OAuth: 选择了第一个账号");
            await sleep(3000);
            continue;
          }
          await sleep(2000);
          continue;
        }

        case "email_entry": {
          await dismissErrorPopup(page);
          const emailInput = await page.waitForSelector(
            'input[type="email"], input[id="identifierId"]',
            { visible: true, timeout: 15000 }
          ).catch(() => null);
          if (emailInput) {
            try { await emailInput.click({ clickCount: 3 }); } catch(e) { if(e.message.includes('context') || e.message.includes('detached') || e.message.includes('describeNode')) { emit({ type: "progress", message: "页面跳转，忽略交互错误" }); } else throw e; }
            await atomicType(page, emailInput, creds.email);
            try { await page.keyboard.press("Enter"); } catch(e) {}
            progress("OAuth: 已填入邮箱");
            await waitForNextState(page, 10000);
          }
          continue;
        }

        case "password_entry": {
          await dismissErrorPopup(page);
          const pwdInput = await page.waitForSelector(
            'input[type="password"]:not([aria-hidden="true"]):not([name="hiddenPassword"])',
            { visible: true, timeout: 15000 }
          ).catch(() => null);
          if (pwdInput && creds.password) {
            const oAuthPwdUrl = page.url();
            await atomicType(page, pwdInput, creds.password);
            try { await page.keyboard.press("Enter"); } catch(e) {}
            progress("OAuth: 已填入密码");
            await waitUrlChange(page, oAuthPwdUrl, 12);
          }
          continue;
        }

        case "totp_challenge": {
          if (!creds.totpSecret) {
            progress("OAuth: TOTP 页面但没有 totpSecret，请手动输入验证码...");
            await sleep(5000);
            continue;
          }
          await dismissErrorPopup(page);
          const totpInput = await page.waitForSelector(
            'input[type="tel"], input[name="totpPin"], input[id="totpPin"], input[autocomplete="one-time-code"], input[aria-label*="code"], input[name="Pin"]',
            { visible: true, timeout: 25000 }
          ).catch(() => null);
          if (totpInput) {
            if (oauthTotpSubmitted) {
              const waitSecs = totpSecondsRemaining() + 2;
              progress(`OAuth: TOTP 被拒绝，等待 ${waitSecs}s 获取新验证码...`);
              await sleep(waitSecs * 1000);
            }
            const remaining = totpSecondsRemaining();
            if (remaining < 5) {
              progress(`OAuth: 等待 ${remaining + 1}s 获取新 TOTP...`);
              await sleep((remaining + 1) * 1000);
            }
            const code = generateTOTP(creds.totpSecret);
            try { await totpInput.click({ clickCount: 3 }); } catch(e) { if(e.message.includes('context') || e.message.includes('detached') || e.message.includes('describeNode')) { emit({ type: "progress", message: "页面跳转，忽略交互错误" }); } else throw e; }
            const oAuthTotpUrl = page.url();
            await atomicType(page, totpInput, code);
            try { await page.keyboard.press("Enter"); } catch(e) {}
            progress(`OAuth: TOTP 已提交: ${code.substring(0, 2)}****`);
            oauthTotpSubmitted = true;
            await waitUrlChange(page, oAuthTotpUrl, 15);
          } else {
            progress("OAuth: TOTP 页面但找不到输入框，等待...");
            await sleep(3000);
          }
          continue;
        }

        case "challenge_selection": {
          if (creds.totpSecret) {
            progress("OAuth: 验证方式选择页面，尝试选择 TOTP...");
            let totpOption = await page.$('div[data-challengetype="6"], li[data-challengetype="6"]');
            if (!totpOption) {
              totpOption = await page.evaluateHandle(() => {
                const items = document.querySelectorAll('li, div[role="link"], div[data-challengeindex]');
                for (const item of items) {
                  const text = item.textContent || "";
                  if (/authenticator|身份验证器|驗證器|verification code|验证码|Google Authenticator/i.test(text)) return item;
                }
                return null;
              }).then(h => h.asElement());
            }
            if (totpOption) {
              await totpOption.click();
              progress("OAuth: 已选择 TOTP 验证方式");
              await sleep(3000);
              continue;
            }
          }
          progress("OAuth: 验证方式选择页面，请手动选择...");
          await sleep(5000);
          continue;
        }

        case "consent":
        case "native_consent": {
          // First check all unchecked scope checkboxes
          const checkboxes = await page.$$('input[type="checkbox"]:not(:checked)');
          if (checkboxes.length > 0) {
            for (const cb of checkboxes) {
              await cb.click().catch(() => {});
            }
            progress("OAuth: 已勾选权限");
            await sleep(1000);
            continue;
          }

          const consentBtn = await findAnyButton(page, [
            "Allow", "Continue", "Allow access", "Grant", "Confirm", "Sign in",
            "允许", "允許", "继续", "繼續", "授权", "確認", "确认", "登录", "登入",
            "I agree", "同意", "Accept", "接受",
            "許可", "続行", "ログイン", "허용", "계속", "로그인",
            "Cho phép", "Tiếp tục", "Đăng nhập"
          ]);
          if (consentBtn) {
            await safeClick(consentBtn, "OAuth consent");
            progress("OAuth: 已点击授权按钮");
            await sleep(5000);
            continue;
          }

          // Try specific submit selectors
          const submitBtn = await page.$('#submit_approve_access, input[id="submit_approve_access"], button[type="submit"], button[name="submit"], div[role="button"][jsname="LgbsSe"]');
          if (submitBtn) {
            await safeClick(submitBtn, "OAuth submit");
            progress("OAuth: 已点击提交按钮");
            await sleep(5000);
            continue;
          }

          progress("OAuth: 同意页面但未找到按钮，等待...");
          await sleep(3000);
          continue;
        }

        case "speedbump": {
          const skipBtn = await findAnyButton(page, [
            "Cancel", "取消", "Skip", "Not now", "No thanks", "以后再说", "以後再說",
            "稍後", "稍后", "不用了", "Yes, it was me", "Yes", "Done", "Continue",
            "Confirm", "完成", "继续", "繼續", "確認", "确认", "是的", "是，是我本人"
          ]);
          if (skipBtn) {
            await skipBtn.click();
            progress("OAuth: 已跳过 GDS/speedbump 页面");
            await sleep(3000);
            continue;
          }
          if (nowUrl.includes("gds.google.com")) {
            await page.goto("https://myaccount.google.com/?hl=en", { waitUntil: "domcontentloaded", timeout: 30000 });
            await sleep(2000);
            continue;
          }
          await sleep(3000);
          continue;
        }

        case "locked": {
          throw new Error(`账号被锁定: ${nowUrl}`);
        }

        default: {
          // Unknown page — try generic button detection
          const genericBtn = await findAnyButton(page, [
            "Allow", "Continue", "Next", "Submit", "Allow access", "Sign in",
            "允许", "继续", "下一步", "提交", "登录", "登入",
            "許可", "続行", "ログイン", "허용", "계속", "로그인",
            "Cho phép", "Tiếp tục", "Đăng nhập"
          ]);
          if (genericBtn) {
            await safeClick(genericBtn, "OAuth generic btn");
            progress("OAuth: 点击了通用按钮");
            await sleep(5000);
            continue;
          }
          if (elapsed % 15 === 0) {
            progress(`OAuth: 等待中... (${elapsed}s) — 可在 AdsPower 浏览器中手动操作`);
          }
          await sleep(3000);
        }
      }

     } catch (oauthLoopErr) {
       const errMsg = String(oauthLoopErr.message || oauthLoopErr);
       if (
         errMsg.includes("Execution context") ||
         errMsg.includes("detached") ||
         errMsg.includes("not clickable") ||
         errMsg.includes("not an Element") ||
         errMsg.includes("timed out") ||
         errMsg.includes("Protocol error")
       ) {
         progress(`OAuth: 临时错误 (${errMsg.substring(0, 60)})，重试...`);
         await sleep(2000);
         continue;
       }
       throw oauthLoopErr;
     }
    }

    if (authError) {
      throw new Error(`OAuth 授权被拒绝: ${authError}`);
    }

    if (!authCode) {
      throw new Error("OAuth 授权超时 (3分钟)。请确保在 AdsPower 浏览器中完成了授权操作。");
    }
  } finally {
    // ── Cleanup: always close the HTTP server ──
    server.close();
  }

  // ── Step 4: Exchange auth code for tokens ──
  progress("正在交换 Token...");
  const tokenParams = new URLSearchParams({
    code: authCode,
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  });

  const tokenRes = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenParams.toString(),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`Token 交换失败 (${tokenRes.status}): ${text}`);
  }

  const tokenData = await tokenRes.json();
  if (!tokenData.refresh_token) {
    throw new Error("Token 交换成功但没有 refresh_token");
  }

  return tokenData;
}

// ─── Project ID Discovery ─────────────────────────────────────────────────────

const CLOUDCODE_API = "https://cloudcode-pa.googleapis.com/v1internal";
const CLOUDCODE_USER_AGENT = "antigravity/1.21.6";

async function callCloudCodeAPI(endpoint, accessToken, body = {}) {
  const res = await fetch(`${CLOUDCODE_API}${endpoint}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": CLOUDCODE_USER_AGENT,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`API ${endpoint} failed (${res.status}): ${text}`);
  }
  return JSON.parse(text);
}

async function discoverProjectId(page, accessToken) {
  progress("正在获取项目号 (loadCodeAssist)...");
  const metadata = { ide_type: "ANTIGRAVITY", ide_version: "1.21.6", ide_name: "antigravity" };

  // Step 1: Call loadCodeAssist
  let loadRes;
  try {
    loadRes = await callCloudCodeAPI(":loadCodeAssist", accessToken, { metadata });
  } catch (e) {
    // 403 = account banned
    if (e.message.includes("403")) {
      progress("⚠️ 账号被 Google 封禁，无法获取项目号");
      throw e;
    }
    throw e;
  }

  // Check if projectId is directly available
  const project = loadRes.cloudaicompanionProject;
  if (typeof project === "string" && project) {
    progress(`✅ 项目号: ${project}`);
    return project;
  }
  if (project?.id) {
    progress(`✅ 项目号: ${project.id}`);
    return project.id;
  }

  // Step 2: Check if validation is required (free-tier)
  const ineligible = (loadRes.ineligibleTiers || []).find(t => t.reasonCode === "VALIDATION_REQUIRED");
  if (ineligible && ineligible.validationUrl) {
    progress("⚠️ 账号需要验证才能使用 free-tier，正在打开验证页面...");
    progress(`验证链接: ${ineligible.validationUrl.substring(0, 80)}...`);

    // Navigate to validation URL in AdsPower browser
    await page.goto(ineligible.validationUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(2000);

    // Wait for user to complete verification (up to 3 minutes)
    const VERIFY_TIMEOUT = 3 * 60 * 1000;
    const verifyStart = Date.now();
    progress("请在 AdsPower 浏览器中完成手机号验证（自动接码已开启，最长等待 3 分钟）...");
    
    let smsTried = false;

    while (Date.now() - verifyStart < VERIFY_TIMEOUT) {
      try {
        const url = page.url();
        if (url.includes("qrcode")) {
          throw new Error("检测到二维码扫码验证 (qrcode)，无法自动处理，任务终止");
        }
        
        // Verification complete — Google redirects to success page (not on accounts.google.com)
        if (!url.includes("accounts.google.com") && (url.includes("auth_success_gemini") || url.includes("gemini-code-assist"))) {
          progress("✅ 账号验证成功！");
          await sleep(2000);
          break;
        }

        // If on selection page, click SMS/phone option (language-agnostic via data-challengetype)
        // Known challenge types from Google:
        //   6  = TOTP (Google Authenticator)
        //   9  = SMS verification
        //   13 = Phone call
        //   12 = Phone prompt (push notification)
        //   8  = Backup codes
        // Handle unexpected password challenge during verification (e.g. session timeout)
        if (url.includes("challenge/pwd")) {
          progress(`检测到密码验证页，尝试重新输入密码...`);
          const pwdInput = await page.$('input[type="password"]');
          if (pwdInput) {
            await sleep(1000);
            await atomicType(page, pwdInput, password);
            await sleep(500);
            await page.keyboard.press("Enter");
            await sleep(3000);
            continue;
          }
        }

        // Handle GDS / Recovery Options pages
        if (url.includes("gds.google.com")) {
          progress(`检测到 GDS 页面 (如恢复选项等)，尝试自动跳过...`);
          const skipBtn = await findAnyButton(page, [
            "Cancel", "取消", "Skip", "Not now", "No thanks", "以后再说", "以後再說",
            "稍後", "稍后", "不用了", "Yes, it was me", "Yes", "Done", "Continue",
            "Confirm", "完成", "继续", "繼續", "確認", "确认", "是的", "是，是我本人"
          ]);
          if (skipBtn) {
            await skipBtn.click();
            await sleep(3000);
            continue;
          }
        }

        const isSelectionPage = url.includes("challenge/selection") || url.includes("uplevelingstep/selection");
        if (isSelectionPage) {
          progress(`检测到验证方式选择页: ${url.substring(0, 100)}`);
          await sleep(2000); // Wait for page to fully render

          // Priority 1: SMS (challengetype=9 or step-type=1) — fully automatable with hero-sms
          const clickResult = await page.evaluate(() => {
            // Try data-challengetype first (most reliable, language-independent)
            const smsOption = document.querySelector(
              'div[data-challengetype="9"], li[data-challengetype="9"], ' +
              'button[data-challengetype="9"], [data-challengeindex][data-challengetype="9"], ' +
              'div[data-step-type="1"], li[data-step-type="1"], button[data-step-type="1"]'
            );
            if (smsOption) {
              smsOption.click();
              return { clicked: 'sms-challengetype-9-or-1' };
            }

            // Priority 2: Phone call (challengetype=13)
            const phoneOption = document.querySelector(
              'div[data-challengetype="13"], li[data-challengetype="13"], ' +
              'button[data-challengetype="13"], [data-challengeindex][data-challengetype="13"]'
            );
            if (phoneOption) {
              phoneOption.click();
              return { clicked: 'phone-challengetype-13' };
            }

            // No data-challengetype match — dump all available options for debugging
            const allItems = document.querySelectorAll(
              '[data-challengetype], [data-step-type], li[role="link"], div[role="link"], li, div[role="button"]'
            );
            const options = Array.from(allItems).map(el => ({
              type: el.getAttribute('data-challengetype') || el.getAttribute('data-step-type'),
              text: (el.innerText || '').trim().slice(0, 80),
            })).filter(o => o.text);
            return { clicked: null, options };
          });

          if (clickResult.clicked) {
            progress(`✅ 已选择验证方式: ${clickResult.clicked}`);
            await sleep(3000);
          } else {
            // Log all available options for debugging
            progress(`⚠️ 未找到可自动化的验证选项。可用选项: ${JSON.stringify(clickResult.options || [])}`);
            // Check if only QR is available
            const hasQrOnly = (clickResult.options || []).some(o => 
              o.text?.includes('QR') || o.text?.includes('qr') || o.text?.includes('二维码') || o.text?.includes('扫码')
            );
            const hasSmsOrPhone = (clickResult.options || []).some(o => 
              o.type === '9' || o.type === '13' || /phone|sms|短信|手机|điện thoại/i.test(o.text || '')
            );
            if (hasQrOnly && !hasSmsOrPhone) {
              throw new Error('验证选择页只有二维码选项，无法自动处理');
            }
          }
        }

        // Automatic SMS verification logic
        if (!smsTried) {
          const phoneInput = await page.$('input[type="tel"], input[name="phoneNumber"], input[autocomplete="tel"]').catch(() => null);
          if (phoneInput) {
            smsTried = true;
            progress("检测到手机号验证框，开始调用 hero-sms 自动接码...");
            const sms = new HeroSmsClient(HERO_SMS_API_KEY);
            try {
              const balance = await sms.getBalance();
              progress(`hero-sms 余额: $${balance}`);
              if (balance < 0.05) throw new Error("hero-sms 余额不足");

              const smsResult = await sms.buyAndWait({
                onNumberReady: async (phone) => {
                  progress(`✅ 拿到手机号 +${phone}，自动填入`);
                  const pi = await page.waitForSelector('input[type="tel"], input[name="phoneNumber"]', {timeout: 5000});
                  await atomicType(page, pi, `+${phone}`);
                  await sleep(500);
                  const clicked = await page.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll("button"));
                    const target = btns.find(b => /Next|Get code|Send|发送|下一步/i.test(b.textContent || ""));
                    if (target) { target.click(); return true; }
                    return false;
                  });
                  if (!clicked) await page.keyboard.press("Enter");
                  progress(`等待短信验证码...`);
                },
                onBeforeRetry: async () => {
                  progress(`接码超时，回退重试换号...`);
                  await page.goBack().catch(() => {});
                  await sleep(2000);
                }
              });

              if (!smsResult) throw new Error("接码全部失败超时");

              progress(`✅ 收到验证码: ${smsResult.code}`);
              const codeInput = await page.waitForSelector('input[autocomplete="one-time-code"], input[name="code"], input[type="tel"]', {timeout: 10000});
              await atomicType(page, codeInput, smsResult.code);
              await sleep(500);
              const verified = await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll("button"));
                const target = btns.find(b => /Verify|Next|Confirm|验证|下一步/i.test(b.textContent || ""));
                if (target) { target.click(); return true; }
                return false;
              });
              if (!verified) await page.keyboard.press("Enter");
              
              await sms.completeNumber(smsResult.activationId);
              await sleep(5000); // Wait for redirect
              continue; // Go back to loop to check success
            } catch (e) {
              progress(`❌ 自动接码报错: ${e.message}。将退回手动等待...`);
            }
          }
        }
      } catch (loopErr) {
        if (loopErr.message && loopErr.message.includes("qrcode")) throw loopErr;
        // Ignore navigation/detached errors
      }

      await sleep(3000);
    }

    // Retry loadCodeAssist after verification
    progress("重新获取项目号...");
    try {
      loadRes = await callCloudCodeAPI(":loadCodeAssist", accessToken, { metadata });
      const retryProject = loadRes.cloudaicompanionProject;
      if (typeof retryProject === "string" && retryProject) {
        progress(`✅ 验证后项目号: ${retryProject}`);
        return retryProject;
      }
      if (retryProject?.id) {
        progress(`✅ 验证后项目号: ${retryProject.id}`);
        return retryProject.id;
      }
    } catch (e) {
      progress(`验证后重试 loadCodeAssist 失败: ${e.message}`);
    }
  }

  // Step 3: Try onboardUser with available tier
  // Prefer free-tier (auto-assigns project) over standard-tier (needs manual GCP project)
  const tiers = loadRes.allowedTiers || [];
  const freeTier = tiers.find(t => t.id === "free-tier");
  const defaultTier = freeTier || tiers.find(t => t.isDefault && !t.userDefinedCloudaicompanionProject) || tiers.find(t => !t.userDefinedCloudaicompanionProject) || tiers[0];
  if (!defaultTier) {
    progress("⚠️ 没有可用的 tier，无法 onboard");
    return "";
  }

  progress(`正在 onboard (tier: ${defaultTier.id})...`);
  const onboardRes = await callCloudCodeAPI(":onboardUser", accessToken, {
    tierId: defaultTier.id,
    metadata,
  });

  // Poll if operation is not done
  if (onboardRes.name && !onboardRes.done) {
    progress("等待 onboard 完成...");
    for (let i = 0; i < 10; i++) {
      await sleep(2000);
      try {
        const pollRes = await fetch(`${CLOUDCODE_API}/${onboardRes.name}`, {
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "User-Agent": CLOUDCODE_USER_AGENT,
          },
        });
        const pollData = await pollRes.json();
        if (pollData.done) {
          const p = pollData.response?.cloudaicompanionProject;
          const pid = typeof p === "string" ? p : p?.id || "";
          if (pid) {
            progress(`✅ Onboard 完成，项目号: ${pid}`);
            return pid;
          }
          break;
        }
      } catch { /* continue polling */ }
    }
  }

  // Check onboard response directly
  if (onboardRes.done) {
    const p = onboardRes.response?.cloudaicompanionProject;
    const pid = typeof p === "string" ? p : p?.id || "";
    if (pid) {
      progress(`✅ Onboard 完成，项目号: ${pid}`);
      return pid;
    }
  }

  // Final retry loadCodeAssist after onboard
  try {
    const finalRes = await callCloudCodeAPI(":loadCodeAssist", accessToken, { metadata });
    const finalProject = finalRes.cloudaicompanionProject;
    const pid = typeof finalProject === "string" ? finalProject : finalProject?.id || "";
    if (pid) {
      progress(`✅ 最终项目号: ${pid}`);
      return pid;
    }
  } catch { /* ignore */ }

  progress("⚠️ 未能获取项目号，账号可能需要手动配置 GCP 项目");
  return "";
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let browser;
  let page;
  let isCleaningUp = false;

  let adspowerUrl = "http://localhost:50325";
  let adspowerApiKey;
  let profileId;
  let email;
  let password;
  let recoveryEmail;
  let totpSecret;

  const cleanupAndExit = async (reason, exitCode = 1) => {
    if (isCleaningUp) return;
    isCleaningUp = true;
    progress(`[Cleanup] ${reason} - 正在清理并关闭浏览器...`);
    if (profileId) {
      try { await adspowerCloseProfile(adspowerUrl, profileId, adspowerApiKey); } catch (_) {}
    }
    if (browser) {
      try { await browser.disconnect(); } catch (_) {}
    }
    resultFail(reason);
    process.exit(exitCode);
  };

  // Global safety timeout — kill process if stuck (prevents zombie accumulation)
  const GLOBAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  const globalTimer = setTimeout(() => {
    cleanupAndExit("全局超时 (5分钟)，进程自动退出");
  }, GLOBAL_TIMEOUT_MS);
  globalTimer.unref(); // Don't keep process alive just for this timer

  // Handle termination signals from VSCode extension
  process.on('SIGTERM', () => cleanupAndExit("收到强制终止信号 (SIGTERM)"));
  process.on('SIGINT', () => cleanupAndExit("收到强制中断信号 (SIGINT)"));

  // Read input from stdin
  const input = await new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => {
      try { resolve(JSON.parse(data.trim())); }
      catch (e) { reject(new Error(`Invalid input JSON: ${e.message}`)); }
    });
    process.stdin.on("error", reject);
    // Timeout if no input within 5s
    setTimeout(() => reject(new Error("No input received within 5s")), 5000);
  });

  if (input.adspowerUrl) adspowerUrl = input.adspowerUrl;
  adspowerApiKey = input.adspowerApiKey;
  profileId = input.profileId;
  email = input.email;
  password = input.password;
  recoveryEmail = input.recoveryEmail;
  totpSecret = input.totpSecret;

  if (!profileId) throw new Error("缺少 profileId");
  if (!email) throw new Error("缺少 email");
  if (!password) throw new Error("缺少 password");

  try {
    // Step 1 & 2: Open AdsPower profile and connect (with retry for rapid restart port collisions)
    let wsUrl = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        progress(`正在打开 AdsPower 浏览器 (profile: ${profileId}, 尝试 ${attempt}/3)...`);
        wsUrl = await adspowerOpenProfile(adspowerUrl, profileId, adspowerApiKey);
        progress(`已获取 CDP 连接: ${wsUrl.substring(0, 60)}...`);

        let connectError;
        for (let connectAttempt = 1; connectAttempt <= 5; connectAttempt++) {
          try {
            browser = await puppeteer.connect({
              browserWSEndpoint: wsUrl,
              defaultViewport: null,
              protocolTimeout: 180_000, // 3 min — prevents "Runtime.callFunctionOn timed out"
            });
            connectError = null;
            break;
          } catch (err) {
            connectError = err;
            await sleep(1000); // wait 1s for port to bind
          }
        }
        if (connectError) throw connectError;
        break; // Successfully connected
      } catch (e) {
        if (attempt < 3) {
          progress(`⚠️ 连接浏览器内核失败 (${e.message})。可能遇上了幽灵进程，正在清理并重试...`);
          try { await adspowerCloseProfile(adspowerUrl, profileId, adspowerApiKey); } catch (_) {}
          await sleep(3000); // Give AdsPower time to kill the zombie process
        } else {
          throw new Error(`浏览器启动/连接最终失败: ${e.message}`);
        }
      }
    }

    const pages = await browser.pages();
    page = pages[0] || await browser.newPage();

    // 监听所有主页面的跳转并详细记录日志
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) {
        progress(`[跳转] -> ${frame.url()}`);
      }
    });

    // Step 3: Gmail login
    const loginOk = await gmailLogin(page, { email, password, totpSecret });
    if (!loginOk) throw new Error("登录失败");
    progress("Google 登录成功");

    // Step 4: OAuth token capture
    const tokenData = await captureOAuthToken(page, { email, password, totpSecret });
    progress(`已获取 Refresh Token (${tokenData.refresh_token.substring(0, 10)}...)`);

    // Step 5: Get user info
    let userEmail = email;
    try {
      const infoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (infoRes.ok) {
        const info = await infoRes.json();
        if (info.email) userEmail = info.email;
      }
    } catch { /* use input email */ }

    // Step 6: Discover projectId via loadCodeAssist + onboardUser
    let projectId = "";
    try {
      projectId = await discoverProjectId(page, tokenData.access_token);
    } catch (e) {
      progress(`获取项目号失败 (非致命): ${e.message}`);
    }

    resultOk({
      refreshToken: tokenData.refresh_token,
      accessToken: tokenData.access_token,
      email: userEmail,
      ...(projectId ? { projectId } : {}),
    });

    // Success! Close browser automatically.
    progress(`录入完成，正在关闭浏览器...`);
    await adspowerCloseProfile(adspowerUrl, profileId, adspowerApiKey);
    
    // Disconnect browser so puppeteer websocket doesn't keep event loop alive
    if (browser) {
      try { await browser.disconnect(); } catch { /* ignore */ }
      browser = null; // prevent double-disconnect in finally
    }
    
    // Wait for stdout to flush, then force exit
    await new Promise((resolve) => {
      const done = () => resolve();
      if (process.stdout.writableLength === 0) {
        // Buffer is already empty, but give a tiny tick for the pipe to transmit
        setTimeout(done, 100);
      } else {
        process.stdout.once('drain', () => setTimeout(done, 100));
        // Safety timeout in case drain never fires
        setTimeout(done, 3000);
      }
    });
    process.exit(0);

  } catch (err) {
    if (page) {
      try {
        const timestamp = Date.now();
        const screenshotPath = path.join("C:\\Users\\Administrator\\Desktop\\GFA\\logs\\screenshots", `error-${timestamp}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        progress(`[Debug] 已保存错误截图到: ${screenshotPath}`);
        
        const htmlPath = path.join("C:\\Users\\Administrator\\Desktop\\GFA\\logs\\screenshots", `error-${timestamp}.html`);
        const htmlContent = await page.content();
        fs.writeFileSync(htmlPath, htmlContent);
        progress(`[Debug] 已保存错误DOM到: ${htmlPath}`);
      } catch (e) {
        progress(`[Debug] 保存截图失败: ${e.message}`);
      }
    }
    
    // Auto-close browser on failure to prevent memory leaks during batch runs
    progress("任务异常/终止，正在清理并关闭浏览器...");
    try { await adspowerCloseProfile(adspowerUrl, profileId, adspowerApiKey); } catch (e) {}
    
    resultFail(err.message || String(err));
  } finally {
    if (browser) {
      try { await browser.disconnect(); } catch { /* ignore */ }
    }
  }
}

main().catch((err) => {
  resultFail(err.message || String(err));
  process.exit(1);
});
