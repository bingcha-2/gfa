import * as fs from "fs";
import * as crypto from "crypto";
import * as http from "http";
import * as os from "os";
import * as path from "path";

import { Injectable, Logger, Optional } from "@nestjs/common";
import { AutomationService } from "../automation/automation.service";
import { AgentAccountService } from "../automation/agent-account.service";

import { billableTokenUsageTotal, readTokenCount, tokenWindowLimit, DEFAULT_KEY_WINDOW_MS } from "../token-server/token-billing";
import { getModelQuotaFraction } from "../token-server/lease-scheduler";
import {
  type CachedToken,
  getAccessToken,
  refreshAccessToken,
  fetchAccountHealth,
  fetchAvailableModels,
  discoverProject,
  extractTierFromModelsJson,
  DEFAULT_CLOUD_ENDPOINT,
} from "./google-api";
import { refreshCodexAccessToken } from "../remote-codex/auth/codex-token-provider";
import { fetchCodexQuotaUpstream } from "../remote-codex/auth/codex-usage";

type RosettaServiceOptions = {
  dataDir?: string;
  codexOAuthPort?: number;
  codexOAuthFetch?: typeof fetch;
};

/** Total shares (份) per upstream account. A card consumes `weight` shares:
 * 1 = 拼车 (4 such cards share one account), 4 = 独享 (one card takes the account). */
const ACCOUNT_SHARE_CAPACITY = 4;
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_AUTH_ENDPOINT = "https://auth.openai.com/oauth/authorize";
const CODEX_OAUTH_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const CODEX_OAUTH_SCOPES = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const CODEX_OAUTH_ORIGINATOR = "codex_vscode";
const CODEX_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const CODEX_OAUTH_DEFAULT_CALLBACK_PORT = 1455;

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
  server?: http.Server;
};

/** A card's share weight (份额): 1..4, default 1 (拼车). */
function cardWeight(key: any): number {
  const w = Math.floor(Number(key?.weight || 0));
  if (!Number.isFinite(w) || w < 1) return 1;
  return Math.min(ACCOUNT_SHARE_CAPACITY, w);
}

function defaultDataDir() {
  if (process.env.ROSETTA_DATA_DIR) return process.env.ROSETTA_DATA_DIR;
  const base =
    process.platform === "win32"
      ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support")
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "Antigravity", "rosetta");
}

function readJson(filePath: string, fallback: any) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

/** mtime-based file cache: skips re-read if file hasn't changed on disk. */
class CachedJsonFile {
  private cache: any = null;
  private mtimeMs = 0;

  constructor(private readonly filePath: string, private readonly fallback: any) {}

  read(): any {
    try {
      const stat = fs.statSync(this.filePath);
      if (this.cache !== null && stat.mtimeMs === this.mtimeMs) {
        return this.cache;
      }
      this.mtimeMs = stat.mtimeMs;
    } catch {
      return this.fallback;
    }
    this.cache = readJson(this.filePath, this.fallback);
    return this.cache;
  }

  /** Invalidate cache so next read() re-reads from disk. */
  invalidate() {
    this.cache = null;
  }
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function maskKey(value: unknown) {
  const raw = String(value || "");
  if (raw.length <= 4) return raw ? "***" : "";
  return `${raw.slice(0, 2)}***${raw.slice(-2)}`;
}

function accessKeyExpiresAt(key: any) {
  if (!key?.firstUsedAt || !Number(key.durationMs || 0)) return "";
  return new Date(Date.parse(key.firstUsedAt) + Number(key.durationMs)).toISOString();
}

function recentTokenUsage(key: any, now = Date.now()) {
  const windowMs = Number(key.tokenWindowMs || key.windowMs || DEFAULT_KEY_WINDOW_MS);
  const cutoff = now - windowMs;
  return (Array.isArray(key.tokenUsageEvents) ? key.tokenUsageEvents : [])
    .filter((item: any) => Number(item?.at || 0) >= cutoff)
    .reduce((sum: number, item: any) => {
      const rawTotal =
        readTokenCount(item?.rawTotalTokens) ||
        readTokenCount(item?.totalTokens) ||
        readTokenCount(item?.inputTokens) + readTokenCount(item?.outputTokens);
      return sum + billableTokenUsageTotal({ ...item, rawTotalTokens: rawTotal }, item?.modelKey);
    }, 0);
}

function nowIso() {
  return new Date().toISOString();
}

function newAccessKeyValue() {
  return `BCAI-${crypto.randomBytes(6).toString("hex").toUpperCase()}-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
}

function base64Url(bytes: Buffer) {
  return bytes.toString("base64url");
}

function codeChallenge(codeVerifier: string) {
  return base64Url(crypto.createHash("sha256").update(codeVerifier).digest());
}

function decodeJwtPayload(token: string): any {
  try {
    const payload = token.split(".")[1];
    if (!payload) return {};
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function getStringAt(source: any, pathParts: string[]) {
  let current = source;
  for (const part of pathParts) {
    if (!current || typeof current !== "object") return "";
    current = current[part];
  }
  return typeof current === "string" ? current.trim() : "";
}

function firstString(source: any, paths: string[][]) {
  for (const pathParts of paths) {
    const value = getStringAt(source, pathParts);
    if (value) return value;
  }
  return "";
}

function getNumberAt(source: any, pathParts: string[]): number {
  let current = source;
  for (const part of pathParts) {
    if (!current || typeof current !== "object") return 0;
    current = current[part];
  }
  if (typeof current === "number" && Number.isFinite(current)) return current;
  if (typeof current === "string" && current.trim() !== "" && Number.isFinite(Number(current))) {
    return Number(current);
  }
  return 0;
}

function firstNumber(source: any, paths: string[][]): number {
  for (const pathParts of paths) {
    const value = getNumberAt(source, pathParts);
    if (value > 0) return value;
  }
  return 0;
}

function firstCodexImportCandidate(parsed: any): any {
  if (Array.isArray(parsed)) return parsed[0] || {};
  if (Array.isArray(parsed?.accounts) && parsed.accounts.length > 0) {
    const account = parsed.accounts[0];
    if (account?.credentials && typeof account.credentials === "object") {
      return { ...account, ...account.credentials };
    }
    return account || {};
  }
  if (parsed?.credentials && typeof parsed.credentials === "object") {
    return { ...parsed, ...parsed.credentials };
  }
  return parsed || {};
}

function parseJsonFromText(text: string): any | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue with embedded-object extraction below.
  }

  const start = trimmed.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = inString;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth++;
    if (char === "}") depth--;
    if (depth === 0) {
      try {
        return JSON.parse(trimmed.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

@Injectable()
export class RosettaService {
  private readonly dataDir: string;
  private readonly codexOAuthPort: number;
  private readonly codexOAuthFetch: typeof fetch;
  private readonly logger = new Logger(RosettaService.name);
  /** In-memory access_token cache: accountId → { accessToken, expiresAt } */
  private readonly tokenCache = new Map<number, CachedToken>();
  /** mtime-cached file readers for hot-path list queries */
  private readonly accessKeysFile: CachedJsonFile;
  private readonly accountsFile: CachedJsonFile;
  private codexOAuthPending: CodexOAuthPending | null = null;

  constructor(
    @Optional() options: RosettaServiceOptions = {},
    @Optional() private readonly automation?: AutomationService,
    @Optional() private readonly agentAccounts?: AgentAccountService,
  ) {
    this.dataDir = options.dataDir || defaultDataDir();
    this.codexOAuthPort = Number(options.codexOAuthPort ?? CODEX_OAUTH_DEFAULT_CALLBACK_PORT);
    this.codexOAuthFetch = options.codexOAuthFetch || fetch;
    this.accessKeysFile = new CachedJsonFile(path.join(this.dataDir, "access-keys.json"), { keys: [] });
    this.accountsFile = new CachedJsonFile(path.join(this.dataDir, "accounts.json"), { accounts: [] });
  }

  listAccessKeys(query: { search?: string }) {
    const data = this.accessKeysFile.read();
    const term = String(query.search || "").trim().toLowerCase();
    const keys = (Array.isArray(data.keys) ? data.keys : [])
      .filter((key: any) => {
        if (!term) return true;
        return [key.id, key.key, key.name, key.status, key.sessionClientId]
          .some((value) => String(value || "").toLowerCase().includes(term));
      })
      .map((key: any) => ({
        id: String(key.id || ""),
        name: String(key.name || ""),
        fullKey: String(key.key || ""),
        key: maskKey(key.key),
        status: String(key.status || "active"),
        totalRequests: Number(key.totalRequests || 0),
        totalTokensUsed: Number(key.totalTokensUsed || 0),
        recentWindowTokens: recentTokenUsage(key),
        tokenWindowLimit: tokenWindowLimit(key),
        windowMs: Number(key.windowMs || key.tokenWindowMs || DEFAULT_KEY_WINDOW_MS),
        durationMs: Number(key.durationMs || 0),
        provider: String(key.provider || ""),
        boundAccountId: Number(key.boundAccountId || 0),
        bindings: (key.bindings && typeof key.bindings === "object" ? key.bindings : {}) as Record<string, number>,
        weight: cardWeight(key),
        createdAt: String(key.createdAt || ""),
        lastUsedAt: String(key.lastUsedAt || ""),
        expiresAt: accessKeyExpiresAt(key),
        sessionClientId: String(key.sessionClientId || ""),
        sessionExpiresAt: String(key.sessionExpiresAt || ""),
      }));

    return { ok: true, keys };
  }

  listEmployees() {
    const data = readJson(path.join(this.dataDir, "employees.json"), {
      employees: [],
      accounts: [],
      sessions: [],
    });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const employees = (Array.isArray(data.employees) ? data.employees : []).map((employee: any) => {
      const mine = accounts.filter((account: any) => account.employeeId === employee.id);
      return {
        id: String(employee.id || ""),
        email: String(employee.email || ""),
        status: String(employee.status || "active"),
        createdAt: String(employee.createdAt || ""),
        lastActiveAt: String(employee.lastActiveAt || ""),
        stats: {
          total: mine.length,
          accepted: mine.filter((account: any) => account.status === "accepted").length,
          failed: mine.filter((account: any) => account.status === "failed").length,
          disabled: mine.filter((account: any) => account.status === "disabled").length,
          deleted: mine.filter((account: any) => account.status === "deleted").length,
        },
      };
    });

    return { ok: true, employees, accounts };
  }

  listAccounts() {
    const data = this.accountsFile.read();
    const boundCounts = this.boundCardCounts("antigravity");
    const shares = this.boundSharesByAccount("antigravity");
    const accounts = (Array.isArray(data.accounts) ? data.accounts : []).map((account: any) => ({
      id: Number(account.id || 0),
      email: String(account.email || ""),
      enabled: account.enabled !== false,
      alias: String(account.alias || ""),
      projectId: String(account.projectId || ""),
      planType: String(account.planType || ""),
      oauthProfile: String(account.oauthProfile || ""),
      hasToken: Boolean(account.refreshToken),
      boundCardCount: boundCounts.get(Number(account.id || 0)) || 0,
      usedShares: shares.get(Number(account.id || 0)) || 0,
      shareCapacity: ACCOUNT_SHARE_CAPACITY,
      familyRole: String(account.familyRole || ""),
      familyStatus: String(account.familyStatus || ""),
      motherId: String(account.motherId || ""),
      seatId: String(account.seatId || ""),
    }));
    return { ok: true, accounts, dataDir: this.dataDir };
  }

  addAccount(payload: any) {
    const email = String(payload?.email || "").trim();
    const refreshToken = String(payload?.refreshToken || "").trim();
    if (!email) return { ok: false, error: "email 不能为空" };
    if (!refreshToken) return { ok: false, error: "refreshToken 不能为空" };

    const filePath = path.join(this.dataDir, "accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const existing = accounts.find((account: any) => String(account.email || "").toLowerCase() === email.toLowerCase());
    let accountId: number;
    if (existing) {
      existing.refreshToken = refreshToken;
      existing.enabled = payload.enabled !== undefined ? payload.enabled !== false : true;
      existing.alias = String(payload.alias ?? existing.alias ?? "");
      if (payload.projectId !== undefined) existing.projectId = String(payload.projectId || "");
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
        oauthProfile: String(payload.oauthProfile || "antigravity"),
        projectId: String(payload.projectId || ""),
        planType: String(payload.planType || ""),
      });
    }
    writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });
    return { ok: true, id: accountId, email, isUpdate: Boolean(existing), totalAccounts: accounts.length };
  }

  /** add-account + 入库探活(后台入口用):同步写入后刷一次 token,失败则置停用 + warning。 */
  async addAccountChecked(payload: any) {
    const r = this.addAccount(payload);
    if (!r.ok || !r.id) return r;
    const probe = await this.probeAntigravityToken(
      String(payload?.refreshToken || "").trim(),
      String(payload?.oauthProfile || "antigravity"),
    );
    if (!probe.valid) {
      this.setAccountEnabled("accounts.json", r.id, false);
      return { ...r, enabled: false, tokenValid: false, warning: `token 验证失败,已加入但置为停用: ${probe.error}` };
    }
    return { ...r, tokenValid: true };
  }

  toggleAccount(payload: any) {
    const accountId = Number(payload?.accountId);
    const filePath = path.join(this.dataDir, "accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const account = accounts.find((item: any) => Number(item.id) === accountId);
    if (!account) return { ok: false, error: "账号不存在" };
    account.enabled = !account.enabled;
    writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });
    return { ok: true, email: account.email, enabled: account.enabled };
  }

  deleteAccount(payload: any) {
    const accountId = Number(payload?.accountId);
    const filePath = path.join(this.dataDir, "accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const filtered = accounts.filter((account: any) => Number(account.id) !== accountId);
    if (filtered.length === accounts.length) return { ok: false, error: "账号不存在" };
    writeJson(filePath, { ...data, accounts: filtered, updatedAt: nowIso() });
    this.clearBindingsForAccount("antigravity", accountId);
    return { ok: true, totalAccounts: filtered.length };
  }

  // ── Codex account pool (codex-accounts.json) ────────────────────────────
  // Mirrors the antigravity account methods above but targets the codex pool
  // and omits projectId/oauthProfile (codex accounts don't have them).

  listCodexAccounts() {
    const filePath = path.join(this.dataDir, "codex-accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const boundCounts = this.boundCardCounts("codex");
    const shares = this.boundSharesByAccount("codex");
    const accounts = (Array.isArray(data.accounts) ? data.accounts : []).map((account: any) => ({
      id: Number(account.id || 0),
      email: String(account.email || ""),
      enabled: account.enabled !== false,
      alias: String(account.alias || ""),
      planType: String(account.planType || ""),
      hasToken: Boolean(account.refreshToken || account.accessToken || account.sessionToken),
      boundCardCount: boundCounts.get(Number(account.id || 0)) || 0,
      usedShares: shares.get(Number(account.id || 0)) || 0,
      shareCapacity: ACCOUNT_SHARE_CAPACITY,
      codexHourlyPercent: Number(account.codexHourlyPercent ?? -1),
      codexWeeklyPercent: Number(account.codexWeeklyPercent ?? -1),
      modelQuotaRefreshedAt: Number(account.modelQuotaRefreshedAt || 0),
    }));
    return { ok: true, accounts, dataDir: this.dataDir };
  }

  addCodexAccount(payload: any) {
    const email = String(payload?.email || "").trim();
    const refreshToken = String(payload?.refreshToken || "").trim();
    if (!email) return { ok: false, error: "email 不能为空" };
    if (!refreshToken) return { ok: false, error: "refreshToken 不能为空" };

    const filePath = path.join(this.dataDir, "codex-accounts.json");
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
      this.setAccountEnabled("codex-accounts.json", r.id, false);
      return { ...r, enabled: false, tokenValid: false, warning: `token 验证失败,已加入但置为停用: ${probe.error}` };
    }
    return { ...r, tokenValid: true };
  }

  importCodexAccountFromText(payload: any) {
    const parsed = parseJsonFromText(String(payload?.text || payload?.json || ""));
    if (!parsed || typeof parsed !== "object") return { ok: false, error: "未找到有效 JSON" };
    const source = firstCodexImportCandidate(parsed);

    const email = firstString(source, [["user", "email"], ["profile", "email"], ["email"], ["name"]]);
    const alias = firstString(source, [["user", "name"], ["alias"], ["name"]]);
    const planType = firstString(source, [["account", "planType"], ["planType"], ["plan_type"]]);
    const refreshToken = firstString(source, [["refreshToken"], ["refresh_token"]]);
    const accessToken = firstString(source, [["accessToken"], ["access_token"]]);
    const sessionToken = firstString(source, [["sessionToken"], ["session_token"]]);
    const expires = firstString(source, [["expires"], ["expiresAt"], ["accessTokenExpiresAt"], ["expires_at"], ["expired"]]);
    let accessTokenExpiresAt = expires ? Date.parse(expires) : 0;
    // Some token JSONs express expiry as a numeric epoch instead of a date string;
    // firstString() drops non-strings, so fall back to a numeric read and normalize
    // seconds → milliseconds (heuristic: values below ~1e12 are second-granularity).
    if (!Number.isFinite(accessTokenExpiresAt) || accessTokenExpiresAt <= 0) {
      const numericExpires = firstNumber(source, [["expires"], ["expiresAt"], ["accessTokenExpiresAt"], ["expires_at"], ["exp"]]);
      if (numericExpires > 0) {
        accessTokenExpiresAt = numericExpires < 1e12 ? Math.round(numericExpires * 1000) : numericExpires;
      }
    }

    if (!email) return { ok: false, error: "email 不能为空" };
    if (!refreshToken && !accessToken && !sessionToken) return { ok: false, error: "缺少可用 token" };

    const filePath = path.join(this.dataDir, "codex-accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const existing = accounts.find((account: any) => String(account.email || "").toLowerCase() === email.toLowerCase());
    const updates: Record<string, unknown> = {
      enabled: payload?.enabled !== undefined ? payload.enabled !== false : true,
    };
    if (alias) updates.alias = alias;
    if (planType) updates.planType = planType;
    if (refreshToken) updates.refreshToken = refreshToken;
    if (accessToken) updates.accessToken = accessToken;
    if (Number.isFinite(accessTokenExpiresAt) && accessTokenExpiresAt > 0) {
      updates.accessTokenExpiresAt = accessTokenExpiresAt;
    }
    if (sessionToken) updates.sessionToken = sessionToken;

    let accountId: number;
    if (existing) {
      Object.assign(existing, updates);
      accountId = Number(existing.id);
    } else {
      const maxId = accounts.reduce((max: number, account: any) => Math.max(max, Number(account.id || 0)), 0);
      accountId = maxId + 1;
      accounts.push({
        id: accountId,
        email,
        alias: "",
        planType: "",
        refreshToken: "",
        ...updates,
      });
    }
    writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });
    return { ok: true, id: accountId, email, isUpdate: Boolean(existing), totalAccounts: accounts.length, hasRefreshToken: Boolean(refreshToken) };
  }

  /** codex-import-account + 入库探活(后台入口用;仅当带 refresh_token 时可验证)。 */
  async importCodexAccountCheckedFromText(payload: any) {
    const r = this.importCodexAccountFromText(payload);
    if (!r.ok || !r.id || !r.hasRefreshToken) return r;
    const probe = await this.probeCodexToken(String(r.email || ""), String(payload?.refreshToken || "").trim() || this.codexRefreshTokenOf(r.id));
    if (!probe.valid) {
      this.setAccountEnabled("codex-accounts.json", r.id, false);
      return { ...r, enabled: false, tokenValid: false, warning: `token 验证失败,已加入但置为停用: ${probe.error}` };
    }
    return { ...r, tokenValid: true };
  }

  /** 读取 codex 账号当前的 refreshToken(导入时 token 在 JSON 文本里,这里兜底从落盘取)。 */
  private codexRefreshTokenOf(accountId: number): string {
    const data = readJson(path.join(this.dataDir, "codex-accounts.json"), { accounts: [] });
    const acc = (Array.isArray(data.accounts) ? data.accounts : []).find((a: any) => Number(a.id) === accountId);
    return String(acc?.refreshToken || "");
  }

  /** 通用:把某账号(antigravity accounts.json / codex-accounts.json)的 enabled 置位。 */
  private setAccountEnabled(fileName: string, accountId: number, enabled: boolean) {
    const filePath = path.join(this.dataDir, fileName);
    const data = readJson(filePath, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const acc = accounts.find((a: any) => Number(a.id) === accountId);
    if (!acc) return;
    acc.enabled = enabled;
    writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });
  }

  // ── 探活 + 单账号刷新 token / 获取额度 ───────────────────────────────────
  // 全部手动触发(后台按钮 / 入库探活),不参与任何自动轮询。

  /** antigravity:用 refresh_token 换一次 access_token,验证有效性。 */
  private async probeAntigravityToken(
    refreshToken: string,
    oauthProfile: string,
  ): Promise<{ valid: boolean; error?: string }> {
    try {
      await refreshAccessToken(refreshToken, oauthProfile);
      return { valid: true };
    } catch (err: any) {
      return { valid: false, error: String(err?.message || err) };
    }
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
   * 后台「刷新」(antigravity 单账号)= 强制刷新 token + 拉额度(二者本是一件事:
   * 拉额度必须先有有效 token)。发现 project → 刷 token → credits/planType + per-model 额度。
   */
  async refreshAccountQuota(payload: any) {
    const accountId = Number(payload?.accountId);
    const accountsFile = path.join(this.dataDir, "accounts.json");
    const quotaFile = path.join(this.dataDir, "quota-data.json");
    const data = readJson(accountsFile, { accounts: [] });
    const accounts: any[] = Array.isArray(data.accounts) ? data.accounts : [];
    const acc = accounts.find((a: any) => Number(a.id) === accountId);
    if (!acc) return { ok: false, error: "账号不存在" };
    if (!acc.refreshToken) return { ok: false, error: "该账号没有 refreshToken" };
    try {
      if (!acc.projectId) await this.tryDiscoverProject(acc);
      if (!acc.projectId) return { ok: false, email: acc.email, error: "无法发现 projectId" };
      this.tokenCache.delete(accountId); // 清缓存 → 强制真正刷一次 token
      const token = await getAccessToken(accountId, acc.refreshToken, acc.oauthProfile, this.tokenCache);
      const health = await fetchAccountHealth(token, acc.projectId, acc.email);
      acc.credits = {
        known: health.credits.known,
        available: health.credits.available,
        creditAmount: health.credits.creditAmount,
        minCreditAmount: health.credits.minCreditAmount,
        paidTierID: health.credits.paidTierID,
        creditsRefreshedAt: new Date().toISOString(),
      };
      if (health.planType && health.planType !== acc.planType) acc.planType = health.planType;

      const modelsResult = await fetchAvailableModels(token, acc.projectId);
      if (modelsResult) {
        const detectedTier = extractTierFromModelsJson(modelsResult.rawJson);
        if (detectedTier && detectedTier !== acc.planType) acc.planType = detectedTier;
        acc.modelQuotaFractions = {};
        acc.modelQuotaResetTimes = {};
        acc.modelQuotaRefreshedAt = Date.now();
        for (const [modelKey, info] of Object.entries(modelsResult.models)) {
          if (info.remainingFraction != null) acc.modelQuotaFractions[modelKey] = info.remainingFraction;
          if (info.resetTime) acc.modelQuotaResetTimes[modelKey] = info.resetTime;
        }
        const quotaData: Record<string, any> = readJson(quotaFile, {});
        quotaData[acc.email] = {
          modelsJson: modelsResult.rawJson,
          refreshedAt: nowIso(),
          alias: acc.alias || "",
          planType: acc.planType || "",
        };
        writeJson(quotaFile, quotaData);
      }
      writeJson(accountsFile, { ...data, accounts, updatedAt: nowIso() });
      return {
        ok: true,
        email: acc.email,
        tokenValid: true,
        planType: acc.planType || "",
        credits: acc.credits,
        modelQuotaFractions: acc.modelQuotaFractions || {},
      };
    } catch (err: any) {
      return { ok: false, email: acc.email, tokenValid: false, error: String(err?.message || err) };
    }
  }

  /**
   * 后台「刷新」(codex 单账号)= 强制刷新 token + 拉额度。先刷 token(回写 access/refresh
   * token + 到期),再用新 token 拉上游 wham/usage 落盘 5h/周余量。token 刷新成功即算成功:
   * 额度接口失败(如号被上游封)只回带 quotaError,不否定 token 已刷新这件事。
   */
  async refreshCodexAccountQuota(payload: any) {
    const accountId = Number(payload?.accountId);
    const filePath = path.join(this.dataDir, "codex-accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts: any[] = Array.isArray(data.accounts) ? data.accounts : [];
    const acc = accounts.find((a: any) => Number(a.id) === accountId);
    if (!acc) return { ok: false, error: "账号不存在" };
    if (!acc.refreshToken) return { ok: false, error: "该账号没有 refreshToken" };
    try {
      const probe = { email: acc.email, refreshToken: acc.refreshToken } as any;
      const token = await refreshCodexAccessToken(probe);
      acc.accessToken = token;
      acc.accessTokenExpiresAt = probe.accessTokenExpiresAt;
      if (probe.refreshToken && probe.refreshToken !== acc.refreshToken) acc.refreshToken = probe.refreshToken;

      const snap = await fetchCodexQuotaUpstream(token);
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
    const redirectUri = `http://localhost:${this.codexOAuthPort}/auth/callback`;
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

    pending.server = await this.listenForCodexOAuthCallback(pending);
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

  private listenForCodexOAuthCallback(pending: CodexOAuthPending) {
    return new Promise<http.Server>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handleCodexOAuthCallback(pending, req, res);
      });
      server.on("error", (error: NodeJS.ErrnoException) => {
        reject(new Error(error.code === "EADDRINUSE"
          ? `Codex OAuth callback port ${this.codexOAuthPort} is already in use`
          : `Codex OAuth callback failed: ${error.message}`));
      });
      server.listen(this.codexOAuthPort, "127.0.0.1", () => resolve(server));
    });
  }

  private async handleCodexOAuthCallback(pending: CodexOAuthPending, req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      const callbackUrl = new URL(req.url || "/", pending.redirectUri);
      if (callbackUrl.pathname !== "/auth/callback") {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      if (pending.status !== "pending" || pending.expiresAt <= Date.now()) {
        throw new Error("OAuth login session is no longer active");
      }
      const state = callbackUrl.searchParams.get("state") || "";
      const code = callbackUrl.searchParams.get("code") || "";
      if (state !== pending.state) throw new Error("OAuth state mismatch");
      if (!code) throw new Error("OAuth callback is missing code");

      const result = await this.completeCodexOAuthLogin(pending, code);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<h1>Codex OAuth saved</h1><p>${result.email} has been added to GFA. You can close this window.</p>`);
    } catch (error) {
      pending.status = "failed";
      pending.error = error instanceof Error ? error.message : "OAuth callback failed";
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(`<h1>Codex OAuth failed</h1><p>${pending.error}</p>`);
    } finally {
      this.closeCodexOAuthPending(false);
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
    const response = await this.codexOAuthFetch(CODEX_OAUTH_TOKEN_ENDPOINT, {
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
    return { email, isUpdate: Boolean(result.isUpdate) };
  }

  private closeCodexOAuthPending(clearCompleted = true) {
    const pending = this.codexOAuthPending;
    if (!pending) return;
    pending.server?.close();
    pending.server = undefined;
    if (clearCompleted) this.codexOAuthPending = null;
  }

  toggleCodexAccount(payload: any) {
    const accountId = Number(payload?.accountId);
    const filePath = path.join(this.dataDir, "codex-accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const account = accounts.find((item: any) => Number(item.id) === accountId);
    if (!account) return { ok: false, error: "账号不存在" };
    account.enabled = !account.enabled;
    writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });
    return { ok: true, email: account.email, enabled: account.enabled };
  }

  deleteCodexAccount(payload: any) {
    const accountId = Number(payload?.accountId);
    const filePath = path.join(this.dataDir, "codex-accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const filtered = accounts.filter((account: any) => Number(account.id) !== accountId);
    if (filtered.length === accounts.length) return { ok: false, error: "账号不存在" };
    writeJson(filePath, { ...data, accounts: filtered, updatedAt: nowIso() });
    this.clearBindingsForAccount("codex", accountId);
    return { ok: true, totalAccounts: filtered.length };
  }

  createAccessKey(payload: any) {
    const filePath = path.join(this.dataDir, "access-keys.json");
    const data = readJson(filePath, { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];

    // Batch minting: count > 1 creates N independent cards sharing the same
    // limits. An explicit id/key only applies to a single card (count 1).
    const count = Math.max(1, Math.min(200, Number(payload?.count) || 1));

    // Products the card is sold for; each auto-binds one open-seat account at
    // mint time. Pre-assign all seats so the batch is atomic (no half-mint when
    // a pool runs out).
    const products: string[] = Array.isArray(payload?.products)
      ? payload.products.map((p: unknown) => String(p)).filter((p: string) => p === "codex" || p === "antigravity")
      : [];
    // Membership level (planType) chosen per product — REQUIRED for every
    // selected product. Auto-bind only considers accounts of the exact level.
    const levels: Record<string, string> =
      payload?.levels && typeof payload.levels === "object" ? payload.levels : {};
    // Share weight (份额): 1 = 拼车 (default), 4 = 独享.
    const weight = cardWeight({ weight: payload?.weight });
    const seatPlan: Record<string, number[]> = {};
    for (const product of products) {
      const label = product === "codex" ? "Codex" : "Antigravity";
      const level = String(levels[product] || "").trim();
      if (!level) return { ok: false, error: `请为 ${label} 选择会员等级` };
      const seats = this.autoAssignSeats(product, count, weight, level);
      if (!seats) {
        return {
          ok: false,
          error: `${label} ${level} 等级可用账号不足（无配额充足且份额足够的号），请增加该等级账号`,
        };
      }
      seatPlan[product] = seats;
    }

    const created: any[] = [];
    for (let i = 0; i < count; i++) {
      const single = count === 1;
      const bindings: Record<string, number> = {};
      for (const product of products) bindings[product] = seatPlan[product][i];
      const record = {
        id: String((single && payload?.id) || `card_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`),
        key: String((single && payload?.key) || newAccessKeyValue()),
        name: String(payload?.name || ""),
        status: String(payload?.status || "active"),
        durationMs: Number(payload?.durationMs || 60 * 60 * 1000),
        windowLimit: Number(payload?.windowLimit || 0),
        tokenWindowLimit: Number(payload?.tokenWindowLimit || 0),
        // Per-card rate-limit window duration (configurable hours/days, set at
        // creation). Drives the fixed-period reset in resetWindowIfExpired().
        windowMs: Math.max(0, Number(payload?.windowMs || 0)) || DEFAULT_KEY_WINDOW_MS,
        weight,
        ...(products.length ? { bindings } : {}),
        createdAt: nowIso(),
      };
      keys.push(record);
      created.push(record);
    }
    writeJson(filePath, { ...data, keys, updatedAt: nowIso() });
    const publicKeys = created.map((record) => this.publicAccessKey(record));
    return { ok: true, key: publicKeys[0], keys: publicKeys, totalKeys: keys.length };
  }

  updateAccessKey(payload: any) {
    const id = String(payload?.id || "");
    const filePath = path.join(this.dataDir, "access-keys.json");
    const data = readJson(filePath, { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const record = keys.find((key: any) => String(key.id) === id);
    if (!record) return { ok: false, error: "卡密不存在" };
    for (const field of ["name", "status", "durationMs", "windowLimit", "tokenWindowLimit", "windowMs"]) {
      if (payload[field] !== undefined) record[field] = field.endsWith("Ms") || field.endsWith("Limit")
        ? Number(payload[field])
        : String(payload[field]);
    }
    writeJson(filePath, { ...data, keys, updatedAt: nowIso() });
    return { ok: true, key: this.publicAccessKey(record) };
  }

  deleteAccessKey(payload: any) {
    const id = String(payload?.id || "");
    const filePath = path.join(this.dataDir, "access-keys.json");
    const data = readJson(filePath, { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const filtered = keys.filter((key: any) => String(key.id) !== id);
    if (filtered.length === keys.length) return { ok: false, error: "卡密不存在" };
    writeJson(filePath, { ...data, keys: filtered, updatedAt: nowIso() });
    return { ok: true, totalKeys: filtered.length };
  }

  // ── Static card → account binding ───────────────────────────────────────
  // A card may be bound to exactly one upstream account; an account holds at
  // most MAX_CARDS_PER_ACCOUNT cards (= users). Binding is provider-scoped: the
  // antigravity and codex pools allocate ids independently, so (provider, id) is
  // the real key. See AccessKeyStore.boundAccountIdFor / LeaseService.leaseToken.

  /** Shares already consumed on an account (sum of bound cards' weights), excluding `excludeId`. */
  private usedShares(provider: string, accountId: number, excludeId = ""): number {
    const data = readJson(path.join(this.dataDir, "access-keys.json"), { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    let used = 0;
    for (const key of keys) {
      if (String(key.id) !== excludeId && this.keyBoundAccount(key, provider) === accountId) {
        used += cardWeight(key);
      }
    }
    return used;
  }

  /** Resolve a card's bound account in a pool: bindings map first, legacy fallback. */
  private keyBoundAccount(key: any, provider: string): number {
    const fromMap = Number(key?.bindings?.[provider] || 0);
    if (fromMap > 0) return fromMap;
    return String(key?.provider || "") === provider ? Number(key?.boundAccountId || 0) : 0;
  }

  /** Count cards bound to each account id within a pool. */
  private boundCardCounts(provider: string): Map<number, number> {
    const data = readJson(path.join(this.dataDir, "access-keys.json"), { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const counts = new Map<number, number>();
    for (const key of keys) {
      const accountId = this.keyBoundAccount(key, provider);
      if (accountId > 0) counts.set(accountId, (counts.get(accountId) || 0) + 1);
    }
    return counts;
  }

  bindAccessKey(payload: any) {
    const id = String(payload?.id || "");
    const provider = String(payload?.provider || "").trim();
    const accountId = Number(payload?.accountId || 0);
    if (!provider) return { ok: false, error: "provider 不能为空" };
    if (!(accountId > 0)) return { ok: false, error: "accountId 无效" };

    const filePath = path.join(this.dataDir, "access-keys.json");
    const data = readJson(filePath, { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const record = keys.find((key: any) => String(key.id) === id);
    if (!record) return { ok: false, error: "卡密不存在" };

    // Count peers already bound to this (provider, account), excluding this card
    // so a re-bind / no-op is idempotent and never trips the limit.
    // Capacity is by SHARES (份): used (excluding this card) + this card's weight ≤ 4.
    const need = cardWeight(record);
    const used = this.usedShares(provider, accountId, id);
    if (used + need > ACCOUNT_SHARE_CAPACITY) {
      return {
        ok: false,
        error: `该账号份额不足（已用 ${used}/${ACCOUNT_SHARE_CAPACITY} 份，本卡需 ${need} 份），无法绑定`,
      };
    }

    record.bindings = { ...(record.bindings || {}), [provider]: accountId };
    writeJson(filePath, { ...data, keys, updatedAt: nowIso() });
    return { ok: true, key: this.publicAccessKey(record) };
  }

  unbindAccessKey(payload: any) {
    const id = String(payload?.id || "");
    const provider = String(payload?.provider || "").trim();
    const filePath = path.join(this.dataDir, "access-keys.json");
    const data = readJson(filePath, { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const record = keys.find((key: any) => String(key.id) === id);
    if (!record) return { ok: false, error: "卡密不存在" };
    if (provider) {
      if (record.bindings) delete record.bindings[provider];
      if (String(record.provider || "") === provider) {
        record.provider = "";
        record.boundAccountId = 0;
      }
    } else {
      record.bindings = {};
      record.provider = "";
      record.boundAccountId = 0;
    }
    writeJson(filePath, { ...data, keys, updatedAt: nowIso() });
    return { ok: true, key: this.publicAccessKey(record) };
  }

  /** Clear bindings that point at a deleted account, so no card is orphaned. */
  private clearBindingsForAccount(provider: string, accountId: number) {
    const filePath = path.join(this.dataDir, "access-keys.json");
    const data = readJson(filePath, { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    let changed = false;
    for (const key of keys) {
      if (this.keyBoundAccount(key, provider) === accountId) {
        if (key.bindings) delete key.bindings[provider];
        if (String(key.provider || "") === provider) {
          key.provider = "";
          key.boundAccountId = 0;
        }
        changed = true;
      }
    }
    if (changed) writeJson(filePath, { ...data, keys, updatedAt: nowIso() });
  }

  /** Account-pool file for a provider. */
  private poolFileFor(provider: string): string {
    return path.join(this.dataDir, provider === "codex" ? "codex-accounts.json" : "accounts.json");
  }

  /** Shares consumed per account in a pool (sum of bound cards' weights). */
  private boundSharesByAccount(provider: string): Map<number, number> {
    const data = readJson(path.join(this.dataDir, "access-keys.json"), { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const m = new Map<number, number>();
    for (const key of keys) {
      const acc = this.keyBoundAccount(key, provider);
      if (acc > 0) m.set(acc, (m.get(acc) || 0) + cardWeight(key));
    }
    return m;
  }

  /**
   * "配额未耗尽" — does the account still have upstream quota to lease?
   * Unknown (no snapshot yet, e.g. a freshly imported account) counts as
   * available so new accounts are bindable; only a KNOWN, fully-drained window
   * excludes it. Codex quota is account-level (the "codex" key); antigravity is
   * per-model, so it's exhausted only when EVERY known model window is drained.
   * getModelQuotaFraction already treats a passed reset time as refilled.
   */
  private accountHasQuota(provider: string, account: any): boolean {
    if (provider === "codex") {
      const f = getModelQuotaFraction(account, "codex");
      return f === null || f > 0;
    }
    const fractions = account?.modelQuotaFractions;
    if (!fractions || typeof fractions !== "object") return true; // unknown → assume ok
    const models = Object.keys(fractions);
    if (!models.length) return true;
    return models.some((model) => {
      const f = getModelQuotaFraction(account, model);
      return f === null || f > 0;
    });
  }

  /**
   * Can a card be auto-bound to this account? Mirrors the lease-time eligibility
   * (enabled + token + provider-specific eligibility) AND the mint-time policy:
   * exact membership-level (planType) match + quota not exhausted.
   */
  private isAccountBindable(provider: string, account: any, level: string): boolean {
    if (account?.enabled === false) return false;
    if (!(account?.refreshToken || account?.accessToken)) return false;
    if (provider === "antigravity" && !String(account?.projectId || "").trim()) return false;
    if (String(account?.planType || "") !== level) return false;
    return this.accountHasQuota(provider, account);
  }

  /**
   * Auto-assign accounts for `count` cards each consuming `weight` shares,
   * spreading across accounts (most free shares first). Only accounts of the
   * requested membership `level` that are currently bindable (enabled, has a
   * token, eligible, quota not exhausted) are candidates. Returns one accountId
   * per card, or null if no such account has room — callers treat null as "该
   * 等级可用号不足, add more first" and do NOT mint.
   */
  private autoAssignSeats(provider: string, count: number, weight: number, level: string): number[] | null {
    const pool = readJson(this.poolFileFor(provider), { accounts: [] });
    const accounts = (Array.isArray(pool.accounts) ? pool.accounts : []).filter(
      (a: any) => this.isAccountBindable(provider, a, level),
    );
    const shares = this.boundSharesByAccount(provider);
    const remaining: { id: number; free: number }[] = accounts.map((a: any) => ({
      id: Number(a.id),
      free: ACCOUNT_SHARE_CAPACITY - (shares.get(Number(a.id)) || 0),
    }));
    const assigned: number[] = [];
    for (let i = 0; i < count; i++) {
      // Best-fit: among accounts that still have room (free >= weight), pick the
      // one with the SMALLEST free (tightest fit, tie-break by id). This packs
      // 拼车 cards tightly and keeps whole accounts free for 独享 (4-share) cards,
      // instead of scattering across the emptiest accounts.
      const fit = remaining
        .filter((r) => r.free >= weight)
        .sort((a, b) => a.free - b.free || a.id - b.id)[0];
      if (!fit) return null; // 没有号还剩 `weight` 份
      fit.free -= weight;
      assigned.push(fit.id);
    }
    return assigned;
  }

  cleanupExpiredKeys() {
    const filePath = path.join(this.dataDir, "access-keys.json");
    const data = readJson(filePath, { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const now = Date.now();
    const filtered = keys.filter((key: any) => {
      // Explicitly expired status
      if (String(key.status || "").toLowerCase() === "expired") return false;
      // Compute expiresAt from firstUsedAt + durationMs
      if (key.firstUsedAt && Number(key.durationMs || 0) > 0) {
        const expiresAt = Date.parse(key.firstUsedAt) + Number(key.durationMs);
        if (expiresAt <= now) return false;
      }
      return true;
    });
    const deleted = keys.length - filtered.length;
    if (deleted > 0) {
      writeJson(filePath, { ...data, keys: filtered, updatedAt: nowIso() });
    }
    return { ok: true, deleted };
  }

  cleanupUnboundKeys() {
    const filePath = path.join(this.dataDir, "access-keys.json");
    const data = readJson(filePath, { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const filtered = keys.filter((key: any) => {
      const clientId = String(key.sessionClientId || "").trim();
      return clientId.length > 0;
    });
    const deleted = keys.length - filtered.length;
    if (deleted > 0) {
      writeJson(filePath, { ...data, keys: filtered, updatedAt: nowIso() });
    }
    return { ok: true, deleted };
  }

  getThrottleConfig() {
    const filePath = path.join(this.dataDir, "throttle-config.json");
    if (!fs.existsSync(filePath)) return { ok: true, config: null, path: filePath };
    return { ok: true, config: readJson(filePath, null), path: filePath };
  }

  saveThrottleConfig(payload: any) {
    const filePath = path.join(this.dataDir, "throttle-config.json");
    if (payload?.delete) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return { ok: true, deleted: true };
    }
    if (!payload?.config || typeof payload.config !== "object") return { ok: false, error: "config object is required" };
    writeJson(filePath, payload.config);
    return { ok: true, saved: true, path: filePath };
  }

  private publicAccessKey(key: any) {
    return this.listAccessKeys({}).keys.find((item: { id: string }) => item.id === String(key.id)) || {
      id: String(key.id || ""),
      fullKey: String(key.key || ""),
      key: maskKey(key.key),
      name: String(key.name || ""),
      status: String(key.status || "active"),
    };
  }

  // ── Captcha Unblock ──────────────────────────────────────────────

  private get captchaFile() {
    return path.join(this.dataDir, "captcha-unblock.json");
  }

  async createCaptchaUnblock(payload: any) {
    let creds = payload?.credentials;
    let inputPhones = payload?.phones || [];

    if (!creds && Array.isArray(payload?.accounts) && payload.accounts.length > 0) {
      const acc = payload.accounts[0];
      creds = {
        email: acc.email,
        password: acc.password,
        recoveryEmail: acc.recoveryEmail,
        totpSecret: acc.totpSecret,
      };
      if (acc.phone) {
        inputPhones = [{
          phoneNumber: acc.phone,
          smsUrl: acc.smsUrl || "",
        }];
      }
    }

    if (!creds?.email || !creds?.password) return { ok: false, error: "email and password required" };

    const data = readJson(this.captchaFile, { tasks: [], phase2: [] });
    
    const normalizeEmail = (e: string) => String(e || "").trim().toLowerCase();
    const emailNorm = normalizeEmail(creds.email);
    const phase = String(payload.phase || "first");
    const source = phase === "second" ? "captcha-unblock-phase2" : "captcha-unblock";

    const task: any = {
      id: `unblock_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`,
      email: creds.email,
      password: creds.password,
      recoveryEmail: creds.recoveryEmail || "",
      totpSecret: creds.totpSecret || "",
      phones: inputPhones,
      phase,
      source,
      status: "PENDING",
      createdAt: nowIso(),
      lastErrorMessage: "",
      lastErrorCode: "",
      usedPhone: "",
    };

    // For phase 2, try to find existing phase 1 task to get usedPhone
    if (phase === "second") {
      const existing = (data.tasks || []).find(
        (t: any) => normalizeEmail(t.email) === emailNorm && t.usedPhone && t.status === "WAITING_SECOND_VERIFY"
      );
      if (existing) {
        task.usedPhone = existing.usedPhone;
        existing.status = "PHASE2_STARTED";
        existing.updatedAt = nowIso();
      }
    }

    data.tasks.push(task);

    // Keep last 500 tasks
    if (data.tasks.length > 500) {
      data.tasks = data.tasks.slice(-500);
    }

    writeJson(this.captchaFile, data);

    // Submit to backend worker queue
    if (this.automation) {
      try {
        const autoResult = await this.automation.startAutomation(
          "oauth",
          {
            email: creds.email,
            password: creds.password,
            recoveryEmail: creds.recoveryEmail || "",
            totpSecret: creds.totpSecret || "",
          },
          task.phones?.map((p: any) => ({
            phoneNumber: p.phoneNumber,
            countryCode: p.countryCode ?? "+1",
            smsUrl: p.smsUrl || "",
          })),
          undefined,
          {
            source,
            keepBrowserOpenOnChallenge: true,
          }
        );
        if (autoResult?.taskId) {
          task.taskId = autoResult.taskId;
          task.status = "RUNNING";
          task.updatedAt = nowIso();
          writeJson(this.captchaFile, data);
        }
      } catch (err: any) {
        this.logger.warn(`[captcha-unblock] Failed to submit to queue for ${creds.email}: ${err.message}`);
      }
    }

    return { ok: true, taskId: task.id, email: task.email };
  }

  async getCaptchaUnblockStatus() {
    const data = readJson(this.captchaFile, { tasks: [], phase2: [] });

    // Sync status from DB for running/pending tasks
    if (this.automation) {
      for (const task of (data.tasks || [])) {
        if (task.taskId && ["RUNNING", "PENDING"].includes(task.status)) {
          try {
            const taskData = await this.automation.getTaskStatus(task.taskId);
            if (taskData) {
              const backendStatus = String(taskData.status || "");
              if (backendStatus === "SUCCESS") {
                task.status = task.phase === "second" ? "UNBLOCKED" : "APPEAL_REQUIRED";
                task.updatedAt = nowIso();
              } else if (backendStatus === "MANUAL_REVIEW") {
                const code = String(taskData.lastErrorCode || "");
                if (code === "PHONE_VERIFIED_APPEAL_REQUIRED") {
                  task.status = "APPEAL_REQUIRED";
                  // Extract used phone from task result
                  const res = taskData.result as any;
                  if (res?.usedPhone?.phoneNumber) {
                    task.usedPhone = res.usedPhone.phoneNumber;
                  } else if (res?.usedPhone) {
                    task.usedPhone = res.usedPhone;
                  }
                } else if (code === "CAPTCHA") {
                  task.status = "CAPTCHA_WAITING";
                } else {
                  task.status = "MANUAL_REVIEW";
                  task.lastErrorCode = code;
                  task.lastErrorMessage = taskData.lastErrorMessage || "";
                }
                task.updatedAt = nowIso();
              } else if (backendStatus === "FAILED_FINAL" || backendStatus === "FAILED_RETRYABLE") {
                task.status = "FAILED_FINAL";
                task.lastErrorCode = taskData.lastErrorCode || "";
                task.lastErrorMessage = taskData.lastErrorMessage || "";
                task.updatedAt = nowIso();
              }
            }
          } catch (err) {
            // silent
          }
        }
      }
      writeJson(this.captchaFile, data);
    }

    // Split into active tasks and phase2 waiting
    const tasks = (data.tasks || []).filter((t: any) => t.status !== "WAITING_SECOND_VERIFY");
    const phase2 = (data.tasks || []).filter((t: any) => t.status === "WAITING_SECOND_VERIFY" || t.status === "APPEAL_REQUIRED");

    return { ok: true, tasks, phase2 };
  }

  async retryCaptchaUnblock(payload: any) {
    const taskId = String(payload?.taskId || "");
    const data = readJson(this.captchaFile, { tasks: [], phase2: [] });
    const task = (data.tasks || []).find((t: any) => t.id === taskId);
    if (!task) return { ok: false, error: "task not found" };

    task.status = "PENDING";
    task.lastErrorMessage = "";
    task.lastErrorCode = "";
    task.updatedAt = nowIso();
    writeJson(this.captchaFile, data);

    // Re-submit to automation service
    if (this.automation) {
      try {
        const autoResult = await this.automation.startAutomation(
          "oauth",
          {
            email: task.email,
            password: task.password,
            recoveryEmail: task.recoveryEmail || "",
            totpSecret: task.totpSecret || "",
          },
          task.phones?.map((p: any) => ({
            phoneNumber: p.phoneNumber,
            countryCode: p.countryCode ?? "+1",
            smsUrl: p.smsUrl || "",
          })),
          undefined,
          {
            source: task.source || "captcha-unblock",
            keepBrowserOpenOnChallenge: true,
          }
        );
        if (autoResult?.taskId) {
          task.taskId = autoResult.taskId;
          task.status = "RUNNING";
          task.updatedAt = nowIso();
          writeJson(this.captchaFile, data);
        }
      } catch (err: any) {
        this.logger.warn(`[captcha-unblock] Retry submit failed for ${task.email}: ${err.message}`);
      }
    }

    return { ok: true, taskId };
  }

  // ── Location Unblock ─────────────────────────────────────────────

  unblockLocation() {
    const accountsFile = path.join(this.dataDir, "accounts.json");
    const data = readJson(accountsFile, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    let unblocked = 0;
    for (const acc of accounts) {
      if (acc.quotaStatusReason === "location_unsupported") {
        delete acc.quotaStatusReason;
        delete acc.quotaStatus;
        delete acc.blockedUntil;
        unblocked++;
      }
    }
    if (unblocked > 0) writeJson(accountsFile, { ...data, accounts, updatedAt: nowIso() });
    return { ok: true, unblocked };
  }

  // ── Refresh Credits / Quota ──────────────────────────────────────

  /** Run async tasks with limited concurrency */
  private async runConcurrent<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
    const queue = [...items];
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item) await fn(item);
      }
    });
    await Promise.all(workers);
  }

  /**
   * Refresh AI credits (GOOGLE_ONE_AI) + planType for all enabled accounts.
   * Calls loadCodeAssist API for each account — mirrors token-manager.js:autoFetchPlanTypes().
   */
  async refreshCredits() {
    const filePath = path.join(this.dataDir, "accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts: any[] = Array.isArray(data.accounts) ? data.accounts : [];
    const enabled = accounts.filter((a) => a.enabled !== false && a.refreshToken);

    let refreshed = 0;
    let errors = 0;
    const results: any[] = [];

    await this.runConcurrent(enabled, 5, async (acc) => {
      try {
        // Auto-discover projectId if missing
        if (!acc.projectId) {
          await this.tryDiscoverProject(acc);
        }
        if (!acc.projectId) {
          results.push({ id: acc.id, email: acc.email, error: "no projectId" });
          errors++;
          return;
        }

        const token = await getAccessToken(
          Number(acc.id), acc.refreshToken, acc.oauthProfile, this.tokenCache,
        );
        const health = await fetchAccountHealth(token, acc.projectId, acc.email);

        // Update credits even when GOOGLE_ONE_AI is absent, so stale "exhausted"
        // values do not survive a successful refresh with unknown credit data.
        acc.credits = {
          known: health.credits.known,
          available: health.credits.available,
          creditAmount: health.credits.creditAmount,
          minCreditAmount: health.credits.minCreditAmount,
          paidTierID: health.credits.paidTierID,
          creditsRefreshedAt: new Date().toISOString(),
        };

        // Update planType (detect upgrades)
        if (health.planType) {
          const oldPlan = acc.planType || "";
          if (oldPlan !== health.planType) {
            this.logger.log(`${acc.email}: plan ${oldPlan || "(empty)"} → ${health.planType}`);
            acc.planType = health.planType;
            // Plan upgrade → clear quota blocks
            if (oldPlan && oldPlan !== health.planType) {
              delete acc.quotaStatus;
              delete acc.quotaStatusReason;
              delete acc.exhaustedAt;
              delete acc.exhaustedUntil;
              acc.blockedModels = [];
              this.logger.log(`${acc.email}: plan upgrade, cleared blocks`);
            }
          }
        }

        refreshed++;
        results.push({
          id: acc.id,
          email: acc.email,
          planType: acc.planType || "",
          credits: health.credits,
        });
      } catch (err: any) {
        errors++;
        this.logger.warn(`refreshCredits ${acc.email}: ${err.message}`);
        results.push({ id: acc.id, email: acc.email, error: err.message });
      }
    });

    // Persist
    writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });

    return { ok: true, refreshed, errors, total: enabled.length, accounts: results };
  }

  /**
   * Refresh per-model quota (fetchAvailableModels) + credits for all enabled accounts.
   * Full refresh: Phase 1 discover projects, Phase 2+3 credits + model quota (concurrent).
   * Mirrors quota-poller.js:pollAll() + token-manager.js:autoFetchPlanTypes().
   */
  async refreshQuota() {
    const accountsFile = path.join(this.dataDir, "accounts.json");
    const quotaFile = path.join(this.dataDir, "quota-data.json");
    const data = readJson(accountsFile, { accounts: [] });
    const accounts: any[] = Array.isArray(data.accounts) ? data.accounts : [];
    const enabled = accounts.filter((a) => a.enabled !== false && a.refreshToken);

    // Phase 1: Auto-discover projectId for accounts that lack one
    const needsDiscovery = enabled.filter((a) => !a.projectId);
    if (needsDiscovery.length > 0) {
      this.logger.log(`Phase 1: discovering projects for ${needsDiscovery.length} account(s)...`);
      await this.runConcurrent(needsDiscovery, 3, (acc) => this.tryDiscoverProject(acc));
    }

    // Re-filter for accounts with projectId
    const ready = enabled.filter((a) => a.projectId);

    let refreshed = 0;
    let errors = 0;

    // Load existing quota-data.json
    const quotaData: Record<string, any> = readJson(quotaFile, {});

    await this.runConcurrent(ready, 5, async (acc) => {
      try {
        const token = await getAccessToken(
          Number(acc.id), acc.refreshToken, acc.oauthProfile, this.tokenCache,
        );

        // Phase 2: Credits + planType via loadCodeAssist
        const health = await fetchAccountHealth(token, acc.projectId, acc.email);
        acc.credits = {
          known: health.credits.known,
          available: health.credits.available,
          creditAmount: health.credits.creditAmount,
          minCreditAmount: health.credits.minCreditAmount,
          paidTierID: health.credits.paidTierID,
          creditsRefreshedAt: new Date().toISOString(),
        };
        if (health.planType && health.planType !== acc.planType) {
          acc.planType = health.planType;
        }

        // Phase 3: Per-model quota via fetchAvailableModels
        const modelsResult = await fetchAvailableModels(token, acc.projectId);
        if (modelsResult) {
          // Detect tier from models response
          const detectedTier = extractTierFromModelsJson(modelsResult.rawJson);
          if (detectedTier && detectedTier !== acc.planType) {
            this.logger.log(`${acc.email}: tier from models: ${acc.planType || "(empty)"} → ${detectedTier}`);
            acc.planType = detectedTier;
          }

          // Store per-model quota fractions + reset times on the account
          acc.modelQuotaFractions = {};
          acc.modelQuotaResetTimes = {};
          acc.modelQuotaRefreshedAt = Date.now();
          for (const [modelKey, info] of Object.entries(modelsResult.models)) {
            if (info.remainingFraction != null) {
              acc.modelQuotaFractions[modelKey] = info.remainingFraction;
            }
            if (info.resetTime) {
              acc.modelQuotaResetTimes[modelKey] = info.resetTime;
            }
          }

          // Auto-unblock models that now have quota
          if (Array.isArray(acc.blockedModels)) {
            acc.blockedModels = acc.blockedModels.filter((bm: any) => {
              if (bm.reason !== "quota") return true;
              const modelInfo = modelsResult.models[bm.modelKey];
              // Keep block if model still has 0 quota
              return !(modelInfo && modelInfo.remainingFraction != null && modelInfo.remainingFraction > 0);
            });
            if (acc.blockedModels.length === 0 && acc.quotaStatus === "exhausted") {
              acc.quotaStatus = "ok";
              delete acc.quotaStatusReason;
              delete acc.exhaustedAt;
              delete acc.exhaustedUntil;
            }
          }

          // Persist to quota-data.json
          quotaData[acc.email] = {
            modelsJson: modelsResult.rawJson,
            refreshedAt: nowIso(),
            alias: acc.alias || "",
            planType: acc.planType || "",
          };

          refreshed++;
        } else {
          // fetchAvailableModels failed but credits may have succeeded
          errors++;
        }
      } catch (err: any) {
        errors++;
        this.logger.warn(`refreshQuota ${acc.email}: ${err.message}`);
      }
    });

    // Persist both files
    writeJson(accountsFile, { ...data, accounts, updatedAt: nowIso() });
    writeJson(quotaFile, quotaData);

    return { ok: true, refreshed, errors, total: ready.length };
  }

  /**
   * Try to discover projectId for an account via onboardUser API.
   * Updates the account object in-place if successful.
   */
  private async tryDiscoverProject(acc: any): Promise<void> {
    if (!acc.refreshToken) return;
    try {
      const token = await getAccessToken(
        Number(acc.id), acc.refreshToken, acc.oauthProfile, this.tokenCache,
      );
      const result = await discoverProject(token);
      if (result?.projectId) {
        acc.projectId = result.projectId;
        acc.projectIdSource = "api";
        if (result.planType) acc.planType = result.planType;
        this.logger.log(`Discovered project for ${acc.email}: ${result.projectId}`);
      }
    } catch (err: any) {
      this.logger.warn(`Project discovery failed for ${acc.email}: ${err.message}`);
    }
  }

  // ── AdsPower Import ──────────────────────────────────────────────

  private get adspowerFile() {
    return path.join(this.dataDir, "adspower-import.json");
  }

  /** Terminal item states — no further polling needed. */
  private readonly ADSPOWER_TERMINAL = new Set(["success", "failed"]);

  /** Map an automation Task status to the frontend's item status vocabulary. */
  private mapAdspowerTaskStatus(taskData: any): { status: string; message?: string; error?: string } {
    const backend = String(taskData?.status || "");
    switch (backend) {
      case "SUCCESS":
        return { status: "success" };
      case "RUNNING":
        return { status: "running", message: "登录授权中" };
      case "PENDING":
        return { status: "running", message: "排队中" };
      case "MANUAL_REVIEW":
        return {
          status: "failed",
          error: `需人工验证: ${taskData?.lastErrorCode || taskData?.lastErrorMessage || "MANUAL_REVIEW"}`,
        };
      case "FAILED_FINAL":
      case "FAILED_RETRYABLE":
        return {
          status: "failed",
          error: taskData?.lastErrorMessage || taskData?.lastErrorCode || "自动化失败",
        };
      default:
        return { status: "running" };
    }
  }

  /**
   * Submit a batch of Google credentials for AdsPower-driven OAuth onboarding.
   * Each credential is ensured to exist as an AgentAccount, then enqueued as an
   * "oauth" automation task (the worker drives an AdsPower profile, logs in, and
   * captures the refresh token). Status is polled via adspowerImportStatus(),
   * which pushes succeeded accounts into the Rosetta pool.
   */
  async adspowerImport(payload: any) {
    const credentials = payload?.credentials;
    if (!Array.isArray(credentials) || !credentials.length) return { ok: false, error: "credentials array required" };
    if (!this.automation || !this.agentAccounts) return { ok: false, error: "automation service unavailable" };

    const batchId = `batch_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
    const items: any[] = [];

    for (const c of credentials) {
      const email = String(c?.email || "").trim();
      const password = String(c?.password || "");
      if (!email || !password) {
        items.push({ email, status: "failed", error: "缺少邮箱或密码" });
        continue;
      }

      const recoveryEmail = c?.recoveryEmail ? String(c.recoveryEmail) : undefined;
      const totpSecret = c?.totpSecret ? String(c.totpSecret) : undefined;
      const phones = Array.isArray(c?.phones)
        ? c.phones
            .map((p: any) => ({
              phoneNumber: String(p?.phoneNumber || "").trim(),
              countryCode: String(p?.countryCode || "+1").trim() || "+1",
              smsUrl: String(p?.smsUrl || "").trim(),
            }))
            .filter((p: any) => p.phoneNumber)
        : undefined;

      try {
        const agentAccountId = await this.agentAccounts.ensureAgentAccount({
          loginEmail: email,
          loginPassword: password,
          totpSecret,
          recoveryEmail,
        });
        const result = await this.automation.startAutomation(
          "oauth",
          { email, password, recoveryEmail, totpSecret },
          phones?.length ? phones : undefined,
          undefined,
          { source: "rosetta-account-auto-import" },
        );
        items.push({
          email,
          agentAccountId,
          taskId: result?.taskId,
          status: "running",
          message: "已入队",
        });
      } catch (err: any) {
        items.push({ email, status: "failed", error: err?.message || String(err) });
      }
    }

    const batch = {
      batchId,
      status: items.every((i) => this.ADSPOWER_TERMINAL.has(i.status)) ? "completed" : "running",
      total: items.length,
      completed: items.filter((i) => this.ADSPOWER_TERMINAL.has(i.status)).length,
      failed: items.filter((i) => i.status === "failed").length,
      done: items.every((i) => this.ADSPOWER_TERMINAL.has(i.status)),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      items,
    };
    writeJson(this.adspowerFile, batch);
    return { ok: true, batchId };
  }

  /** Poll automation task status for each pending item; upload successes to the pool. */
  async adspowerImportStatus(batchId: string) {
    const data = readJson(this.adspowerFile, null);
    if (!data || data.batchId !== batchId) return { ok: false, error: "batch not found" };

    if (this.automation) {
      for (const item of data.items || []) {
        if (!item.taskId || this.ADSPOWER_TERMINAL.has(item.status)) continue;
        try {
          const taskData = await this.automation.getTaskStatus(item.taskId);
          const mapped = this.mapAdspowerTaskStatus(taskData);

          if (mapped.status === "success") {
            // OAuth done → token is on the AgentAccount; push it into the pool.
            if (!item.uploaded && item.agentAccountId && this.agentAccounts) {
              try {
                await this.agentAccounts.uploadToRosetta([item.agentAccountId]);
                item.uploaded = true;
                item.status = "success";
                item.message = "已录入账号池";
                item.error = "";
              } catch (err: any) {
                item.status = "failed";
                item.error = `OAuth成功但入池失败: ${err?.message || String(err)}`;
              }
            } else {
              item.status = "success";
              item.message = "已录入账号池";
            }
          } else {
            item.status = mapped.status;
            if (mapped.message !== undefined) item.message = mapped.message;
            if (mapped.error !== undefined) item.error = mapped.error;
          }
        } catch {
          // task not found yet / transient — leave item unchanged for next poll
        }
      }

      data.completed = (data.items || []).filter((i: any) => this.ADSPOWER_TERMINAL.has(i.status)).length;
      data.failed = (data.items || []).filter((i: any) => i.status === "failed").length;
      data.done = (data.items || []).every((i: any) => this.ADSPOWER_TERMINAL.has(i.status));
      data.status = data.done ? "completed" : "running";
      data.updatedAt = nowIso();
      writeJson(this.adspowerFile, data);
    }

    return { ok: true, ...data };
  }

  adspowerImportHistory() {
    const data = readJson(this.adspowerFile, null);
    if (!data) return { ok: true, batchId: null };
    return { ok: true, ...data };
  }
}
