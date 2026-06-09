// Claude (Anthropic 订阅号池) domain: account CRUD, OAuth manual-paste login flow,
// proxy config, quota refresh. Extracted from RosettaService — behavior-preserving
// (method bodies verbatim, this.dataDir/this.claudeOAuthFetch rebound to the shared
// RosettaContext; binding-accounting calls routed through AccessKeyService).
//
// 注:产品键/文件名是 "anthropic"(承载 "claude" 模型),方法名保留历史 "Claude" 拼写。

import * as crypto from "crypto";
import * as path from "path";

import { fetchClaudeQuotaUpstream } from "../remote-anthropic/auth/claude-usage";
import { refreshClaudeAccessToken } from "../remote-anthropic/auth/claude-token-provider";
import { ACCOUNT_SHARE_CAPACITY } from "../token-server/token-billing";
import type { AccessKeyService } from "./access-key.service";
import type { RosettaContext } from "./lib/context";
import { base64Url, codeChallenge } from "./lib/pkce";
import { normalizeProxyUrl, nowIso, readJson, setAccountProxyInPool, writeJson } from "./lib/store";

// Claude (Anthropic 订阅 OAuth) — 值对照 Claude Code 2.x 二进制(平台已迁到 platform.claude.com /
// claude.com),全部可经 env 覆盖以便线上纠偏而不重新发版。手动流:授权后用户把
// 回调页展示的 code(形如 "code#state")或整个回调 URL 粘回后台换 token。
const CLAUDE_OAUTH_CLIENT_ID = process.env.BCAI_CLAUDE_CLIENT_ID || "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_OAUTH_AUTH_ENDPOINT = process.env.BCAI_CLAUDE_AUTHORIZE_URL || "https://claude.com/cai/oauth/authorize";
const CLAUDE_OAUTH_TOKEN_ENDPOINT = process.env.BCAI_CLAUDE_TOKEN_ENDPOINT || "https://platform.claude.com/v1/oauth/token";
const CLAUDE_OAUTH_REDIRECT_URI = process.env.BCAI_CLAUDE_REDIRECT_URI || "https://platform.claude.com/oauth/code/callback";
const CLAUDE_OAUTH_SCOPES = "org:create_api_key user:profile user:inference";
const CLAUDE_OAUTH_TIMEOUT_MS = 10 * 60 * 1000;

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
};

export class ClaudeAccountService {
  private claudeOAuthPending: CodexOAuthPending | null = null;

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
      modelQuotaRefreshedAt: Number(account.modelQuotaRefreshedAt || 0),
      proxyUrl: String(account.proxyUrl || ""),
      // Persisted dead-account verdict (written by lease-service) so the console
      // can surface invalid_grant / repeatedly-failing accounts as dead.
      quotaStatus: String(account.quotaStatus || "ok"),
      quotaStatusReason: String(account.quotaStatusReason || ""),
      blockedUntil: Number(account.blockedUntil || 0),
    }));
    return { ok: true, accounts, dataDir: this.ctx.dataDir };
  }

  // 归一化代理委托给通用实现(lib/store),三家共用一套解析。
  private normalizeProxyUrl(raw: string): string {
    return normalizeProxyUrl(raw);
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
      accounts.push(record);
    }
    writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });
    return { ok: true, id: accountId, email, isUpdate: Boolean(existing), totalAccounts: accounts.length };
  }

  // ── Claude OAuth(手动粘贴回调,对照 codex 同名流程)────────────────────────
  // 不起本地回调 server:用户在浏览器登录 Claude 订阅号授权后,把回调页展示的
  // code(形如 "code#state")或整段回调 URL 粘回后台,这里换 token 并入库。

  async startClaudeOAuthLogin() {
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
    const pending: CodexOAuthPending = {
      loginId,
      state,
      codeVerifier,
      redirectUri: CLAUDE_OAUTH_REDIRECT_URI,
      authUrl: `${CLAUDE_OAUTH_AUTH_ENDPOINT}?${params.toString()}`,
      expiresAt: Date.now() + CLAUDE_OAUTH_TIMEOUT_MS,
      status: "pending",
    };
    this.claudeOAuthPending = pending;
    return { ok: true, loginId, authUrl: pending.authUrl, redirectUri: pending.redirectUri, expiresAt: pending.expiresAt };
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
    const response = await this.ctx.claudeOAuthFetch(CLAUDE_OAUTH_TOKEN_ENDPOINT, {
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
    });
    if (!result.ok) throw new Error(String(result.error || "Failed to save Claude account"));

    pending.status = "completed";
    pending.email = email;
    pending.isUpdate = Boolean(result.isUpdate);
    return { email, isUpdate: Boolean(result.isUpdate), accountId: result.id };
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
  setClaudeAccountProxy(payload: any) {
    const filePath = path.join(this.ctx.dataDir, "anthropic-accounts.json");
    return setAccountProxyInPool(filePath, Number(payload?.accountId), payload?.proxyUrl);
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
      const probe = { email: acc.email, refreshToken: acc.refreshToken } as any;
      const token = await refreshClaudeAccessToken(probe);
      acc.accessToken = token;
      acc.accessTokenExpiresAt = probe.accessTokenExpiresAt;
      if (probe.refreshToken && probe.refreshToken !== acc.refreshToken) acc.refreshToken = probe.refreshToken;

      const snap = await fetchClaudeQuotaUpstream(token);
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
      const weeklyBinds = cq.weeklyPercent < cq.hourlyPercent;
      const bindingPercent = weeklyBinds ? cq.weeklyPercent : cq.hourlyPercent;
      const bindingReset = weeklyBinds ? cq.weeklyResetTime : cq.hourlyResetTime;
      acc.modelQuotaFractions = { claude: bindingPercent / 100 };
      if (bindingReset) acc.modelQuotaResetTimes = { claude: bindingReset };
      acc.modelQuotaRefreshedAt = Date.now();
      acc.claudeHourlyPercent = cq.hourlyPercent;
      acc.claudeWeeklyPercent = cq.weeklyPercent;
      acc.claudeHourlyResetTime = cq.hourlyResetTime || "";
      acc.claudeWeeklyResetTime = cq.weeklyResetTime || "";
      writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });
      return {
        ok: true,
        email: acc.email,
        tokenValid: true,
        planType: acc.planType || "",
        hourlyPercent: cq.hourlyPercent,
        weeklyPercent: cq.weeklyPercent,
        hourlyResetTime: cq.hourlyResetTime || "",
        weeklyResetTime: cq.weeklyResetTime || "",
      };
    } catch (err: any) {
      return { ok: false, email: acc.email, error: String(err?.message || err) };
    }
  }
}
