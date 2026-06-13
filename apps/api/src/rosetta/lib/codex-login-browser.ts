// Codex（OpenAI）自动上号浏览器驱动。
//
// 给定 codex OAuth 授权 URL + 账号凭据 + 接码手机号/网址 + 出口代理，用无头浏览器
// （经本地 SOCKS5 中继走用户代理）自动完成 auth.openai.com 的登录全流程：
//   邮箱 → 密码 → TOTP → 加手机号 → 短信接码 → codex 授权同意 → 截获授权 code。
//
// 各步页面/选择器均来自本仓库实跑验证（见 scripts/test_codex_login.ts）。
// 接码格式与解析见 extractSmsCode。返回授权 code 交由 codex.service 换 token 落库。

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { startLocalSocksRelay, parseUpstream, generateGoogleTOTP } from "./playwright-oauth";
import { toSocks5ProxyUrl } from "./store";

export interface CodexBrowserLoginOpts {
  /** codex OAuth 授权 URL（含 PKCE challenge，与后续换 token 的 codeVerifier 同源） */
  authorizeUrl: string;
  /** 该授权会话的 redirect_uri，用于截获回调 code */
  redirectUri: string;
  email: string;
  password: string;
  totpSecret?: string | null;
  /** 美国手机号（仅数字，无国家码），如 3527217858 */
  phoneNumber: string;
  /** 接码网址 */
  smsUrl: string;
  /** 出口代理（任意受支持格式，内部归一化为 socks5://） */
  proxyUrl: string;
  /** 默认 false：与 Anthropic 流程一致（服务器侧需有显示/xvfb），降低被检测概率 */
  headless?: boolean;
  /** 进度回调，上报当前步骤名 */
  onStep?: (step: string) => void;
  maxSteps?: number;
  smsTimeoutMs?: number;
}

export interface CodexBrowserLoginResult {
  ok: boolean;
  code?: string;
  error?: string;
  /** 失败时停留的步骤/URL，便于定位 */
  step?: string;
  lastUrl?: string;
}

const DEFAULT_MAX_STEPS = 16;
const DEFAULT_SMS_TIMEOUT_MS = 90_000;
const SMS_POLL_INTERVAL_MS = 3_000;

/**
 * 解析接码接口返回里的验证码。yuntl.cc 纯文本：
 *   无码： "暂无短信|链接到期时间YYYY-MM-DD HH:MM:SS，续费请提前联系客服"
 *   有码： "YES|Your OpenAI verification code is: 461668"（验证码在 '|' 之后）
 * 兼容其它接码商的 JSON（code/message/sms/content 字段）。
 */
export function extractSmsCode(raw: string): string | null {
  const text = (raw || "").trim();
  if (!text) return null;
  if (/暂无短信|no\s*sms|not?\s*received/i.test(text)) return null;

  let searchSpace = text;
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const status = String(data.status ?? "").toLowerCase();
    if (status === "fail" || status === "error") return null;
    searchSpace =
      String(data.code ?? "") ||
      String(data.message ?? "") ||
      String(data.sms ?? "") ||
      String(data.content ?? "") ||
      text;
  } catch {
    // 非 JSON（yuntl 即纯文本）
  }
  searchSpace = searchSpace.split("链接到期")[0];
  const six = searchSpace.match(/(?<!\d)(\d{6})(?!\d)/);
  if (six) return six[1];
  const any = searchSpace.match(/(?<!\d)(\d{4,8})(?!\d)/);
  return any ? any[1] : null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 读取当前页可见 input 的属性数组（避免在 evaluate 内定义具名函数） */
async function readInputs(page: Page): Promise<Array<Record<string, string | null>>> {
  return page
    .evaluate(() =>
      Array.from(document.querySelectorAll("input,textarea"))
        .filter((el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
        })
        .map((el) => ({
          type: el.getAttribute("type"),
          name: el.getAttribute("name"),
          id: (el as HTMLElement).id || null,
          autocomplete: el.getAttribute("autocomplete"),
        }))
    )
    .catch(() => []);
}

/** 填入首个可见匹配输入框 */
async function fillFirst(page: Page, selector: string, value: string): Promise<boolean> {
  const loc = page.locator(selector);
  const n = await loc.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = loc.nth(i);
    if (await el.isVisible().catch(() => false)) {
      await el.click().catch(() => {});
      await el.fill("").catch(() => {});
      await el.fill(value).catch(() => {});
      return true;
    }
  }
  return false;
}

/** 顺序按键填入（OTP/验证码框需要逐位触发前端监听） */
async function typeCode(page: Page, selector: string, code: string): Promise<boolean> {
  const loc = page.locator(selector);
  const n = await loc.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = loc.nth(i);
    if (await el.isVisible().catch(() => false)) {
      await el.click().catch(() => {});
      await el.fill("").catch(() => {});
      await el.pressSequentially(code, { delay: 80 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function clickContinue(page: Page): Promise<void> {
  const btn = page.locator(
    'button[type="submit"]:has-text("Continue"), button:has-text("Continue"), ' +
      'button:has-text("Verify"), button:has-text("Next"), button[type="submit"]'
  );
  const n = await btn.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const b = btn.nth(i);
    if (await b.isVisible().catch(() => false)) {
      await b.click({ timeout: 4000 }).catch(() => b.evaluate((e: HTMLElement) => e.click()).catch(() => {}));
      return;
    }
  }
  await page.keyboard.press("Enter").catch(() => {});
}

/** 新开标签 goto(smsUrl) 读 body —— 走浏览器代理出口、绕过 CORS */
async function fetchSmsRaw(context: BrowserContext, smsUrl: string): Promise<string> {
  const page = await context.newPage();
  try {
    await page.goto(smsUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    return await page.evaluate(() => document.body?.innerText ?? "");
  } finally {
    await page.close().catch(() => {});
  }
}

async function pollSms(context: BrowserContext, smsUrl: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    let raw = "";
    try {
      raw = await fetchSmsRaw(context, smsUrl);
    } catch {
      /* 重试 */
    }
    if (raw && raw !== last) {
      last = raw;
      const code = extractSmsCode(raw);
      if (code) return code;
    }
    await sleep(SMS_POLL_INTERVAL_MS);
  }
  return null;
}

const STEALTH_INIT = () => {
  Object.defineProperty(navigator, "webdriver", { get: () => false });
  (window as any).chrome = { runtime: {}, loadTimes: function () {}, csi: function () {}, app: {} };
  const pdfViewer = { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" };
  Object.defineProperty(navigator, "plugins", { get: () => [pdfViewer] });
};

export async function runCodexBrowserLogin(opts: CodexBrowserLoginOpts): Promise<CodexBrowserLoginResult> {
  const onStep = opts.onStep ?? (() => {});
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const smsTimeoutMs = opts.smsTimeoutMs ?? DEFAULT_SMS_TIMEOUT_MS;

  const normalizedProxy = toSocks5ProxyUrl(opts.proxyUrl);
  if (!normalizedProxy) return { ok: false, error: "代理为空或格式无法识别" };

  let relay: { port: number; close: () => void } | null = null;
  let browser: Browser | null = null;

  try {
    const upstream = parseUpstream(normalizedProxy);
    relay = await startLocalSocksRelay(upstream);

    browser = await chromium.launch({
      headless: opts.headless ?? false,
      proxy: { server: `socks5://127.0.0.1:${relay.port}` },
      ignoreDefaultArgs: ["--enable-automation"],
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    });
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
      timezoneId: "America/New_York",
    });
    await context.addInitScript(STEALTH_INIT);

    // 截获回调 code（redirect_uri 不会真正可达，靠导航/请求 URL 抓取）
    let authCode: string | null = null;
    const grab = (u: string) => {
      if (u.startsWith(opts.redirectUri)) {
        try {
          const c = new URL(u).searchParams.get("code");
          if (c) authCode = c;
        } catch {
          /* ignore */
        }
      }
    };
    context.on("request", (req) => grab(req.url()));
    context.on("framenavigated", (f) => grab(f.url()));

    const page = await context.newPage();
    onStep("opening_authorize_url");
    await page.goto(opts.authorizeUrl, { waitUntil: "domcontentloaded", timeout: 40_000 }).catch(() => {});

    let emailDone = false;
    let pwdDone = false;
    let totpDone = false;
    let phoneEntered = false;

    for (let step = 0; step < maxSteps; step++) {
      await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
      await sleep(1200);

      if (authCode || page.url().startsWith(opts.redirectUri)) {
        if (!authCode) {
          try {
            authCode = new URL(page.url()).searchParams.get("code");
          } catch {
            /* ignore */
          }
        }
        if (authCode) {
          onStep("got_code");
          return { ok: true, code: authCode };
        }
      }

      const url = page.url();
      const inputs = await readInputs(page);
      const has = (re: RegExp) => inputs.some((i) => re.test(JSON.stringify(i)));

      // 账号选择页（profile 残留旧会话；通常不出现）
      if (/choose-an-account/i.test(url)) {
        onStep("choose_account");
        const alt = page
          .locator('button:has-text("Log in to another account"), a:has-text("Log in to another account"), [role="button"]:has-text("Log in to another account")')
          .first();
        await alt.click({ timeout: 4000 }).catch(() => alt.evaluate((e: HTMLElement) => e.click()).catch(() => {}));
        await sleep(1500);
        continue;
      }

      // 邮箱
      if (!emailDone && has(/email|username/i) && !has(/password/i)) {
        onStep("email");
        if (await fillFirst(page, 'input[type="email"], input[name="email"], input[autocomplete="username"], input[id*="email" i]', opts.email)) {
          await clickContinue(page);
          emailDone = true;
          continue;
        }
      }

      // 密码
      if (!pwdDone && has(/password/i)) {
        onStep("password");
        if (await fillFirst(page, 'input[type="password"], input[name="password"], input[id*="password" i]', opts.password)) {
          await clickContinue(page);
          pwdDone = true;
          continue;
        }
      }

      // TOTP：/mfa-challenge
      if (!totpDone && opts.totpSecret && /\/mfa-challenge/i.test(url)) {
        onStep("totp");
        const code = generateGoogleTOTP(opts.totpSecret);
        await typeCode(page, 'input[name="code"], input[autocomplete="one-time-code"], input[inputmode="numeric"]', code);
        await clickContinue(page);
        totpDone = true;
        continue;
      }

      // 加手机号：/add-phone（国家码默认 US +1）
      if (!phoneEntered && /\/add-phone/i.test(url)) {
        onStep("add_phone");
        await fillFirst(page, '#tel, input[type="tel"][autocomplete="tel"], input[type="tel"]', opts.phoneNumber);
        await clickContinue(page);
        phoneEntered = true;
        continue;
      }

      // 接码：/phone-verification
      if (/\/phone-verification/i.test(url) && has(/code|one-time/i)) {
        onStep("sms_polling");
        const code = await pollSms(context, opts.smsUrl, smsTimeoutMs);
        if (!code) {
          return { ok: false, error: "未收到短信验证码（可在页面重发后重试）", step: "sms_polling", lastUrl: url };
        }
        onStep("sms_fill");
        await typeCode(page, 'input[name="code"], input[autocomplete="one-time-code"], input[inputmode="numeric"]', code);
        await clickContinue(page);
        continue;
      }

      // codex 授权同意页
      if (/\/consent|sign-in-with-chatgpt/i.test(url)) {
        onStep("consent");
        await clickContinue(page);
        continue;
      }

      onStep(`waiting(${url})`);
    }

    if (authCode) return { ok: true, code: authCode };
    return { ok: false, error: "登录未完成（步骤耗尽）", step: "exhausted", lastUrl: page.url() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (relay) relay.close();
  }
}
