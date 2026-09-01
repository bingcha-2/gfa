// Codex（OpenAI）自动上号浏览器驱动。
//
// 给定 codex OAuth 授权 URL + 账号凭据 + 接码手机号/网址 + 出口代理，用无头浏览器
// （经本地 SOCKS5 中继走用户代理）自动完成 auth.openai.com 的登录全流程：
//   邮箱 → 密码 → TOTP → 加手机号 → 短信接码 → codex 授权同意 → 截获授权 code。
//
// 各步页面/选择器均来自本仓库实跑验证（见 scripts/test_codex_login.ts）。
// 接码格式与解析见 extractSmsCode。返回授权 code 交由 codex.service 换 token 落库。

import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { startLocalSocksRelay, parseUpstream, generateGoogleTOTP } from "./playwright-oauth";
import { toSocks5ProxyUrl } from "./store";
import { fetchOpenAIVerificationCodeViaWeb } from "./mailcom-web-magic-link";

export interface CodexBrowserLoginOpts {
  /** codex OAuth 授权 URL（含 PKCE challenge，与后续换 token 的 codeVerifier 同源） */
  authorizeUrl: string;
  /** 该授权会话的 redirect_uri，用于截获回调 code */
  redirectUri: string;
  email: string;
  password: string;
  totpSecret?: string | null;
  /** 美国手机号（仅数字，无国家码），如 3527217858；仅在账号触发加手机时需要 */
  phoneNumber?: string;
  /** 接码网址 */
  smsUrl?: string;
  /** 出口代理（任意受支持格式，内部归一化为 socks5://） */
  proxyUrl?: string;
  /** Stable Edge user-data directory. When supplied, Edge is launched natively
   * and Playwright attaches over CDP so OpenAI does not see webdriver=true. */
  browserProfileDir?: string;
  /** After a successful OpenAI login, open chatgpt.com/api/auth/session in the
   * same Edge context and return its authenticated JSON payload. */
  captureChatGptSession?: boolean;
  /** Log in through chatgpt.com and return a session without requiring a
   * Codex OAuth authorization code. */
  sessionOnly?: boolean;
  /** 进度回调，上报当前步骤名 */
  onStep?: (step: string) => void;
  maxSteps?: number;
  smsTimeoutMs?: number;
}

export interface CodexBrowserLoginResult {
  ok: boolean;
  code?: string;
  session?: string;
  error?: string;
  /** 失败时停留的步骤/URL，便于定位 */
  step?: string;
  lastUrl?: string;
}

const DEFAULT_MAX_STEPS = 16;
const DEFAULT_SMS_TIMEOUT_MS = 90_000;
const SMS_POLL_INTERVAL_MS = 3_000;
const SECURITY_VERIFICATION_TIMEOUT_MS = 120_000;
const SECURITY_VERIFICATION_POLL_MS = 1_000;
const LOGIN_SURFACE_SETTLE_MS = 2_000;
const HUMAN_INPUT_DELAY_MS = 80;
const POST_INPUT_SETTLE_MS = 350;
const CHATGPT_SESSION_URL = "https://chatgpt.com/api/auth/session";

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function resolveEdgeExecutable(): string {
  const candidates = [
    path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error("服务器未安装 Microsoft Edge，无法启动 Codex 登录");
  return executable;
}

async function connectToNativeEdge(
  profileDir: string,
  relay: { port: number } | null,
): Promise<{ browser: Browser; context: BrowserContext; process: ChildProcess }> {
  fs.mkdirSync(profileDir, { recursive: true });
  const port = await reserveLoopbackPort();
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
  if (relay) args.unshift(`--proxy-server=socks5://127.0.0.1:${relay.port}`);
  const edgeProcess = spawn(resolveEdgeExecutable(), args, {
    stdio: "ignore",
    windowsHide: false,
  });

  let browser: Browser | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (edgeProcess.exitCode != null) break;
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!browser) {
    edgeProcess.kill();
    throw new Error(`无法连接服务器 Edge 调试端口: ${lastError instanceof Error ? lastError.message : "启动失败"}`);
  }
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => {});
    edgeProcess.kill();
    throw new Error("服务器 Edge 未提供可用浏览器上下文");
  }
  return { browser, context, process: edgeProcess };
}

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

export function extractOpenAIEmailCode(raw: string): string | null {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  if (!text) return null;

  const preferred = text.match(
    /(?:openai|chatgpt|verification|security|one-time|code)[^\d]{0,120}(\d{6})(?!\d)/i,
  );
  if (preferred) return preferred[1];

  const windowed = text.match(/(?:openai|chatgpt).{0,300}/i)?.[0] || text;
  const any = windowed.match(/(?<!\d)(\d{6})(?!\d)/);
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
      await page.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => {});
      await sleep(LOGIN_SURFACE_SETTLE_MS);
      await el.click().catch(() => {});
      await el.fill("").catch(() => {});
      let typed = false;
      if (value) {
        await el.pressSequentially(value, { delay: HUMAN_INPUT_DELAY_MS }).then(
          () => { typed = true; },
          () => {},
        );
      }
      if (!typed) await el.fill(value).catch(() => {});
      await sleep(POST_INPUT_SETTLE_MS);
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

async function bodyText(page: Page): Promise<string> {
  return page.locator("body").innerText({ timeout: 1500 }).catch(() => "");
}

async function pageTitle(page: Page): Promise<string> {
  const maybeTitle = (page as any)?.title;
  if (typeof maybeTitle !== "function") return "";
  return maybeTitle.call(page).catch(() => "");
}

function looksLikeStaleChatGptAuthTab(url: string): boolean {
  return /chatgpt\.com\/(?:auth|api\/auth)\//i.test(url);
}

async function openInitialOpenAiAuthPage(context: BrowserContext): Promise<Page> {
  let closedStaleTab = false;
  for (const page of context.pages()) {
    if (looksLikeStaleChatGptAuthTab(page.url())) {
      await page.close().catch(() => {});
      closedStaleTab = true;
    }
  }
  if (closedStaleTab) return context.newPage();
  return context.pages()[0] || (await context.newPage());
}

function matchesInput(inputs: Array<Record<string, string | null>>, re: RegExp): boolean {
  return inputs.some((input) => re.test(JSON.stringify(input)));
}

function looksLikeOpenAiSecurityVerification(url: string, title: string, text: string): boolean {
  if (!/auth\.openai\.com/i.test(url)) return false;
  return /performing security verification|protect against malicious bots|verification successful|enable javascript and cookies|just a moment/i.test(`${title} ${text}`);
}

function looksLikeOpenAiLoginSurface(inputs: Array<Record<string, string | null>>, text: string): boolean {
  return (
    matchesInput(inputs, /email|username|password/i) ||
    /welcome back|email address|continue with google|continue with microsoft|continue with apple|continue with phone/i.test(text)
  );
}

async function waitForOpenAiSecurityVerification(
  page: Page,
  onStep: (step: string) => void,
): Promise<CodexBrowserLoginResult | null> {
  const deadline = Date.now() + SECURITY_VERIFICATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await page.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => {});
    const url = page.url();
    const title = await pageTitle(page);
    const text = await bodyText(page);
    const inputs = await readInputs(page);
    if (!looksLikeOpenAiSecurityVerification(url, title, text) || looksLikeOpenAiLoginSurface(inputs, text)) {
      return null;
    }
    onStep("security_verification");
    await sleep(SECURITY_VERIFICATION_POLL_MS);
  }
  return {
    ok: false,
    error: `OpenAI 安全校验页在 ${Math.round(SECURITY_VERIFICATION_TIMEOUT_MS / 1000)} 秒内未放行`,
    step: "security_verification",
    lastUrl: page.url(),
  };
}

async function clickFirst(page: Page, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const loc = page.locator(selector);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      if (await el.isVisible().catch(() => false)) {
        try {
          await el.click({ timeout: 3500 });
          return true;
        } catch {
          const clicked = await el.evaluate((node: HTMLElement) => {
            const disabled = (node as HTMLButtonElement).disabled || node.getAttribute("aria-disabled") === "true";
            if (disabled) return false;
            node.click();
            return true;
          }).catch(() => false);
          if (clicked) return true;
        }
      }
    }
  }
  return false;
}

async function fillVerificationCode(page: Page, code: string): Promise<boolean> {
  const loc = page.locator(
    'input[inputmode="numeric"], input[autocomplete="one-time-code"], input[name*="code" i], input[id*="code" i], input[type="tel"], input[type="text"]',
  );
  const visible: Locator[] = [];
  const n = await loc.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const input = loc.nth(i);
    if (await input.isVisible().catch(() => false)) visible.push(input);
  }
  if (visible.length >= code.length) {
    for (let i = 0; i < code.length; i++) {
      await visible[i].click().catch(() => {});
      await visible[i].fill(code[i]).catch(() => {});
    }
    return true;
  }
  if (visible.length) {
    await visible[0].click().catch(() => {});
    await visible[0].fill("").catch(() => {});
    await visible[0].pressSequentially(code, { delay: 70 }).catch(() => {});
    return true;
  }
  return false;
}

type OutlookLoginResult = { ok: boolean; code?: string };

const OUTLOOK_INBOX_URL = "https://outlook.live.com/mail/0/inbox";

function normalizeOutlookLoginResult(result: OutlookLoginResult | boolean): OutlookLoginResult {
  return typeof result === "boolean" ? { ok: result } : result;
}

async function outlookLoginIfNeeded(page: Page, email: string, password: string): Promise<OutlookLoginResult | boolean> {
  const promptAttempts = new Map<string, number>();
  const mayRetryPrompt = (prompt: string) => {
    const attempts = (promptAttempts.get(prompt) || 0) + 1;
    promptAttempts.set(prompt, attempts);
    return attempts <= 3;
  };
  let directInboxAttempted = false;

  for (let i = 0; i < 12; i++) {
    await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
    await sleep(1200);
    const url = page.url();
    const text = await bodyText(page);
    const isRecoveryEnrollmentUrl = /account\.live\.com\/proofs\/Add/i.test(url);
    if (/outlook\.live\.com\/mail/i.test(url) && /Inbox|Focused|Other|收件箱|重点|其他/i.test(text)) {
      return { ok: true, code: extractOpenAIEmailCode(text) || undefined };
    }
    if (/outlook\.live\.com\/mail/i.test(url) && /Inbox|Focused|Other|收件箱|重点|其他/i.test(text)) return true;

    if (await fillFirst(page, 'input[type="email"], input[name="loginfmt"], input[autocomplete="username"]', email)) {
      await clickFirst(page, ['input[type="submit"]', 'button:has-text("Next")']);
      continue;
    }
    if (await fillFirst(page, 'input[type="password"], input[name="passwd"]', password)) {
      await clickFirst(page, ['input[type="submit"]', 'button:has-text("Next")', 'button:has-text("Sign in")']);
      continue;
    }
    if (/Stay signed in|保持登录状态|是否保持登录/i.test(text)) {
      if (!mayRetryPrompt("stay-signed-in")) return false;
      const accepted = await clickFirst(page, [
        'button:has-text("Yes")',
        'input[value="Yes"]',
        'button:text-is("是")',
        'input[value="是"]',
      ]);
      if (!accepted) return false;
      continue;
    }
    if (/A quick note about your Microsoft account|Your privacy is our priority|关于你的 Microsoft (?:帐户|账户)的简短说明|你的隐私是我们的首要任务/i.test(text)) {
      if (!mayRetryPrompt("privacy-notice")) return false;
      const clicked = await clickFirst(page, [
        'button:has-text("OK")',
        'input[value="OK"]',
        '[role="button"]:has-text("OK")',
        'button:text-is("确定")',
        'input[value="确定"]',
        'button:text-is("好的")',
      ]);
      if (!clicked) return false;
      continue;
    }
    if (
      /Verify your identity|Enter (?:the )?(?:security )?code|验证你的身份|输入(?:安全)?代码/i.test(text)
      || (!isRecoveryEnrollmentUrl && /security code|安全代码/i.test(text))
    ) {
      return false;
    }
    if (/setting up (?:a )?passkey|set up (?:a )?passkey|create (?:a )?passkey|正在设置密钥|设置密钥/i.test(text)) {
      if (!mayRetryPrompt("passkey-setup")) return false;
      const cancelled = await clickFirst(page, [
        'button:has-text("Cancel")',
        'input[value="Cancel"]',
        '[role="button"]:has-text("Cancel")',
        'button:has-text("Not now")',
        'button:has-text("No thanks")',
        'button:has-text("取消")',
        'input[value="取消"]',
        '[role="button"]:has-text("取消")',
        'button:has-text("暂不")',
      ]);
      if (!cancelled) return false;
      continue;
    }
    if (/Help us protect your account|You have a pending security action|Add a recovery email address|让我们来保护你的(?:帐户|账户)|添加备用邮箱|待处理的安全操作/i.test(text)) {
      if (!mayRetryPrompt("recovery-enrollment")) return false;
      const dismissed = await clickFirst(page, [
        'button:has-text("Skip for now")',
        'input[value="Skip for now"]',
        '[role="button"]:has-text("Skip for now")',
        'button:has-text("Not now")',
        'button:has-text("Maybe later")',
        'button:has-text("暂时跳过")',
        'button:has-text("以后再说")',
        'button[aria-label="Close"]',
        'button[title="Close"]',
        'button:has-text("Close")',
      ]);
      if (!dismissed) {
        if (!isRecoveryEnrollmentUrl) return false;
        if (directInboxAttempted) return false;
        directInboxAttempted = true;
        // Fresh Outlook accounts sometimes make the recovery-email prompt
        // non-dismissible. The mailbox remains accessible by navigating to it
        // directly, which is also the documented manual recovery path.
        await page.goto(OUTLOOK_INBOX_URL, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
      }
      continue;
    }
    if (/account\.microsoft\.com/i.test(url) && /Open Outlook\.com|Outlook/i.test(text)) {
      await page.goto(OUTLOOK_INBOX_URL, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
      continue;
    }
    if (await clickFirst(page, [
      'a:has-text("Sign in")',
      'button:has-text("Sign in")',
      'input[value="Sign in"]',
      'a:has-text("登录")',
      'button:has-text("登录")',
    ])) {
      continue;
    }
    if (/outlook\.live\.com\/mail/i.test(url) && i >= 2) return true;
  }
  return false;
}

async function openOpenAiMailAndExtractCode(page: Page): Promise<string | null> {
  for (let attempt = 1; attempt <= 18; attempt++) {
    await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
    await sleep(2500);
    const text = await bodyText(page);
    const code = extractOpenAIEmailCode(text);
    if (code && /OpenAI|ChatGPT|verification|security code/i.test(text)) return code;

    const clicked = await clickFirst(page, [
      'div[role="option"]:has-text("OpenAI")',
      'div[role="row"]:has-text("OpenAI")',
      'div[aria-label*="OpenAI" i]',
      'div[role="option"]:has-text("ChatGPT")',
      'div[role="row"]:has-text("ChatGPT")',
      'div[aria-label*="ChatGPT" i]',
      'div[role="option"]:has-text("verification code")',
      'div[role="row"]:has-text("verification code")',
    ]);
    if (clicked) {
      await sleep(2500);
      const openedCode = extractOpenAIEmailCode(await bodyText(page));
      if (openedCode) return openedCode;
    }
    await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
  }
  return null;
}

async function fetchOutlookOpenAICode(context: BrowserContext, email: string, password: string): Promise<string | null> {
  const page = await context.newPage();
  try {
    await page.goto(`https://login.live.com/login.srf?login_hint=${encodeURIComponent(email)}`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    }).catch(() => {});
    const firstLogin = normalizeOutlookLoginResult(await outlookLoginIfNeeded(page, email, password));
    if (firstLogin.code) return firstLogin.code;
    if (!firstLogin.ok) return null;
    await page.goto(OUTLOOK_INBOX_URL, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
    const loggedIn = normalizeOutlookLoginResult(await outlookLoginIfNeeded(page, email, password));
    if (!loggedIn.ok) return null;
    if (loggedIn.code) return loggedIn.code;
    return openOpenAiMailAndExtractCode(page);
  } finally {
    await page.close().catch(() => {});
  }
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

async function fetchOpenAIEmailCode(
  context: BrowserContext,
  opts: CodexBrowserLoginOpts,
  sinceMs: number,
): Promise<string | null> {
  const domain = opts.email.split("@")[1]?.toLowerCase() || "";
  if (["outlook.com", "hotmail.com", "live.com", "msn.com"].includes(domain)) {
    return fetchOutlookOpenAICode(context, opts.email, opts.password);
  }
  const result = await fetchOpenAIVerificationCodeViaWeb({
    email: opts.email,
    password: opts.password,
    proxyUrl: opts.proxyUrl,
    sinceMs,
    waitMs: 90_000,
  });
  return result.ok ? result.code || null : null;
}

async function readChatGptSession(context: BrowserContext): Promise<string | null> {
  const page = await context.newPage();
  try {
    await page.goto(CHATGPT_SESSION_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const raw = (await bodyText(page)).trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed.user || parsed.accessToken ? raw : null;
  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

async function resultAfterLogin(
  context: BrowserContext,
  opts: CodexBrowserLoginOpts,
  code: string,
  onStep: (step: string) => void,
): Promise<CodexBrowserLoginResult> {
  if (!opts.captureChatGptSession) return { ok: true, code };
  onStep("reading_chatgpt_session");
  for (let attempt = 0; attempt < 5; attempt++) {
    const session = await readChatGptSession(context);
    if (session) return { ok: true, code, session };
    await sleep(1_000);
  }
  return { ok: false, error: "登录完成，但未能从 ChatGPT 读取有效 session", step: "reading_chatgpt_session" };
}

export async function runCodexBrowserLogin(opts: CodexBrowserLoginOpts): Promise<CodexBrowserLoginResult> {
  const onStep = opts.onStep ?? (() => {});
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const smsTimeoutMs = opts.smsTimeoutMs ?? DEFAULT_SMS_TIMEOUT_MS;

  let relay: { port: number; close: () => void } | null = null;
  let browser: Browser | null = null;
  let nativeEdgeProcess: ChildProcess | null = null;

  try {
    const normalizedProxy = toSocks5ProxyUrl(opts.proxyUrl);
    if (opts.proxyUrl?.trim() && !normalizedProxy) {
      return { ok: false, error: "代理格式无法识别" };
    }
    if (normalizedProxy) {
      const upstream = parseUpstream(normalizedProxy);
      relay = await startLocalSocksRelay(upstream);
    }

    // Production flows supply a stable profile directory. Launch msedge.exe
    // itself and attach over CDP, avoiding Playwright's webdriver launch flag.
    // Tests and direct library callers without a profile keep the isolated
    // Playwright Edge context for deterministic behavior.
    let context: BrowserContext;
    if (opts.browserProfileDir) {
      const nativeEdge = await connectToNativeEdge(opts.browserProfileDir, relay);
      browser = nativeEdge.browser;
      context = nativeEdge.context;
      nativeEdgeProcess = nativeEdge.process;
    } else {
      browser = await chromium.launch({
        channel: "msedge",
        headless: false,
        ...(relay ? { proxy: { server: `socks5://127.0.0.1:${relay.port}` } } : {}),
        args: ["--no-sandbox"],
      });
      context = await browser.newContext();
    }

    // 截获回调 code（redirect_uri 不会真正可达，靠导航/请求 URL 抓取）
    let authCode: string | null = null;
    const grab = (u: string) => {
      if (opts.redirectUri && u.startsWith(opts.redirectUri)) {
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

    const page = await openInitialOpenAiAuthPage(context);
    onStep("opening_authorize_url");
    await page.goto(opts.authorizeUrl, { waitUntil: "domcontentloaded", timeout: 40_000 }).catch(() => {});
    const securityGate = await waitForOpenAiSecurityVerification(page, onStep);
    if (securityGate) return securityGate;

    let emailDone = false;
    let emailSubmittedAt = Date.now();
    let pwdDone = false;
    let emailCodeDone = false;
    let totpDone = false;
    let phoneEntered = false;

    for (let step = 0; step < maxSteps; step++) {
      await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
      await sleep(1200);

      if (authCode || (opts.redirectUri && page.url().startsWith(opts.redirectUri))) {
        if (!authCode) {
          try {
            authCode = new URL(page.url()).searchParams.get("code");
          } catch {
            /* ignore */
          }
        }
        if (authCode) {
          onStep("got_code");
          return resultAfterLogin(context, opts, authCode, onStep);
        }
      }

      const url = page.url();
      const inputs = await readInputs(page);
      const pageText = await bodyText(page);
      const has = (re: RegExp) => matchesInput(inputs, re);
      if (opts.sessionOnly && (
        (emailCodeDone || pwdDone) ||
        (/chatgpt\.com/i.test(url) && !/\/auth\/login/i.test(url))
      )) {
        onStep("reading_chatgpt_session");
        const session = await readChatGptSession(context);
        if (session) return { ok: true, session };
      }
      if (looksLikeOpenAiSecurityVerification(url, await pageTitle(page), pageText)) {
        const securityRetry = await waitForOpenAiSecurityVerification(page, onStep);
        if (securityRetry) return securityRetry;
        continue;
      }

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
          emailSubmittedAt = Date.now();
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

      const looksLikeEmailCode =
        (/\/email-verification/i.test(url) ||
          /check your email|sent.*email|enter.*code|verification code|verify your email|security code/i.test(pageText)) &&
        has(/code|one-time|numeric/i) &&
        !/phone|sms|text message/i.test(pageText);
      if (!emailCodeDone && looksLikeEmailCode) {
        onStep("email_code_polling");
        const code = await fetchOpenAIEmailCode(context, opts, emailSubmittedAt - 30_000);
        if (!code) {
          return { ok: false, error: "未能自动获取 OpenAI 邮箱验证码，请检查邮箱密码或稍后重试", step: "email_code_polling", lastUrl: url };
        }
        onStep("email_code_fill");
        await fillVerificationCode(page, code);
        await clickContinue(page);
        emailCodeDone = true;
        continue;
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
        if (!opts.phoneNumber) {
          const skipped = await clickFirst(page, [
            'button:has-text("Skip")',
            'button:has-text("Not now")',
            'button:has-text("Maybe later")',
            'a:has-text("Skip")',
            'button:has-text("跳过")',
            'button:has-text("暂不")',
            'button:has-text("以后再说")',
          ]);
          if (skipped) {
            onStep("skip_phone");
            await sleep(1_500);
            continue;
          }
          return { ok: false, error: "账号要求绑定手机号，请补充接码手机号后重试", step: "add_phone", lastUrl: url };
        }
        await fillFirst(page, '#tel, input[type="tel"][autocomplete="tel"], input[type="tel"]', opts.phoneNumber);
        await clickContinue(page);
        phoneEntered = true;
        continue;
      }

      // 接码：/phone-verification
      if (/\/phone-verification/i.test(url) && has(/code|one-time/i)) {
        onStep("sms_polling");
        if (!opts.smsUrl) {
          return { ok: false, error: "账号进入短信验证页，请补充接码网址后重试", step: "sms_polling", lastUrl: url };
        }
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

    if (authCode) return resultAfterLogin(context, opts, authCode, onStep);
    if (opts.sessionOnly) {
      const session = await readChatGptSession(context);
      if (session) return { ok: true, session };
      return { ok: false, error: "ChatGPT 登录完成前流程已耗尽，未能读取 session", step: "reading_chatgpt_session", lastUrl: page.url() };
    }
    return { ok: false, error: "登录未完成（步骤耗尽）", step: "exhausted", lastUrl: page.url() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (nativeEdgeProcess && nativeEdgeProcess.exitCode == null) nativeEdgeProcess.kill();
    if (relay) relay.close();
  }
}
