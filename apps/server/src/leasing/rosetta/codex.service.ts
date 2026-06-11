// Codex account-pool domain: CRUD, JSON import/export, token-probe + quota
// refresh, and the manual (paste-back) OAuth login flow. Extracted from
// RosettaService — behavior-preserving (method bodies verbatim, this.dataDir /
// this.logger / this.tokenCache / this.codexOAuth* rebound to the shared
// RosettaContext; card-binding accounting delegated to AccessKeyService).

import * as crypto from "crypto";
import * as path from "path";

import { refreshCodexAccessToken } from "../remote-codex/auth/codex-token-provider";
import { fetchCodexQuotaUpstream } from "../remote-codex/auth/codex-usage";
import { AccessKeyService } from "./access-key.service";
import type { RosettaContext } from "./lib/context";
import {
  type CodexImportFields,
  collectCodexImportCandidates,
  extractCodexImportFields,
  firstCodexImportCandidate,
  parseJsonFromText,
} from "./lib/import-parse";
import { base64Url, codeChallenge, decodeJwtPayload } from "./lib/pkce";
import { setAccountEnabled } from "./lib/pool";
import { nowIso, readJson, writeJson } from "./lib/store";
import { ACCOUNT_SHARE_CAPACITY } from "../token-server/token-billing";

const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_AUTH_ENDPOINT = "https://auth.openai.com/oauth/authorize";
const CODEX_OAUTH_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const CODEX_OAUTH_SCOPES = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const CODEX_OAUTH_ORIGINATOR = "codex_vscode";
const CODEX_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

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

export class CodexService {
  private codexOAuthPending: CodexOAuthPending | null = null;

  constructor(private readonly ctx: RosettaContext, private readonly accessKey: AccessKeyService) {}

  listCodexAccounts() {
    const filePath = path.join(this.ctx.dataDir, "codex-accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const boundCounts = this.accessKey.boundCardCounts("codex");
    const shares = this.accessKey.boundSharesByAccount("codex");
    const accounts = (Array.isArray(data.accounts) ? data.accounts : []).map((account: any) => ({
      id: Number(account.id || 0),
      email: String(account.email || ""),
      enabled: account.enabled !== false,
      poolEnabled: account.poolEnabled !== false,
      alias: String(account.alias || ""),
      planType: String(account.planType || ""),
      proxyUrl: String(account.proxyUrl || ""),
      hasToken: Boolean(account.refreshToken || account.accessToken || account.sessionToken),
      boundCardCount: boundCounts.get(Number(account.id || 0)) || 0,
      usedShares: shares.get(Number(account.id || 0)) || 0,
      shareCapacity: ACCOUNT_SHARE_CAPACITY,
      codexHourlyPercent: Number(account.codexHourlyPercent ?? -1),
      codexWeeklyPercent: Number(account.codexWeeklyPercent ?? -1),
      modelQuotaRefreshedAt: Number(account.modelQuotaRefreshedAt || 0),
      // Persisted dead-account verdict (written by lease-service) so the console
      // can surface invalid_grant / repeatedly-failing accounts as dead.
      quotaStatus: String(account.quotaStatus || "ok"),
      quotaStatusReason: String(account.quotaStatusReason || ""),
      blockedUntil: Number(account.blockedUntil || 0),
    }));
    return { ok: true, accounts, dataDir: this.ctx.dataDir };
  }

  addCodexAccount(payload: any) {
    const email = String(payload?.email || "").trim();
    const refreshToken = String(payload?.refreshToken || "").trim();
    if (!email) return { ok: false, error: "email 不能为空" };
    if (!refreshToken) return { ok: false, error: "refreshToken 不能为空" };

    const filePath = path.join(this.ctx.dataDir, "codex-accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const existing = accounts.find((account: any) => String(account.email || "").toLowerCase() === email.toLowerCase());
    let accountId: number;
    if (existing) {
      existing.refreshToken = refreshToken;
      existing.enabled = payload.enabled !== undefined ? payload.enabled !== false : true;
      existing.alias = String(payload.alias ?? existing.alias ?? "");
      if (payload.planType !== undefined) existing.planType = String(payload.planType || "");
      accountId = Number(existing.id);
    } else {
      const maxId = accounts.reduce((max: number, account: any) => Math.max(max, Number(account.id || 0)), 0);
      accountId = maxId + 1;
      accounts.push({
        id: accountId,
        email,
        refreshToken,
        enabled: payload.enabled !== undefined ? payload.enabled !== false : true,
        alias: String(payload.alias || ""),
        planType: String(payload.planType || ""),
      });
    }
    writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });
    return { ok: true, id: accountId, email, isUpdate: Boolean(existing), totalAccounts: accounts.length };
  }

  /** codex-add-account + 入库探活(后台入口用)。 */
  async addCodexAccountChecked(payload: any) {
    const r = this.addCodexAccount(payload);
    if (!r.ok || !r.id) return r;
    const probe = await this.probeCodexToken(String(payload?.email || "").trim(), String(payload?.refreshToken || "").trim());
    if (!probe.valid) {
      setAccountEnabled(this.ctx.dataDir, "codex-accounts.json", r.id, false);
      return { ...r, enabled: false, tokenValid: false, warning: `token 验证失败,已加入但置为停用: ${probe.error}` };
    }
    return { ...r, tokenValid: true };
  }

  /**
   * Upsert one normalized candidate into an in-memory accounts array (no write).
   * Returns either the row outcome or an `error` describing why it was skipped.
   */
  private upsertCodexAccount(accounts: any[], fields: CodexImportFields) {
    if (!fields.email) return { error: "email 不能为空" };
    if (!fields.refreshToken && !fields.accessToken && !fields.sessionToken) {
      return { error: "缺少可用 token" };
    }
    const existing = accounts.find(
      (account: any) => String(account.email || "").toLowerCase() === fields.email.toLowerCase(),
    );
    const updates: Record<string, unknown> = { enabled: fields.enabled };
    if (fields.alias) updates.alias = fields.alias;
    if (fields.planType) updates.planType = fields.planType;
    if (fields.refreshToken) updates.refreshToken = fields.refreshToken;
    if (fields.accessToken) updates.accessToken = fields.accessToken;
    if (Number.isFinite(fields.accessTokenExpiresAt) && fields.accessTokenExpiresAt > 0) {
      updates.accessTokenExpiresAt = fields.accessTokenExpiresAt;
    }
    if (fields.sessionToken) updates.sessionToken = fields.sessionToken;
    // Allowlisted extras (quota / reset times) — disjoint from the core keys above.
    Object.assign(updates, fields.extra);

    let accountId: number;
    if (existing) {
      Object.assign(existing, updates);
      accountId = Number(existing.id);
    } else {
      const maxId = accounts.reduce((max: number, account: any) => Math.max(max, Number(account.id || 0)), 0);
      accountId = maxId + 1;
      accounts.push({ id: accountId, email: fields.email, alias: "", planType: "", refreshToken: "", ...updates });
    }
    return { id: accountId, email: fields.email, isUpdate: Boolean(existing), hasRefreshToken: Boolean(fields.refreshToken) };
  }

  importCodexAccountFromText(payload: any) {
    const parsed = parseJsonFromText(String(payload?.text || payload?.json || ""));
    if (!parsed || typeof parsed !== "object") return { ok: false, error: "未找到有效 JSON" };
    const fields = extractCodexImportFields(firstCodexImportCandidate(parsed));
    // Legacy override: callers may force the enabled flag regardless of the source.
    if (payload?.enabled !== undefined) fields.enabled = payload.enabled !== false;

    const filePath = path.join(this.ctx.dataDir, "codex-accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const r = this.upsertCodexAccount(accounts, fields);
    if ("error" in r) return { ok: false, error: r.error };
    writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });
    return { ok: true, id: r.id, email: r.email, isUpdate: r.isUpdate, totalAccounts: accounts.length, hasRefreshToken: r.hasRefreshToken };
  }

  /** Export the full codex pool for backup / migration. Lossless: every stored
   *  field (tokens, 额度百分比/reset 时间, modelQuota*) is emitted verbatim so the
   *  blob re-imports without dropping anything via importCodexAccountsFromText. */
  exportCodexAccounts() {
    const filePath = path.join(this.ctx.dataDir, "codex-accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts = (Array.isArray(data.accounts) ? data.accounts : []).map((account: any) => ({
      ...account,
      id: Number(account.id || 0),
      email: String(account.email || ""),
      enabled: account.enabled !== false,
    }));
    return { ok: true, type: "codex-accounts-export", exportedAt: nowIso(), count: accounts.length, accounts };
  }

  /** Import one OR many codex accounts from pasted text. Accepts the export
   *  shape `{ accounts: [...] }`, a bare array, or a single object; upserts each
   *  by email. Writes once and returns a per-row summary. */
  importCodexAccountsFromText(payload: any) {
    const parsed = parseJsonFromText(String(payload?.text || payload?.json || ""));
    if (!parsed || typeof parsed !== "object") return { ok: false, error: "未找到有效 JSON" };
    const candidates = collectCodexImportCandidates(parsed);
    if (!candidates.length) return { ok: false, error: "未找到账号数据" };

    const filePath = path.join(this.ctx.dataDir, "codex-accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const results: any[] = [];
    let added = 0;
    let updated = 0;
    let failed = 0;
    for (const source of candidates) {
      const fields = extractCodexImportFields(source);
      const r = this.upsertCodexAccount(accounts, fields);
      if ("error" in r) {
        failed += 1;
        results.push({ ok: false, email: fields.email || "", error: r.error });
        continue;
      }
      if (r.isUpdate) updated += 1;
      else added += 1;
      results.push({ ok: true, id: r.id, email: r.email, isUpdate: r.isUpdate, hasRefreshToken: r.hasRefreshToken });
    }
    writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });
    return { ok: true, bulk: true, added, updated, failed, totalAccounts: accounts.length, results };
  }

  /** codex-import-account + 入库探活(后台入口用;仅当带 refresh_token 时可验证)。 */
  async importCodexAccountCheckedFromText(payload: any) {
    const r = this.importCodexAccountFromText(payload);
    if (!r.ok || !r.id || !r.hasRefreshToken) return r;
    const probe = await this.probeCodexToken(String(r.email || ""), String(payload?.refreshToken || "").trim() || this.codexRefreshTokenOf(r.id));
    if (!probe.valid) {
      setAccountEnabled(this.ctx.dataDir, "codex-accounts.json", r.id, false);
      return { ...r, enabled: false, tokenValid: false, warning: `token 验证失败,已加入但置为停用: ${probe.error}` };
    }
    return { ...r, tokenValid: true };
  }

  /**
   * Backend import entry: transparently handles a single pasted token JSON or a
   * whole exported pool. One candidate falls back to the single-account flow
   * (preserving its response shape); many candidates run the bulk importer and
   * probe each refresh_token in parallel, disabling any that fail validation.
   */
  async importCodexAccountsCheckedFromText(payload: any) {
    const parsed = parseJsonFromText(String(payload?.text || payload?.json || ""));
    if (!parsed || typeof parsed !== "object") return { ok: false, error: "未找到有效 JSON" };
    const candidates = collectCodexImportCandidates(parsed);
    if (candidates.length <= 1) return this.importCodexAccountCheckedFromText(payload);

    const r = this.importCodexAccountsFromText(payload);
    if (!r.ok || !Array.isArray(r.results)) return r;
    let disabled = 0;
    await Promise.all(
      r.results
        .filter((row: any) => row.ok && row.hasRefreshToken)
        .map(async (row: any) => {
          const probe = await this.probeCodexToken(String(row.email || ""), this.codexRefreshTokenOf(row.id));
          if (!probe.valid) {
            setAccountEnabled(this.ctx.dataDir, "codex-accounts.json", row.id, false);
            row.tokenValid = false;
            row.warning = probe.error;
            disabled += 1;
          } else {
            row.tokenValid = true;
          }
        }),
    );
    return { ...r, disabled };
  }

  /** 读取 codex 账号当前的 refreshToken(导入时 token 在 JSON 文本里,这里兜底从落盘取)。 */
  private codexRefreshTokenOf(accountId: number): string {
    const data = readJson(path.join(this.ctx.dataDir, "codex-accounts.json"), { accounts: [] });
    const acc = (Array.isArray(data.accounts) ? data.accounts : []).find((a: any) => Number(a.id) === accountId);
    return String(acc?.refreshToken || "");
  }

  /** codex:用 refresh_token 刷一次 access_token,验证有效性(强制刷新,不吃缓存)。 */
  private async probeCodexToken(
    email: string,
    refreshToken: string,
  ): Promise<{ valid: boolean; error?: string }> {
    try {
      await refreshCodexAccessToken({ email, refreshToken } as any);
      return { valid: true };
    } catch (err: any) {
      return { valid: false, error: String(err?.message || err) };
    }
  }

  /**
   * 后台「刷新」(codex 单账号)= 强制刷新 token + 拉额度。先刷 token(回写 access/refresh
   * token + 到期),再用新 token 拉上游 wham/usage 落盘 5h/周余量。token 刷新成功即算成功:
   * 额度接口失败(如号被上游封)只回带 quotaError,不否定 token 已刷新这件事。
   */
  async refreshCodexAccountQuota(payload: any) {
    const accountId = Number(payload?.accountId);
    const filePath = path.join(this.ctx.dataDir, "codex-accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts: any[] = Array.isArray(data.accounts) ? data.accounts : [];
    const acc = accounts.find((a: any) => Number(a.id) === accountId);
    if (!acc) return { ok: false, error: "账号不存在" };
    if (!acc.refreshToken) return { ok: false, error: "该账号没有 refreshToken" };
    try {
      // Carry proxyUrl so both the token refresh and the usage probe egress
      // through the account's exit proxy (same IP as inference) when one is set.
      const probe = { email: acc.email, refreshToken: acc.refreshToken, proxyUrl: acc.proxyUrl } as any;
      const token = await refreshCodexAccessToken(probe);
      acc.accessToken = token;
      acc.accessTokenExpiresAt = probe.accessTokenExpiresAt;
      if (probe.refreshToken && probe.refreshToken !== acc.refreshToken) acc.refreshToken = probe.refreshToken;

      const snap = await fetchCodexQuotaUpstream(token, acc.proxyUrl);
      if (!snap) {
        // token 已刷新成功并落盘;仅额度接口失败 → 仍算成功,回带 quotaError 让前端提示。
        writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });
        return { ok: true, email: acc.email, tokenValid: true, quotaError: "上游额度获取失败(usage 接口无数据或被拒)" };
      }
      // 落盘:与 codex.provider.applyQuotaSnapshot 同字段,供血条/选号读取。
      if (snap.planType) acc.planType = snap.planType;
      const cq = snap.codexQuota;
      const weeklyBinds = cq.weeklyPercent < cq.hourlyPercent;
      const bindingPercent = weeklyBinds ? cq.weeklyPercent : cq.hourlyPercent;
      const bindingReset = weeklyBinds ? cq.weeklyResetTime : cq.hourlyResetTime;
      acc.modelQuotaFractions = { codex: bindingPercent / 100 };
      if (bindingReset) acc.modelQuotaResetTimes = { codex: bindingReset };
      acc.modelQuotaRefreshedAt = Date.now();
      acc.codexHourlyPercent = cq.hourlyPercent;
      acc.codexWeeklyPercent = cq.weeklyPercent;
      acc.codexHourlyResetTime = cq.hourlyResetTime || "";
      acc.codexWeeklyResetTime = cq.weeklyResetTime || "";
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

  async startCodexOAuthLogin() {
    const existing = this.codexOAuthPending;
    if (existing && existing.status === "pending" && existing.expiresAt > Date.now()) {
      return {
        ok: true,
        loginId: existing.loginId,
        authUrl: existing.authUrl,
        redirectUri: existing.redirectUri,
        expiresAt: existing.expiresAt,
      };
    }
    this.closeCodexOAuthPending();

    const codeVerifier = base64Url(crypto.randomBytes(32));
    const state = base64Url(crypto.randomBytes(32));
    const loginId = base64Url(crypto.randomBytes(18));
    const redirectUri = `http://localhost:${this.ctx.codexOAuthPort}/auth/callback`;
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CODEX_OAUTH_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: CODEX_OAUTH_SCOPES,
      code_challenge: codeChallenge(codeVerifier),
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      state,
      originator: CODEX_OAUTH_ORIGINATOR,
    });

    const pending: CodexOAuthPending = {
      loginId,
      state,
      codeVerifier,
      redirectUri,
      authUrl: `${CODEX_OAUTH_AUTH_ENDPOINT}?${params.toString()}`,
      expiresAt: Date.now() + CODEX_OAUTH_TIMEOUT_MS,
      status: "pending",
    };

    // 不起本地回调 server:授权完成后由用户把回调 URL / 授权码粘回后台,
    // 走 submitCodexOAuthCallback 在服务端换 token,远程后台也能用,
    // 不依赖「点授权那台机器上的 localhost:1455」。
    this.codexOAuthPending = pending;
    return {
      ok: true,
      loginId,
      authUrl: pending.authUrl,
      redirectUri,
      expiresAt: pending.expiresAt,
    };
  }

  getCodexOAuthLoginStatus(loginId: string) {
    const pending = this.codexOAuthPending;
    if (!pending || pending.loginId !== loginId) return { ok: false, status: "missing", error: "login session not found" };
    if (pending.status === "pending" && pending.expiresAt <= Date.now()) {
      pending.status = "failed";
      pending.error = "OAuth login timed out";
      this.closeCodexOAuthPending(false);
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

  cancelCodexOAuthLogin(loginId: string) {
    if (this.codexOAuthPending?.loginId !== loginId) return { ok: false, error: "login session not found" };
    this.closeCodexOAuthPending();
    return { ok: true };
  }

  /**
   * 手动完成 Codex OAuth:用户在浏览器授权后,把回调地址
   * (http://localhost:1455/auth/callback?code=...&state=...) 或其中的授权码粘回后台,
   * 服务端在这里解析出 code 换 token。不再依赖本地回调 server,远程后台也能完成登录。
   * rawInput 接受三种形式:完整回调 URL、query 片段(code=...&state=...)、或纯 code。
   */
  async submitCodexOAuthCallback(loginId: string, rawInput: string) {
    const pending = this.codexOAuthPending;
    if (!pending || pending.loginId !== loginId) {
      return { ok: false, status: "missing", error: "登录会话不存在或已过期,请重新发起 OAuth 登录" };
    }
    if (pending.status !== "pending" || pending.expiresAt <= Date.now()) {
      pending.status = "failed";
      pending.error = pending.error || "OAuth 登录会话已失效,请重新发起";
      this.closeCodexOAuthPending(false);
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
      // 不是完整 URL:可能是 query 片段(code=...&state=...)或纯 code
      if (input.includes("code=")) {
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
      this.closeCodexOAuthPending(false);
      return { ok: false, status: "failed", error: pending.error };
    }

    try {
      const result = await this.completeCodexOAuthLogin(pending, code);
      this.closeCodexOAuthPending(false);
      return { ok: true, status: "completed", email: result.email, isUpdate: result.isUpdate, accountId: result.accountId };
    } catch (error) {
      pending.status = "failed";
      pending.error = error instanceof Error ? error.message : "OAuth 完成失败";
      this.closeCodexOAuthPending(false);
      return { ok: false, status: "failed", error: pending.error };
    }
  }

  private async completeCodexOAuthLogin(pending: CodexOAuthPending, code: string) {
    const body = new URLSearchParams({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.codeVerifier,
    });
    const response = await this.ctx.codexOAuthFetch(CODEX_OAUTH_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Token exchange failed: ${response.status} ${text}`);

    const tokenData = JSON.parse(text);
    const profile = decodeJwtPayload(String(tokenData.id_token || ""));
    const email = String(profile.email || tokenData.email || "").trim();
    if (!email) throw new Error("Token response did not include an email");

    const expiresAt = Date.now() + Number(tokenData.expires_in || 3600) * 1000;
    const result = this.importCodexAccountFromText({
      text: JSON.stringify({
        user: { email, name: profile.name || profile.given_name || "" },
        refreshToken: tokenData.refresh_token || "",
        accessToken: tokenData.access_token || "",
        expiresAt,
      }),
    });
    if (!result.ok) throw new Error(String(result.error || "Failed to save Codex account"));

    pending.status = "completed";
    pending.email = email;
    pending.isUpdate = Boolean(result.isUpdate);
    return { email, isUpdate: Boolean(result.isUpdate), accountId: result.id };
  }

  private closeCodexOAuthPending(clearCompleted = true) {
    const pending = this.codexOAuthPending;
    if (!pending) return;
    if (clearCompleted) this.codexOAuthPending = null;
  }

  toggleCodexAccount(payload: any) {
    const accountId = Number(payload?.accountId);
    const filePath = path.join(this.ctx.dataDir, "codex-accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const account = accounts.find((item: any) => Number(item.id) === accountId);
    if (!account) return { ok: false, error: "账号不存在" };
    account.enabled = !account.enabled;
    writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });
    return { ok: true, email: account.email, enabled: account.enabled };
  }

  toggleCodexAccountPool(payload: any) {
    const accountId = Number(payload?.accountId);
    const filePath = path.join(this.ctx.dataDir, "codex-accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const account = accounts.find((item: any) => Number(item.id) === accountId);
    if (!account) return { ok: false, error: "账号不存在" };
    account.poolEnabled = account.poolEnabled === false ? true : false;
    writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });
    return { ok: true, email: account.email, poolEnabled: account.poolEnabled };
  }

  deleteCodexAccount(payload: any) {
    const accountId = Number(payload?.accountId);
    const filePath = path.join(this.ctx.dataDir, "codex-accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const filtered = accounts.filter((account: any) => Number(account.id) !== accountId);
    if (filtered.length === accounts.length) return { ok: false, error: "账号不存在" };
    writeJson(filePath, { ...data, accounts: filtered, updatedAt: nowIso() });
    this.accessKey.clearBindingsForAccount("codex", accountId);
    return { ok: true, totalAccounts: filtered.length };
  }
}
