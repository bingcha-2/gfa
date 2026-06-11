// Claude (Anthropic 订阅号池) domain: account CRUD, OAuth manual-paste login flow,
// proxy config, quota refresh. Extracted from RosettaService — behavior-preserving
// (method bodies verbatim, this.dataDir/this.claudeOAuthFetch rebound to the shared
// RosettaContext; binding-accounting calls routed through AccessKeyService).
//
// 注:产品键/文件名是 "anthropic"(承载 "claude" 模型),方法名保留历史 "Claude" 拼写。

import * as crypto from "crypto";
import * as path from "path";

import { proxyAwareFetch, proxyRequiredFetch } from "../lease-core/egress";
import { fetchClaudeQuotaUpstream } from "../remote-anthropic/auth/claude-usage";
import { refreshClaudeAccessToken } from "../remote-anthropic/auth/claude-token-provider";
import { ACCOUNT_SHARE_CAPACITY } from "../token-server/token-billing";
import type { AccessKeyService } from "./access-key.service";
import type { RosettaContext } from "./lib/context";
import { fetchAnthropicMagicLink } from "./lib/imap-magic-link";
import { fetchAnthropicMagicLinkViaWeb } from "./lib/mailcom-web-magic-link";
import { base64Url, codeChallenge } from "./lib/pkce";
import { triggerMagicLinkViaBrowser, type PlaywrightOAuthSession } from "./lib/playwright-oauth";
import { nowIso, readJson, setAccountProxyInPool, toSocks5ProxyUrl, writeJson } from "./lib/store";

// Claude (Anthropic 订阅 OAuth) — 值对照 Claude Code 2.x 二进制(平台已迁到 platform.claude.com /
// claude.com),全部可经 env 覆盖以便线上纠偏而不重新发版。手动流:授权后用户把
// 回调页展示的 code(形如 "code#state")或整个回调 URL 粘回后台换 token。
const CLAUDE_OAUTH_CLIENT_ID = process.env.BCAI_CLAUDE_CLIENT_ID || "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_OAUTH_AUTH_ENDPOINT = process.env.BCAI_CLAUDE_AUTHORIZE_URL || "https://claude.com/cai/oauth/authorize";
const CLAUDE_OAUTH_TOKEN_ENDPOINT = process.env.BCAI_CLAUDE_TOKEN_ENDPOINT || "https://platform.claude.com/v1/oauth/token";
const CLAUDE_OAUTH_REDIRECT_URI = process.env.BCAI_CLAUDE_REDIRECT_URI || "https://platform.claude.com/oauth/code/callback";
const CLAUDE_OAUTH_SCOPES = "org:create_api_key user:profile user:inference";
const CLAUDE_OAUTH_TIMEOUT_MS = 10 * 60 * 1000;

function extractSetCookies(res: Response): string {
  const raw = res.headers.getSetCookie?.() || [];
  return raw.map((c) => c.split(";")[0]).join("; ");
}

function mergeSetCookies(existing: string, res: Response): string {
  const fresh = extractSetCookies(res);
  if (!fresh) return existing;
  if (!existing) return fresh;
  const map = new Map<string, string>();
  for (const pair of existing.split("; ")) {
    const [k] = pair.split("=", 1);
    if (k) map.set(k, pair);
  }
  for (const pair of fresh.split("; ")) {
    const [k] = pair.split("=", 1);
    if (k) map.set(k, pair);
  }
  return [...map.values()].join("; ");
}

type CodexOAuthPending = {
  loginId: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  authUrl: string;
  expiresAt: number;
  status: "pending" | "completed" | "failed";
  email?: string;
  error?: string;
  isUpdate?: boolean;
  proxyUrl?: string;
  mailPassword?: string;
};

export class ClaudeAccountService {
  private claudeOAuthPending: CodexOAuthPending | null = null;
  private playwrightSession: PlaywrightOAuthSession | null = null;

  constructor(private readonly ctx: RosettaContext, private readonly accessKey: AccessKeyService) {}

  // the "claude" MODEL — account-level single quota window stored under the
  // "claude" model key (kept on the product rename). Method names keep the
  // legacy "Claude" spelling; only the product key / file are "anthropic".

  listClaudeAccounts() {
    const filePath = path.join(this.ctx.dataDir, "anthropic-accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const boundCounts = this.accessKey.boundCardCounts("anthropic");
    const shares = this.accessKey.boundSharesByAccount("anthropic");
    const accounts = (Array.isArray(data.accounts) ? data.accounts : []).map((account: any) => ({
      id: Number(account.id || 0),
      email: String(account.email || ""),
      enabled: account.enabled !== false,
      poolEnabled: account.poolEnabled !== false,
      alias: String(account.alias || ""),
      planType: String(account.planType || ""),
      hasToken: Boolean(account.refreshToken || account.accessToken || account.sessionToken),
      boundCardCount: boundCounts.get(Number(account.id || 0)) || 0,
      usedShares: shares.get(Number(account.id || 0)) || 0,
      shareCapacity: ACCOUNT_SHARE_CAPACITY,
      claudeHourlyPercent: Number(account.claudeHourlyPercent ?? -1),
      claudeWeeklyPercent: Number(account.claudeWeeklyPercent ?? -1),
      claudeHourlyResetTime: String(account.claudeHourlyResetTime || ""),
      claudeWeeklyResetTime: String(account.claudeWeeklyResetTime || ""),
      modelQuotaRefreshedAt: Number(account.modelQuotaRefreshedAt || 0),
      proxyUrl: String(account.proxyUrl || ""),
      // 是否已存邮箱密码(用于 token 失效时自动重登)。不回传明文密码。
      hasMailPassword: Boolean(account.mailPassword),
      // Persisted dead-account verdict (written by lease-service) so the console
      // can surface invalid_grant / repeatedly-failing accounts as dead.
      quotaStatus: String(account.quotaStatus || "ok"),
      quotaStatusReason: String(account.quotaStatusReason || ""),
      blockedUntil: Number(account.blockedUntil || 0),
    }));
    return { ok: true, accounts, dataDir: this.ctx.dataDir };
  }

  // anthropic 出口强制 SOCKS5:无论填什么格式都归一成 socks5://,绝不存成 http
  // 直连(裸 host:port 在通用 normalizeProxyUrl 里会默认 http,这里覆盖为 socks5)。
  private normalizeProxyUrl(raw: string): string {
    return toSocks5ProxyUrl(raw);
  }

  addClaudeAccount(payload: any) {
    const email = String(payload?.email || "").trim();
    const refreshToken = String(payload?.refreshToken || "").trim();
    if (!email) return { ok: false, error: "email 不能为空" };
    if (!refreshToken) return { ok: false, error: "refreshToken 不能为空" };

    const filePath = path.join(this.ctx.dataDir, "anthropic-accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const existing = accounts.find((account: any) => String(account.email || "").toLowerCase() === email.toLowerCase());
    let accountId: number;
    if (existing) {
      existing.refreshToken = refreshToken;
      existing.enabled = payload.enabled !== undefined ? payload.enabled !== false : true;
      existing.alias = String(payload.alias ?? existing.alias ?? "");
      if (payload.planType !== undefined) existing.planType = String(payload.planType || "");
      if (payload.accessToken) existing.accessToken = String(payload.accessToken);
      if (payload.accessTokenExpiresAt) existing.accessTokenExpiresAt = Number(payload.accessTokenExpiresAt);
      if (payload.proxyUrl !== undefined) existing.proxyUrl = this.normalizeProxyUrl(payload.proxyUrl);
      if (payload.mailPassword) existing.mailPassword = String(payload.mailPassword);
      accountId = Number(existing.id);
    } else {
      const maxId = accounts.reduce((max: number, account: any) => Math.max(max, Number(account.id || 0)), 0);
      accountId = maxId + 1;
      const record: any = {
        id: accountId,
        email,
        refreshToken,
        enabled: payload.enabled !== undefined ? payload.enabled !== false : true,
        alias: String(payload.alias || ""),
        planType: String(payload.planType || ""),
      };
      if (payload.accessToken) record.accessToken = String(payload.accessToken);
      if (payload.accessTokenExpiresAt) record.accessTokenExpiresAt = Number(payload.accessTokenExpiresAt);
      if (payload.proxyUrl) record.proxyUrl = this.normalizeProxyUrl(payload.proxyUrl);
      if (payload.mailPassword) record.mailPassword = String(payload.mailPassword);
      accounts.push(record);
    }
    writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });
    return { ok: true, id: accountId, email, isUpdate: Boolean(existing), totalAccounts: accounts.length };
  }

  // ── Claude OAuth(手动粘贴回调,对照 codex 同名流程)────────────────────────
  // 不起本地回调 server:用户在浏览器登录 Claude 订阅号授权后,把回调页展示的
  // code(形如 "code#state")或整段回调 URL 粘回后台,这里换 token 并入库。

  async startClaudeOAuthLogin(proxyUrl?: string) {
    const existing = this.claudeOAuthPending;
    if (existing && existing.status === "pending" && existing.expiresAt > Date.now()) {
      return { ok: true, loginId: existing.loginId, authUrl: existing.authUrl, redirectUri: existing.redirectUri, expiresAt: existing.expiresAt };
    }
    this.claudeOAuthPending = null;

    const codeVerifier = base64Url(crypto.randomBytes(32));
    const state = base64Url(crypto.randomBytes(32));
    const loginId = base64Url(crypto.randomBytes(18));
    const params = new URLSearchParams({
      code: "true",
      response_type: "code",
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
      scope: CLAUDE_OAUTH_SCOPES,
      code_challenge: codeChallenge(codeVerifier),
      code_challenge_method: "S256",
      state,
    });
    const authUrl = `${CLAUDE_OAUTH_AUTH_ENDPOINT}?${params.toString()}`;

    // 通过代理请求 authorize URL，探测服务端是否能直接拿到重定向/页面
    let probeInfo: { status: number; location?: string; bodySnippet?: string } | undefined;
    if (proxyUrl) {
      try {
        const res = await proxyAwareFetch(proxyUrl, authUrl, {
          method: "GET",
          redirect: "manual",
          headers: {
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
          },
        });
        const location = res.headers.get("location") || undefined;
        const body = await res.text();
        probeInfo = { status: res.status, location, bodySnippet: body.slice(0, 2000) };
      } catch (err: any) {
        probeInfo = { status: 0, bodySnippet: `probe error: ${err?.message || err}` };
      }
    }

    const pending: CodexOAuthPending = {
      loginId,
      state,
      codeVerifier,
      redirectUri: CLAUDE_OAUTH_REDIRECT_URI,
      authUrl,
      expiresAt: Date.now() + CLAUDE_OAUTH_TIMEOUT_MS,
      status: "pending",
      proxyUrl: proxyUrl || undefined,
    };
    this.claudeOAuthPending = pending;
    return { ok: true, loginId, authUrl: pending.authUrl, redirectUri: pending.redirectUri, expiresAt: pending.expiresAt, probeInfo };
  }

  // 通过代理跟随 magic link 重定向,自动提取 code（省去手动打开浏览器粘贴 code）
  async followMagicLink(loginId: string, magicLinkUrl: string) {
    const pending = this.claudeOAuthPending;
    if (!pending || pending.loginId !== loginId) {
      return { ok: false, error: "登录会话不存在" };
    }
    if (!pending.proxyUrl) {
      return { ok: false, error: "未设置代理,无法服务端跟随链接" };
    }

    try {
      // 第一步:请求 magic link,不自动跟随重定向
      const res = await proxyAwareFetch(pending.proxyUrl, magicLinkUrl, {
        method: "GET",
        redirect: "manual",
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        },
      });

      // 跟随重定向链,最多 10 次,直到找到 callback URL 含 code
      let location = res.headers.get("location");
      let hops = 0;
      let cookies = extractSetCookies(res);
      let currentUrl = magicLinkUrl;
      let currentStatus = res.status;
      let lastBody = "";

      while (location && hops < 10) {
        const absUrl = new URL(location, currentUrl).href;
        // 检查 callback URL 是否包含 code
        try {
          const parsed = new URL(absUrl);
          const code = parsed.searchParams.get("code");
          if (code) {
            // 拿到 code 了,直接走完授权
            const state = parsed.searchParams.get("state") || pending.state;
            const result = await this.completeClaudeOAuthLogin(pending, code, state);
            return { ok: true, status: "completed", email: result.email, isUpdate: result.isUpdate, accountId: result.accountId };
          }
        } catch {}

        const nextRes = await proxyAwareFetch(pending.proxyUrl!, absUrl, {
          method: "GET",
          redirect: "manual",
          headers: {
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
            ...(cookies ? { cookie: cookies } : {}),
          },
        });
        cookies = mergeSetCookies(cookies, nextRes);
        currentUrl = absUrl;
        currentStatus = nextRes.status;
        location = nextRes.headers.get("location") || null;
        lastBody = await nextRes.text();
        hops++;
      }

      return {
        ok: false,
        error: `跟随 ${hops} 次重定向后未找到 code`,
        lastStatus: currentStatus,
        lastUrl: currentUrl,
        bodySnippet: lastBody.slice(0, 1000),
      };
    } catch (err: any) {
      return { ok: false, error: `跟随链接失败: ${err?.message || err}` };
    }
  }

  getClaudeOAuthLoginStatus(loginId: string) {
    const pending = this.claudeOAuthPending;
    if (!pending || pending.loginId !== loginId) return { ok: false, status: "missing", error: "login session not found" };
    if (pending.status === "pending" && pending.expiresAt <= Date.now()) {
      pending.status = "failed";
      pending.error = "OAuth login timed out";
    }
    return {
      ok: true,
      status: pending.status,
      loginId: pending.loginId,
      email: pending.email || "",
      error: pending.error || "",
      isUpdate: Boolean(pending.isUpdate),
      expiresAt: pending.expiresAt,
    };
  }

  cancelClaudeOAuthLogin(loginId: string) {
    if (this.claudeOAuthPending?.loginId !== loginId) return { ok: false, error: "login session not found" };
    this.claudeOAuthPending = null;
    return { ok: true };
  }

  async submitClaudeOAuthCallback(loginId: string, rawInput: string) {
    const pending = this.claudeOAuthPending;
    if (!pending || pending.loginId !== loginId) {
      return { ok: false, status: "missing", error: "登录会话不存在或已过期,请重新发起 OAuth 登录" };
    }
    if (pending.status !== "pending" || pending.expiresAt <= Date.now()) {
      pending.status = "failed";
      pending.error = pending.error || "OAuth 登录会话已失效,请重新发起";
      return { ok: false, status: "failed", error: pending.error };
    }

    const input = String(rawInput || "").trim();
    if (!input) return { ok: false, status: "pending", error: "请粘贴回调 URL 或授权码 code" };

    let code = "";
    let state = "";
    try {
      const url = new URL(input);
      code = (url.searchParams.get("code") || "").trim();
      state = (url.searchParams.get("state") || "").trim();
    } catch {
      // 非完整 URL:Claude 手动流回调页展示的是 "code#state";也兼容 query 片段 / 纯 code。
      if (input.includes("#")) {
        const [c, s] = input.split("#");
        code = (c || "").trim();
        state = (s || "").trim();
      } else if (input.includes("code=")) {
        const query = input.includes("?") ? input.slice(input.indexOf("?") + 1) : input.replace(/^[#&?]+/, "");
        const params = new URLSearchParams(query);
        code = (params.get("code") || "").trim();
        state = (params.get("state") || "").trim();
      } else {
        code = input;
      }
    }

    if (!code) return { ok: false, status: "pending", error: "未能从输入中解析出授权码 code" };
    if (state && state !== pending.state) {
      pending.status = "failed";
      pending.error = "OAuth state 不匹配,可能是会话串了,请重新发起登录";
      return { ok: false, status: "failed", error: pending.error };
    }

    try {
      const result = await this.completeClaudeOAuthLogin(pending, code, state || pending.state);
      return { ok: true, status: "completed", email: result.email, isUpdate: result.isUpdate, accountId: result.accountId };
    } catch (error) {
      pending.status = "failed";
      pending.error = error instanceof Error ? error.message : "OAuth 完成失败";
      return { ok: false, status: "failed", error: pending.error };
    }
  }

  private async completeClaudeOAuthLogin(pending: CodexOAuthPending, code: string, state: string) {
    // Anthropic egress is fail-closed: the code→token exchange MUST leave from
    // the account's sticky proxy IP. No proxy = hard error, never a direct
    // datacenter-IP call (would leak the IP and trip anti-abuse on the new token).
    const response = await proxyRequiredFetch(pending.proxyUrl, CLAUDE_OAUTH_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        state,
        client_id: CLAUDE_OAUTH_CLIENT_ID,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.codeVerifier,
      }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Token exchange failed: ${response.status} ${text}`);

    const tokenData = JSON.parse(text);
    const email = String(tokenData?.account?.email_address || tokenData?.account?.email || "").trim();
    if (!email) throw new Error("Token response did not include an account email");
    const refreshToken = String(tokenData.refresh_token || "");
    if (!refreshToken) throw new Error("Token response did not include a refresh_token");

    const result = this.addClaudeAccount({
      email,
      refreshToken,
      accessToken: tokenData.access_token || "",
      accessTokenExpiresAt: Date.now() + Number(tokenData.expires_in || 3600) * 1000,
      alias: String(tokenData?.organization?.name || ""),
      proxyUrl: pending.proxyUrl || "",
      mailPassword: pending.mailPassword || "",
    });
    if (!result.ok) throw new Error(String(result.error || "Failed to save Claude account"));

    pending.status = "completed";
    pending.email = email;
    pending.isUpdate = Boolean(result.isUpdate);
    return { email, isUpdate: Boolean(result.isUpdate), accountId: result.id };
  }

  // ── Magic-link fetcher ──────────────────────────────────────────────────
  // Find the latest Anthropic "Secure link to log in to Claude.ai" email and
  // return its magic-link URL, to automate the email step of the OAuth flow.
  //
  // Two transports:
  //   - "web" (default): log into mail.com's no-JS web mailbox over HTTP. Works
  //     even when the account has IMAP turned off (mail.com free/bulk accounts
  //     default IMAP OFF → IMAP LOGIN returns "authentication failed").
  //   - "imap": classic IMAP fetch (only works if IMAP is enabled on the box).
  // method=auto tries web first, then IMAP.
  async fetchClaudeMagicLink(payload: any) {
    const email = String(payload?.email || "").trim();
    const password = String(payload?.password || "").trim();
    if (!email || !password) return { ok: false, error: "email 和 password 必填" };
    const method = String(payload?.method || "web").toLowerCase();
    const host = payload?.host ? String(payload.host).trim() : undefined;
    const port = payload?.port ? Number(payload.port) : undefined;
    // Only accept a link received at/after sinceMs (defends against stale links
    // from a prior login). waitMs polls for the email to arrive after trigger,
    // capped so a single request never outlives the dev proxy's socket timeout
    // (a long-held request shows up as ECONNRESET → HTML 500 → JSON parse error
    // on the client). The frontend polls across multiple short requests instead.
    const sinceMs = payload?.sinceMs ? Number(payload.sinceMs) : undefined;
    const waitMs = payload?.waitMs ? Math.min(Number(payload.waitMs) || 0, 12_000) : undefined;

    if (method === "imap") {
      return fetchAnthropicMagicLink({ email, password, host, port });
    }

    const web = await fetchAnthropicMagicLinkViaWeb({ email, password, sinceMs, waitMs });
    if (web.ok || method === "web") return web;

    // method=auto: fall back to IMAP if web scraping failed
    const imap = await fetchAnthropicMagicLink({ email, password, host, port });
    return imap.ok ? imap : { ok: false, error: `web: ${web.error}; imap: ${imap.error}` };
  }

  // ── 全自动 Playwright OAuth (异步) ──────────────────────────────────────
  // The full flow (browser → CF challenge → fill email → fetch mail → consume
  // magic link → token) takes 30-120s. Next.js dev proxy drops connections
  // after ~30s, so we run asynchronously: startAutoOAuth() validates + fires
  // the background job + returns a taskId instantly; getAutoOAuthStatus()
  // returns the live status for polling.

  private autoOAuthTask: {
    taskId: string;
    phase: string;
    status: "running" | "done" | "error";
    error?: string;
    email?: string;
    isUpdate?: boolean;
    accountId?: number;
  } | null = null;

  startAutoClaudeOAuth(payload: {
    email: string;
    password: string;
    proxyUrl: string;
    sessionKey?: string;
  }) {
    const { email, password, proxyUrl } = payload;
    if (!email || !proxyUrl) return { ok: false, error: "email 和 proxyUrl 必填" };
    if (!password) return { ok: false, error: "password 必填(用于 mail.com 网页抓取)" };

    const taskId = base64Url(crypto.randomBytes(12));
    this.autoOAuthTask = { taskId, phase: "starting", status: "running" };

    // Fire and forget — caller polls via getAutoOAuthStatus
    this.runAutoOAuth(taskId, email, password, proxyUrl).catch((err) => {
      if (this.autoOAuthTask?.taskId === taskId) {
        this.autoOAuthTask.status = "error";
        this.autoOAuthTask.error = String(err?.message || err);
      }
    });

    return { ok: true, taskId };
  }

  getAutoOAuthStatus(taskId: string) {
    const t = this.autoOAuthTask;
    if (!t || t.taskId !== taskId) return { ok: false, error: "任务不存在" };
    return {
      ok: true,
      taskId: t.taskId,
      phase: t.phase,
      status: t.status,
      error: t.error,
      email: t.email,
      isUpdate: t.isUpdate,
      accountId: t.accountId,
    };
  }

  private async runAutoOAuth(taskId: string, email: string, password: string, proxyUrl: string) {
    const task = this.autoOAuthTask!;
    const step = (phase: string) => {
      if (task.taskId !== taskId) return;
      task.phase = phase;
      console.log(`[auto-oauth] ${email}: ${phase}`);
    };

    try {
      // Clean up any previous browser session
      if (this.playwrightSession) {
        await this.playwrightSession.close().catch(() => {});
        this.playwrightSession = null;
      }

      // 1. Create OAuth pending (PKCE + authorize URL)
      step("creating OAuth session");
      this.claudeOAuthPending = null;
      const startResult = await this.startClaudeOAuthLogin(proxyUrl);
      if (!startResult.ok) throw new Error("OAuth 会话创建失败");
      const pending = this.claudeOAuthPending!;
      pending.mailPassword = password;

      // 2. Browser: navigate to authorize URL → CF challenge → fill email → submit
      step("launching browser (SOCKS5 proxy)");
      const triggerStart = Date.now();
      const trigger = await triggerMagicLinkViaBrowser({
        authorizeUrl: pending.authUrl,
        email,
        proxyUrl,
      });
      if (!trigger.ok || !trigger.session) {
        throw new Error(trigger.error || "浏览器触发失败");
      }
      this.playwrightSession = trigger.session;
      step(`email submitted (${((Date.now() - triggerStart) / 1000).toFixed(1)}s), waiting for magic link email`);

      // 3. Fetch magic link from mail.com (poll up to 90s)
      step("fetching magic link from mailbox");
      const sinceMs = triggerStart - 30_000;
      const mailResult = await fetchAnthropicMagicLinkViaWeb({
        email,
        password,
        sinceMs,
        waitMs: 90_000,
      });
      if (!mailResult.ok || !mailResult.url) {
        await this.playwrightSession.close().catch(() => {});
        this.playwrightSession = null;
        throw new Error(mailResult.error || "未获取到 magic link");
      }
      step("got magic link, consuming in browser");

      // 4. Consume magic link in browser → OAuth code
      const consume = await this.playwrightSession.consumeMagicLink(mailResult.url, 60_000);
      await this.playwrightSession.close().catch(() => {});
      this.playwrightSession = null;

      if (!consume.ok || !consume.code) {
        throw new Error(consume.error || "未获取到 OAuth code");
      }
      step("got code, exchanging for token");

      // 5. Code → token
      const result = await this.completeClaudeOAuthLogin(pending, consume.code, consume.state || pending.state);
      step(`done! ${result.email} ${result.isUpdate ? "updated" : "added"}`);

      // 6. Auto-refresh quota (token + usage probe)
      if (result.accountId) {
        step("refreshing quota");
        try {
          await this.refreshClaudeAccountQuota({ accountId: result.accountId });
          step("quota refreshed");
        } catch {
          // non-fatal — account is already saved
        }
      }

      if (task.taskId === taskId) {
        task.status = "done";
        task.email = result.email;
        task.isUpdate = result.isUpdate;
        task.accountId = result.accountId;
        task.phase = "completed";
      }
    } catch (err: any) {
      if (task.taskId === taskId) {
        task.status = "error";
        task.error = String(err?.message || err);
      }
    }
  }

  toggleClaudeAccount(payload: any) {
    const accountId = Number(payload?.accountId);
    const filePath = path.join(this.ctx.dataDir, "anthropic-accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const account = accounts.find((item: any) => Number(item.id) === accountId);
    if (!account) return { ok: false, error: "账号不存在" };
    account.enabled = !account.enabled;
    writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });
    return { ok: true, email: account.email, enabled: account.enabled };
  }

  // 出池/入池:poolEnabled===false 的号退出动态池(只服务绑定它的卡),
  // 与 codex/antigravity 同义。运行时过滤在 lease-service 用 poolEnabled!==false 把关。
  toggleClaudeAccountPool(payload: any) {
    const accountId = Number(payload?.accountId);
    const filePath = path.join(this.ctx.dataDir, "anthropic-accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const account = accounts.find((item: any) => Number(item.id) === accountId);
    if (!account) return { ok: false, error: "账号不存在" };
    account.poolEnabled = account.poolEnabled === false ? true : false;
    writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });
    return { ok: true, email: account.email, poolEnabled: account.poolEnabled };
  }

  // 设置/清除某 anthropic 账号的出口代理(粘性住宅代理 URL)。空=清除。
  // 客户端租到该号时随 lease 下发 accountProxyUrl,该号的 anthropic 出口固定走它(一号一IP)。
  // anthropic 出口强制 SOCKS5:无论后台填什么格式(裸 host:port:user:pass / http:// /
  // 已是 socks5://),都先归一成 socks5:// 再入库,绝不存成 http 直连。
  setClaudeAccountProxy(payload: any) {
    const filePath = path.join(this.ctx.dataDir, "anthropic-accounts.json");
    return setAccountProxyInPool(filePath, Number(payload?.accountId), toSocks5ProxyUrl(payload?.proxyUrl));
  }

  // 设置/清除某 anthropic 账号的邮箱密码。空=清除。存了密码 + 代理后,token
  // 失效(invalid_grant)时刷额度会自动走 Playwright 重登。给老账号补登用。
  setClaudeAccountMailPassword(payload: any) {
    const accountId = Number(payload?.accountId);
    const mailPassword = String(payload?.mailPassword ?? "");
    const filePath = path.join(this.ctx.dataDir, "anthropic-accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const account = accounts.find((item: any) => Number(item.id) === accountId);
    if (!account) return { ok: false, error: "账号不存在" };
    if (mailPassword) account.mailPassword = mailPassword;
    else delete account.mailPassword;
    writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });
    return { ok: true, email: account.email, hasMailPassword: Boolean(account.mailPassword) };
  }

  deleteClaudeAccount(payload: any) {
    const accountId = Number(payload?.accountId);
    const filePath = path.join(this.ctx.dataDir, "anthropic-accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const filtered = accounts.filter((account: any) => Number(account.id) !== accountId);
    if (filtered.length === accounts.length) return { ok: false, error: "账号不存在" };
    writeJson(filePath, { ...data, accounts: filtered, updatedAt: nowIso() });
    this.accessKey.clearBindingsForAccount("anthropic", accountId);
    return { ok: true, totalAccounts: filtered.length };
  }

  // 「刷新」= 强制刷 token + 探测拉额度(合并为一个动作),对齐 codex 的按钮。
  // Claude 无独立用量接口,只能用账号 token 向 Anthropic 发一次最小探测请求,从
  // anthropic-ratelimit-unified-* 响应头解析 5h/周剩余。token 一定会刷新;额度解析
  // 为尽力而为,并回带 rawHeaders 便于核对真实头名。
  async refreshClaudeAccountQuota(payload: any) {
    const accountId = Number(payload?.accountId);
    const filePath = path.join(this.ctx.dataDir, "anthropic-accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts: any[] = Array.isArray(data.accounts) ? data.accounts : [];
    const acc = accounts.find((a: any) => Number(a.id) === accountId);
    if (!acc) return { ok: false, error: "账号不存在" };
    if (!acc.refreshToken) return { ok: false, error: "该账号没有 refreshToken" };
    try {
      // Carry id + proxyUrl so this probe shares the lease path's per-account
      // single-flight lock (keyed by email) and refreshes through the same exit
      // IP. reload re-reads the file so an invalid_grant can adopt a token the
      // lease path just rotated instead of double-burning a single-use token.
      const probe = {
        id: acc.id,
        email: acc.email,
        refreshToken: acc.refreshToken,
        proxyUrl: acc.proxyUrl,
      } as any;
      const token = await refreshClaudeAccessToken(probe, {
        reload: () => {
          try {
            const latest = readJson(filePath, { accounts: [] });
            const list: any[] = Array.isArray(latest.accounts) ? latest.accounts : [];
            return list.find((a: any) => Number(a.id) === acc.id) || null;
          } catch {
            return null;
          }
        },
      });
      acc.accessToken = token;
      acc.accessTokenExpiresAt = probe.accessTokenExpiresAt;
      if (probe.refreshToken && probe.refreshToken !== acc.refreshToken) acc.refreshToken = probe.refreshToken;

      // Probe upstream through the account's sticky residential proxy — same IP
      // that serves inference. A datacenter-IP probe is an anti-abuse signal.
      const snap = await fetchClaudeQuotaUpstream(token, acc.proxyUrl);
      // 记录 /api/oauth/usage 原始返回,便于核对/排查。
      console.log(
        `[claude-refresh] #${accountId} ${acc.email} http=${snap.httpStatus} usage=${JSON.stringify(snap.raw)}${snap.error ? ` error=${snap.error}` : ""}`,
      );
      // 套餐(来自 /api/oauth/profile):有就更新,对齐 codex 的行为。
      if (snap.planType) acc.planType = snap.planType;
      const cq = snap.claudeQuota;
      if (!cq) {
        // token 已刷新并落盘;额度未解析到 → 仍算成功,回带原始返回便于排查。
        writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });
        return {
          ok: true,
          email: acc.email,
          tokenValid: true,
          quotaError: snap.error
            ? `额度获取失败:${snap.error}`
            : "本次未拿到 5h/周额度(该号可能非订阅号或无用量数据)",
          raw: snap.raw,
        };
      }
      // 本次探测可能只拿到部分窗口(上游偶发漏返 seven_day,曾把周误报成 0、把健康号
      // 打到最后兜底)。已知窗口(>=0)才覆盖落盘,未知(-1)保留上一次的好值;绑定窗口
      // 也只在已知窗口之间取更严的那个,绝不让一条残缺响应污染调度状态。
      const prevHourly = Number(acc.claudeHourlyPercent ?? -1);
      const prevWeekly = Number(acc.claudeWeeklyPercent ?? -1);
      const hourly = cq.hourlyPercent >= 0 ? cq.hourlyPercent : prevHourly;
      const weekly = cq.weeklyPercent >= 0 ? cq.weeklyPercent : prevWeekly;

      let weeklyBinds: boolean;
      if (hourly < 0) weeklyBinds = true;        // 只有周已知
      else if (weekly < 0) weeklyBinds = false;  // 只有 5h 已知
      else weeklyBinds = weekly < hourly;
      const bindingPercent = weeklyBinds ? weekly : hourly;
      const bindingReset = weeklyBinds
        ? (cq.weeklyResetTime || String(acc.claudeWeeklyResetTime || ""))
        : (cq.hourlyResetTime || String(acc.claudeHourlyResetTime || ""));

      if (bindingPercent >= 0) acc.modelQuotaFractions = { claude: bindingPercent / 100 };
      if (bindingReset) acc.modelQuotaResetTimes = { claude: bindingReset };
      acc.modelQuotaRefreshedAt = Date.now();
      if (cq.hourlyPercent >= 0) {
        acc.claudeHourlyPercent = cq.hourlyPercent;
        acc.claudeHourlyResetTime = cq.hourlyResetTime || "";
      }
      if (cq.weeklyPercent >= 0) {
        acc.claudeWeeklyPercent = cq.weeklyPercent;
        acc.claudeWeeklyResetTime = cq.weeklyResetTime || "";
      }
      writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });
      return {
        ok: true,
        email: acc.email,
        tokenValid: true,
        planType: acc.planType || "",
        hourlyPercent: hourly,
        weeklyPercent: weekly,
        hourlyResetTime: acc.claudeHourlyResetTime || "",
        weeklyResetTime: acc.claudeWeeklyResetTime || "",
      };
    } catch (err: any) {
      const msg = String(err?.message || err);
      // Token 彻底失效(invalid_grant / refresh token revoked)→ 有存储密码时自动重新走 OAuth
      if (/invalid_grant|refresh token not found|token.*revoked/i.test(msg) && acc.mailPassword && acc.proxyUrl) {
        console.log(`[claude-refresh] #${accountId} ${acc.email} token dead, auto re-auth...`);
        const reauth = this.startAutoClaudeOAuth({
          email: acc.email,
          password: acc.mailPassword,
          proxyUrl: acc.proxyUrl,
        });
        if (reauth.ok) {
          return {
            ok: false,
            email: acc.email,
            error: msg,
            autoReauth: true,
            reauthTaskId: reauth.taskId,
          };
        }
      }
      return { ok: false, email: acc.email, error: msg };
    }
  }
}
