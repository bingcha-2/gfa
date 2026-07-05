import { chromium, type Browser, type Page } from "playwright";

import { makeDefaultAdsPowerClient } from "./adspower-profile-manager";
import { fetchAnthropicMagicLinkViaWeb } from "./mailcom-web-magic-link";

export type ClaudeVerificationCodeInput = {
  email: string;
  password: string;
  adspowerProfileId?: string;
  proxyUrl?: string;
  sinceMs?: number;
  waitMs?: number;
  closeCodeTab?: boolean;
};

export type ClaudeVerificationCodeResult = {
  ok: boolean;
  code?: string;
  source?: "mail-password";
  subject?: string;
  date?: string;
  adspowerProfileId?: string;
  startedProfile?: boolean;
  error?: string;
};

export type OpenMagicLinkInBrowserInput = {
  adspowerProfileId: string;
  email: string;
  magicLinkUrl: string;
  timeoutMs: number;
  closeCodeTab: boolean;
};

export type OpenMagicLinkInBrowserResult = {
  ok: boolean;
  code?: string;
  startedProfile?: boolean;
  error?: string;
};

type ClaudeVerificationCodeDeps = {
  fetchMagicLink?: typeof fetchAnthropicMagicLinkViaWeb;
  openMagicLinkInBrowser?: (opts: OpenMagicLinkInBrowserInput) => Promise<OpenMagicLinkInBrowserResult>;
};

const DEFAULT_ADSPOWER_PROFILE_ID = "k1e8c364";
const DEFAULT_WAIT_MS = 120_000;
const DEFAULT_CODE_PAGE_TIMEOUT_MS = 45_000;

export function extractClaudeVerificationCode(text: string): string {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  const preferred =
    normalized.match(/verification code.{0,160}?(\d{6})(?!\d)/i)
    || normalized.match(/(\d{6})(?!\d).{0,160}?copy code/i);
  if (preferred) return preferred[1];

  const candidates = [...normalized.matchAll(/(?<!\d)(\d{6})(?!\d)/g)].map((match) => match[1]);
  return candidates.length === 1 ? candidates[0] : "";
}

export async function fetchClaudeVerificationCode(
  input: ClaudeVerificationCodeInput,
  deps: ClaudeVerificationCodeDeps = {},
): Promise<ClaudeVerificationCodeResult> {
  const email = String(input.email || "").trim().toLowerCase();
  const password = String(input.password || "").trim();
  const adspowerProfileId = String(input.adspowerProfileId || DEFAULT_ADSPOWER_PROFILE_ID).trim();
  const waitMs = Math.max(1_000, Number(input.waitMs || DEFAULT_WAIT_MS));
  const sinceMs = Number(input.sinceMs || Date.now() - 30 * 60_000);
  const closeCodeTab = input.closeCodeTab !== false;

  if (!email) return { ok: false, error: "email 必填" };
  if (!password) return { ok: false, error: "password 必填" };
  if (!adspowerProfileId) return { ok: false, error: "AdsPower 浏览器 ID 必填" };

  const fetchMagicLink = deps.fetchMagicLink || fetchAnthropicMagicLinkViaWeb;
  const openMagicLinkInBrowser = deps.openMagicLinkInBrowser || openClaudeMagicLinkForVerificationCode;

  const mail = await fetchMagicLink({
    email,
    password,
    sinceMs,
    waitMs,
    proxyUrl: input.proxyUrl,
  });
  if (!mail.ok || !mail.url) {
    return {
      ok: false,
      error: mail.error || "未获取到 Claude 登录邮件",
      adspowerProfileId,
    };
  }

  const codePage = await openMagicLinkInBrowser({
    adspowerProfileId,
    email,
    magicLinkUrl: mail.url,
    timeoutMs: DEFAULT_CODE_PAGE_TIMEOUT_MS,
    closeCodeTab,
  });
  if (!codePage.ok || !codePage.code) {
    return {
      ok: false,
      error: codePage.error || "Claude 验证码页面未显示验证码",
      subject: mail.subject,
      date: mail.date,
      adspowerProfileId,
      startedProfile: codePage.startedProfile,
    };
  }

  return {
    ok: true,
    code: codePage.code,
    source: "mail-password",
    subject: mail.subject,
    date: mail.date,
    adspowerProfileId,
    startedProfile: codePage.startedProfile,
  };
}

export async function openClaudeMagicLinkForVerificationCode(
  input: OpenMagicLinkInBrowserInput,
): Promise<OpenMagicLinkInBrowserResult> {
  const adspowerProfileId = String(input.adspowerProfileId || "").trim();
  if (!adspowerProfileId) return { ok: false, error: "AdsPower 浏览器 ID 必填" };
  if (!input.magicLinkUrl) return { ok: false, error: "Claude magic link 为空" };

  let browser: Browser | null = null;
  let page: Page | null = null;
  let startedProfile = false;

  try {
    const debugUrlResult = await getAdsPowerDebugUrl(adspowerProfileId);
    startedProfile = debugUrlResult.started;
    browser = await chromium.connectOverCDP(debugUrlResult.debugUrl);
    const context = browser.contexts()[0];
    if (!context) throw new Error("AdsPower 浏览器中没有可用上下文");

    page = await context.newPage();
    await page.goto(input.magicLinkUrl, { waitUntil: "domcontentloaded", timeout: input.timeoutMs }).catch(() => {});

    const deadline = Date.now() + input.timeoutMs;
    while (Date.now() < deadline) {
      const code = await readCodeFromPage(page);
      if (code) {
        return { ok: true, code, startedProfile };
      }
      await page.waitForTimeout(1_000).catch(() => {});
    }

    return { ok: false, error: "等待 Claude 验证码页面超时", startedProfile };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err), startedProfile };
  } finally {
    if (input.closeCodeTab !== false && page) {
      await page.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

async function readCodeFromPage(page: Page): Promise<string> {
  const text = await page.textContent("body").catch(() => "");
  return extractClaudeVerificationCode(String(text || ""));
}

async function getAdsPowerDebugUrl(profileId: string): Promise<{ debugUrl: string; started: boolean }> {
  const client = makeDefaultAdsPowerClient();
  const active = await client.checkProfile(profileId);
  if (active.active && active.debugUrl) {
    return { debugUrl: active.debugUrl, started: false };
  }

  const opened = await client.openProfile(profileId);
  return { debugUrl: opened.debugUrl, started: true };
}
