/**
 * Rosetta proxy bridge — forwards requests from the web page to the local
 * Token Proxy Status API running on 127.0.0.1:60671.
 *
 * Routes:
 *   GET  /api/rosetta/status         → GET  127.0.0.1:60671/status
 *   POST /api/rosetta/reload-accounts → POST 127.0.0.1:60671/reload-accounts
 *   POST /api/rosetta/refresh-quota   → POST 127.0.0.1:60671/refresh-quota
 *   POST /api/rosetta/switch-account  → POST 127.0.0.1:60671/switch-account
 *   POST /api/rosetta/add-account     → writes accounts.json + reload
 *   GET  /api/rosetta/health          → GET  127.0.0.1:60671/health
 */

import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as nodeCrypto from "crypto";

// ─── Paths (mirrors bundled-rosetta/shared/paths.js) ─────────────────────

function getDataDir(): string {
  if (process.env.ROSETTA_DATA_DIR) return process.env.ROSETTA_DATA_DIR;
  const base =
    process.platform === "win32"
      ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support")
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "Antigravity", "rosetta");
}

const DATA_DIR = getDataDir();
const ACCOUNTS_PATH = path.join(DATA_DIR, "accounts.json");
const CONFIG_PATH = path.join(DATA_DIR, "proxy.config.json");
const FAMILY_POOL_PATH = path.join(DATA_DIR, "family-pool.json");
const QUOTA_DATA_PATH = path.join(DATA_DIR, "quota-data.json");
const ACCESS_KEYS_PATH = path.join(DATA_DIR, "access-keys.json");
const DEFAULT_ACCESS_KEY_WINDOW_MS = 5 * 60 * 60 * 1000;
const DEFAULT_ACCESS_KEY_WINDOW_LIMIT = 300;

function getProxyPort(): number {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      const p = Number(cfg.tokenProxyPort);
      if (Number.isFinite(p) && p > 0) return p;
    }
  } catch { /* default */ }
  return 60670;
}

const STATUS_PORT = () => getProxyPort() + 1;
const STATUS_BASE = () => `http://127.0.0.1:${STATUS_PORT()}`;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

function withCors(response: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

function json(data: unknown, init?: ResponseInit): NextResponse {
  return withCors(NextResponse.json(data, init));
}

function textJson(text: string, init?: ResponseInit): NextResponse {
  return withCors(new NextResponse(text, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  }));
}

function getRemoteTokenServerPort(): number {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      const p = Number(cfg?.remoteTokenServer?.port);
      if (Number.isFinite(p) && p > 0) return p;
    }
  } catch { /* default */ }
  return 60700;
}

// ─── Forward helper ──────────────────────────────────────────────────────

async function forwardToProxy(
  targetPath: string,
  method: string,
  body?: string
): Promise<NextResponse> {
  const url = `${STATUS_BASE()}${targetPath}`;
  try {
    const resp = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body || undefined,
      signal: AbortSignal.timeout(30000),
    });
    const text = await resp.text();
    return textJson(text, { status: resp.status });
  } catch (err: any) {
    return json(
      { ok: false, error: `代理未运行或无法连接: ${err.message}` },
      { status: 502 }
    );
  }
}

async function forwardToRemoteTokenServer(): Promise<NextResponse> {
  const port = getRemoteTokenServerPort();
  const url = `http://127.0.0.1:${port}/status`;
  try {
    const resp = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    const text = await resp.text();
    return textJson(text, { status: resp.status });
  } catch (err: any) {
    return json(
      { ok: false, running: false, port, error: `Remote Token Server 未运行或无法连接: ${err.message}` },
      { status: 200 }
    );
  }
}

// ─── Add account logic (writes accounts.json directly) ───────────────────

interface AccountRecord {
  id: number;
  email: string;
  refreshToken: string;
  enabled: boolean;
  alias: string;
  oauthProfile: string;
  projectId?: string;
  planType?: string;
  [key: string]: unknown;
}

interface FamilyPoolData {
  mothers: MotherRecord[];
  seats: SeatRecord[];
  candidates: CandidateRecord[];
  events: FamilyPoolEvent[];
  updatedAt?: string;
}

interface MotherRecord {
  id: string;
  email: string;
  alias?: string;
  loginPassword?: string;
  recoveryEmail?: string;
  totpSecret?: string;
  rosettaAccountId?: number;
  gfaAccountId?: string;
  activationTaskId?: string;
  activationStatus?: string;
  activationError?: string;
  tokenObtainedAt?: string;
  planType?: string;
  totalSeats: number;
  enabled: boolean;
  status: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

interface SeatRecord {
  id: string;
  motherId: string;
  seatIndex: number;
  currentChildEmail?: string;
  currentRosettaAccountId?: number;
  status: string;
  candidateEmails: string[];
  lastReplaceAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

interface CandidateRecord {
  id: string;
  motherId: string;
  seatId: string;
  email: string;
  loginPassword?: string;
  recoveryEmail?: string;
  totpSecret?: string;
  priority: number;
  status: string;
  rosettaAccountId?: number;
  inviteTaskId?: string;
  confirmTaskId?: string;
  activationTaskId?: string;
  activationStatus?: string;
  activationError?: string;
  activatedAt?: string;
  isFamilyMember?: boolean;
  joinStatus?: string;
  joinError?: string;
  createdAt: string;
  updatedAt: string;
}

interface FamilyPoolEvent {
  id: string;
  type: string;
  motherId?: string;
  seatId?: string;
  email?: string;
  message: string;
  createdAt: string;
  meta?: Record<string, unknown>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeEmail(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function readAccountsData(): { accounts: AccountRecord[] } {
  if (!fs.existsSync(ACCOUNTS_PATH)) return { accounts: [] };
  const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8"));
  return { accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [] };
}

function writeAccountsData(data: { accounts: AccountRecord[] }) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(data, null, 2), "utf8");
}

function readAccessKeysData(): { keys: any[]; updatedAt?: string } {
  if (!fs.existsSync(ACCESS_KEYS_PATH)) return { keys: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(ACCESS_KEYS_PATH, "utf8"));
    return { keys: Array.isArray(parsed.keys) ? parsed.keys : [], updatedAt: parsed.updatedAt || "" };
  } catch {
    return { keys: [] };
  }
}

function writeAccessKeysData(data: { keys: any[]; updatedAt?: string }) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ACCESS_KEYS_PATH, JSON.stringify({
    keys: Array.isArray(data.keys) ? data.keys : [],
    updatedAt: nowIso(),
  }, null, 2), "utf8");
}

function accessKeyExpiresAt(key: any): string {
  if (!key?.firstUsedAt) return "";
  const durationMs = Number(key.durationMs || 0);
  if (!durationMs) return "";
  return new Date(Date.parse(key.firstUsedAt) + durationMs).toISOString();
}

function safeAccessKey(key: any) {
  const now = Date.now();
  const windowMs = Number(key.windowMs || DEFAULT_ACCESS_KEY_WINDOW_MS);
  const cutoff = now - windowMs;
  const usageEvents = (Array.isArray(key.usageEvents) ? key.usageEvents : []).filter((item: any) => Number(item?.at || 0) >= cutoff);
  const raw = String(key.key || "");
  return {
    id: key.id,
    name: key.name || "",
    key: raw ? `${raw.slice(0, 8)}...${raw.slice(-4)}` : "",
    fullKey: raw,
    status: key.status || "active",
    durationMs: Number(key.durationMs || 0),
    firstUsedAt: key.firstUsedAt || "",
    expiresAt: accessKeyExpiresAt(key),
    totalRequests: Number(key.totalRequests || 0),
    recentWindowRequests: usageEvents.length,
    windowMs,
    windowLimit: Number(key.windowLimit || DEFAULT_ACCESS_KEY_WINDOW_LIMIT),
    lastUsedAt: key.lastUsedAt || "",
    createdAt: key.createdAt || "",
  };
}

function durationToMs(value: string): number {
  if (value === "1h") return 60 * 60 * 1000;
  if (value === "1d") return 24 * 60 * 60 * 1000;
  if (value === "1m") return 30 * 24 * 60 * 60 * 1000;
  return 60 * 60 * 1000;
}

function newAccessKeyValue(): string {
  return `BCAI-${cryptoRandom(6)}-${cryptoRandom(6)}-${cryptoRandom(6)}`;
}

function cryptoRandom(bytes: number): string {
  return nodeCrypto.randomBytes(bytes).toString("hex").toUpperCase();
}

function readQuotaData(): Record<string, any> {
  if (!fs.existsSync(QUOTA_DATA_PATH)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(QUOTA_DATA_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeRemainingFraction(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n > 1) return Math.max(0, Math.min(100, n)) / 100;
  return Math.max(0, Math.min(1, n));
}

function modelProviderKey(model: any): string {
  const provider = String(model?.apiProvider || model?.modelProvider || "").toLowerCase();
  if (provider.includes("anthropic") || provider.includes("claude")) return "anthropic";
  if (provider.includes("google") || provider.includes("gemini")) return "google";
  if (provider.includes("openai") || provider.includes("gpt")) return "openai";
  return "other";
}

function providerTitle(key: string): string {
  if (key === "anthropic") return "Anthropic / Claude";
  if (key === "google") return "Google / Gemini";
  if (key === "openai") return "OpenAI";
  return "Other";
}

function providerSortOrder(key: string): number {
  if (key === "anthropic") return 10;
  if (key === "google") return 20;
  if (key === "openai") return 30;
  return 90;
}

function parseModelsJson(value: unknown): Record<string, any> {
  if (!value) return {};
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (parsed && typeof parsed === "object") {
      const models = (parsed as any).models || parsed;
      return models && typeof models === "object" ? models : {};
    }
  } catch {
    return {};
  }
  return {};
}

function summarizeQuotaModels(modelsValue: unknown): any[] {
  const models = parseModelsJson(modelsValue);
  const groups = new Map<string, any>();

  for (const [key, model] of Object.entries(models)) {
    const modelData = model as any;
    if (!modelData || typeof modelData !== "object") continue;
    const provider = String(modelData.apiProvider || "");
    if (modelData.isInternal || provider.includes("INTERNAL")) continue;

    const fraction = normalizeRemainingFraction(modelData?.quotaInfo?.remainingFraction);
    if (fraction === null) continue;

    const providerKey = modelProviderKey(modelData);
    const resetTime = String(modelData?.quotaInfo?.resetTime || "");
    const groupKey = `${providerKey}:${resetTime || "no-reset"}`;
    const percent = Math.round(fraction * 1000) / 10;
    const entry = {
      key,
      label: String(modelData.displayName || modelData.model || key),
      provider: providerKey,
      percent,
      fraction,
      resetTime,
      isBlocked: percent <= 0,
    };

    const existing = groups.get(groupKey) || {
      key: providerKey,
      title: providerTitle(providerKey),
      provider: providerKey,
      sortOrder: providerSortOrder(providerKey),
      resetTime,
      entries: [],
      percent: 100,
      blockedCount: 0,
      modelCount: 0,
    };

    existing.entries.push(entry);
    existing.percent = Math.min(existing.percent, percent);
    existing.blockedCount += entry.isBlocked ? 1 : 0;
    existing.modelCount = existing.entries.length;
    groups.set(groupKey, existing);
  }

  return Array.from(groups.values()).sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return String(a.resetTime || "").localeCompare(String(b.resetTime || ""));
  });
}

function quotaStatusFromGroups(groups: any[]): { label: string; tone: string; blockedCount: number } {
  if (!groups.length) return { label: "", tone: "", blockedCount: 0 };
  const blockedCount = groups.reduce((sum, group) => sum + Number(group.blockedCount || 0), 0);
  const lowest = groups.reduce((min, group) => Math.min(min, Number(group.percent ?? 100)), 100);
  if (lowest <= 0) return { label: "额度耗尽", tone: "danger", blockedCount };
  if (lowest < 30) return { label: "额度偏低", tone: "warning", blockedCount };
  return { label: "额度正常", tone: "success", blockedCount };
}

async function notifyProxyReload() {
  try {
    await fetch(`${STATUS_BASE()}/reload-accounts`, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
    });
  } catch { /* proxy might not be running */ }
}

function emptyFamilyPool(): FamilyPoolData {
  return { mothers: [], seats: [], candidates: [], events: [] };
}

function readFamilyPool(): FamilyPoolData {
  if (!fs.existsSync(FAMILY_POOL_PATH)) return emptyFamilyPool();
  try {
    const parsed = JSON.parse(fs.readFileSync(FAMILY_POOL_PATH, "utf8"));
    return {
      mothers: Array.isArray(parsed.mothers) ? parsed.mothers : [],
      seats: Array.isArray(parsed.seats) ? parsed.seats : [],
      candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [],
      events: Array.isArray(parsed.events) ? parsed.events : [],
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return emptyFamilyPool();
  }
}

function writeFamilyPool(pool: FamilyPoolData) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  pool.updatedAt = nowIso();
  fs.writeFileSync(FAMILY_POOL_PATH, JSON.stringify(pool, null, 2), "utf8");
}

function appendFamilyEvent(
  pool: FamilyPoolData,
  event: Omit<FamilyPoolEvent, "id" | "createdAt">
) {
  pool.events.unshift({ id: newId("evt"), createdAt: nowIso(), ...event });
  pool.events = pool.events.slice(0, 200);
}

function findAccountByIdOrEmail(
  accounts: AccountRecord[],
  accountId?: number,
  email?: string
): AccountRecord | undefined {
  const normalized = normalizeEmail(email);
  return accounts.find((account) => {
    if (accountId && account.id === accountId) return true;
    return normalized && normalizeEmail(account.email) === normalized;
  });
}

function ensureAccountFamilyIdentity(account: AccountRecord, pool = readFamilyPool()) {
  if (account.familyRole === "mother" || account.familyRole === "child") return;
  const email = normalizeEmail(account.email);
  const mother = pool.mothers.find((item) => normalizeEmail(item.email) === email);
  if (mother) {
    account.familyRole = "mother";
    account.familyStatus = mother.status || "active";
    account.motherId = mother.id;
  } else {
    account.familyRole = "child";
    account.familyStatus = "unassigned";
  }
}

async function handleAddAccount(req: NextRequest): Promise<NextResponse> {
  try {
    const payload = await req.json();
    const refreshToken = String(payload.refreshToken || "").trim();
    const alias = String(payload.alias || "").trim();
    const email = String(payload.email || "").trim();
    const projectId = String(payload.projectId || "").trim();

    if (!refreshToken) {
      return json({ ok: false, error: "refreshToken 不能为空" }, { status: 400 });
    }
    if (!email) {
      return json({ ok: false, error: "email 不能为空" }, { status: 400 });
    }

    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    // Read existing accounts
    let data: { accounts: AccountRecord[] } = { accounts: [] };
    if (fs.existsSync(ACCOUNTS_PATH)) {
      try {
        data = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8"));
        if (!Array.isArray(data.accounts)) data.accounts = [];
      } catch { /* start fresh */ }
    }

    // Check for duplicate
    const existing = data.accounts.find(
      (a) => a.email.toLowerCase() === email.toLowerCase()
    );
    if (existing) {
      // Update existing account's token
      existing.refreshToken = refreshToken;
      existing.enabled = payload.enabled !== undefined ? payload.enabled !== false : true;
      if (projectId) existing.projectId = projectId;
      if (alias) existing.alias = alias;
      ensureAccountFamilyIdentity(existing);
    } else {
      // Add new
      const maxId = data.accounts.reduce((m, a) => Math.max(m, a.id || 0), 0);
      const account: AccountRecord = {
        id: maxId + 1,
        email,
        refreshToken,
        enabled: payload.enabled !== undefined ? payload.enabled !== false : true,
        alias,
        oauthProfile: "antigravity",
        ...(projectId ? { projectId } : {}),
      };
      ensureAccountFamilyIdentity(account);
      data.accounts.push(account);
    }

    // Write back
    fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(data, null, 2), "utf8");

    // Notify running proxy to reload
    try {
      await fetch(`${STATUS_BASE()}/reload-accounts`, {
        method: "POST",
        signal: AbortSignal.timeout(10000),
      });
    } catch { /* proxy might not be running */ }

    return json({
      ok: true,
      email,
      isUpdate: !!existing,
      totalAccounts: data.accounts.length,
    });
  } catch (err: any) {
    return json(
      { ok: false, error: err.message || String(err) },
      { status: 500 }
    );
  }
}

// ─── Exchange code (OOB Flow Desktop Client) ─────────────────────────────

async function handleExchangeOob(req: NextRequest): Promise<NextResponse> {
  try {
    const payload = await req.json();
    const code = String(payload.code || "").trim();
    if (!code) {
      return json({ ok: false, error: "Missing authorization code" }, { status: 400 });
    }

    // Default desktop credentials matching extension
    const clientId = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
    const clientSecret = "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";
    const redirectUri = "http://127.0.0.1:65000/callback";

    // 1. Exchange
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code,
      }).toString(),
    });
    
    const tokenData = await tokenResp.json();
    if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);
    if (!tokenData.refresh_token) throw new Error("未获得 Refresh Token。请在 Google 账号中撤销本应用授权后再试。");

    // 2. User info
    const userResp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userInfo = await userResp.json();
    const email = userInfo.email;
    if (!email) throw new Error("无法获取邮箱地址");

    // 3. Optional Project ID
    let projectId = "";
    try {
      const METADATA = { ideName: "antigravity", ideType: "ANTIGRAVITY", ideVersion: "1.21.6", pluginVersion: "1.21.6", platform: "unknown", updateChannel: "stable", pluginType: "GEMINI" };
      for (const host of ["daily-cloudcode-pa.sandbox.googleapis.com", "daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"]) {
        const r = await fetch(`https://${host}/v1internal:loadCodeAssist`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${tokenData.access_token}` },
          body: JSON.stringify({ metadata: METADATA }),
        });
        if (r.ok) {
          const d = await r.json();
          const p = d.cloudaicompanionProject;
          if (typeof p === "string" && p) { projectId = p; break; }
          if (p?.id) { projectId = p.id; break; }
        }
      }
    } catch { /* ignore fetch errors safely */ }

    // 4. Save
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    let data: { accounts: AccountRecord[] } = { accounts: [] };
    if (fs.existsSync(ACCOUNTS_PATH)) {
      try { data = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8")); if (!Array.isArray(data.accounts)) data.accounts = []; } catch {}
    }

    const existing = data.accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
    if (existing) {
      existing.refreshToken = tokenData.refresh_token;
      existing.enabled = true;
      if (projectId) existing.projectId = projectId;
      ensureAccountFamilyIdentity(existing);
    } else {
      const maxId = data.accounts.reduce((m, a) => Math.max(m, a.id || 0), 0);
      const account: AccountRecord = {
        id: maxId + 1, email, refreshToken: tokenData.refresh_token, enabled: true, alias: "", oauthProfile: "antigravity", ...(projectId ? { projectId } : {}),
      };
      ensureAccountFamilyIdentity(account);
      data.accounts.push(account);
    }

    fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(data, null, 2), "utf8");

    try { await fetch(`${STATUS_BASE()}/reload-accounts`, { method: "POST", signal: AbortSignal.timeout(10000) }); } catch {}

    return json({
      ok: true,
      email,
      refreshToken: tokenData.refresh_token,
      projectId,
      isUpdate: !!existing,
      totalAccounts: data.accounts.length
    });

  } catch (err: any) {
    return json({ ok: false, error: err.message }, { status: 500 });
  }
}

// ─── Delete account ──────────────────────────────────────────────────────

async function handleDeleteAccount(req: NextRequest): Promise<NextResponse> {
  try {
    const payload = await req.json();
    const accountId = Number(payload.accountId);
    if (!Number.isFinite(accountId) || accountId <= 0) {
      return json({ ok: false, error: "无效的 accountId" }, { status: 400 });
    }

    let data: { accounts: AccountRecord[] } = { accounts: [] };
    if (fs.existsSync(ACCOUNTS_PATH)) {
      data = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8"));
      if (!Array.isArray(data.accounts)) data.accounts = [];
    }

    const before = data.accounts.length;
    data.accounts = data.accounts.filter((a) => a.id !== accountId);
    if (data.accounts.length === before) {
      return json({ ok: false, error: "账号不存在" }, { status: 404 });
    }

    fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(data, null, 2), "utf8");

    // Notify proxy
    try {
      await fetch(`${STATUS_BASE()}/reload-accounts`, {
        method: "POST",
        signal: AbortSignal.timeout(10000),
      });
    } catch { /* non-fatal */ }

    return json({ ok: true, totalAccounts: data.accounts.length });
  } catch (err: any) {
    return json({ ok: false, error: err.message }, { status: 500 });
  }
}

// ─── Toggle account enabled/disabled ─────────────────────────────────────

async function handleToggleAccount(req: NextRequest): Promise<NextResponse> {
  try {
    const payload = await req.json();
    const accountId = Number(payload.accountId);

    let data: { accounts: AccountRecord[] } = { accounts: [] };
    if (fs.existsSync(ACCOUNTS_PATH)) {
      data = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8"));
      if (!Array.isArray(data.accounts)) data.accounts = [];
    }

    const acc = data.accounts.find((a) => a.id === accountId);
    if (!acc) {
      return json({ ok: false, error: "账号不存在" }, { status: 404 });
    }

    acc.enabled = !acc.enabled;
    fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(data, null, 2), "utf8");

    try {
      await fetch(`${STATUS_BASE()}/reload-accounts`, {
        method: "POST",
        signal: AbortSignal.timeout(10000),
      });
    } catch { /* non-fatal */ }

    return json({ ok: true, email: acc.email, enabled: acc.enabled });
  } catch (err: any) {
    return json({ ok: false, error: err.message }, { status: 500 });
  }
}

// ─── Route handlers ──────────────────────────────────────────────────────

async function handleFamilyPool(): Promise<NextResponse> {
  const pool = readFamilyPool();
  const accounts = readAccountsData().accounts;
  const safeAccounts = accounts.map((a) => {
    const account = { ...a };
    ensureAccountFamilyIdentity(account, pool);
    return {
      id: account.id,
      email: account.email,
      enabled: account.enabled,
      alias: account.alias || "",
      planType: account.planType || "",
      familyRole: account.familyRole || "",
      familyStatus: account.familyStatus || "",
      motherId: account.motherId || "",
      seatId: account.seatId || "",
    };
  });
  return json({
    ...pool,
    accounts: safeAccounts,
    dataDir: DATA_DIR,
    familyPoolPath: FAMILY_POOL_PATH,
  });
}

async function handleFamilyMother(req: NextRequest): Promise<NextResponse> {
  try {
    const payload = await req.json();
    const email = normalizeEmail(payload.email);
    const now = nowIso();
    const totalSeats = Math.max(0, Math.min(20, Number(payload.totalSeats ?? 0) || 0));
    if (!email) return json({ ok: false, error: "mother email is required" }, { status: 400 });

    const pool = readFamilyPool();
    let mother = payload.id
      ? pool.mothers.find((item) => item.id === String(payload.id))
      : pool.mothers.find((item) => normalizeEmail(item.email) === email);
    if (!payload.id && mother) {
      return json({ ok: false, error: `mother email already exists: ${email}` }, { status: 409 });
    }

    if (!mother) {
      mother = {
        id: newId("mother"),
        email,
        alias: String(payload.alias || "").trim(),
        loginPassword: String(payload.loginPassword || "").trim(),
        recoveryEmail: normalizeEmail(payload.recoveryEmail),
        totpSecret: String(payload.totpSecret || "").trim(),
        rosettaAccountId: Number(payload.rosettaAccountId) || undefined,
        gfaAccountId: String(payload.gfaAccountId || "").trim() || undefined,
        activationTaskId: String(payload.activationTaskId || "").trim() || undefined,
        activationStatus: String(payload.activationStatus || "").trim() || undefined,
        activationError: String(payload.activationError || "").trim() || undefined,
        tokenObtainedAt: String(payload.tokenObtainedAt || "").trim() || undefined,
        planType: String(payload.planType || "").trim(),
        totalSeats,
        enabled: payload.enabled !== false,
        status: String(payload.status || "active"),
        notes: String(payload.notes || "").trim(),
        createdAt: now,
        updatedAt: now,
      };
      pool.mothers.push(mother);
      for (let i = 1; i <= totalSeats; i += 1) {
        pool.seats.push({
          id: newId("seat"),
          motherId: mother.id,
          seatIndex: i,
          status: "empty",
          candidateEmails: [],
          createdAt: now,
          updatedAt: now,
        });
      }
      appendFamilyEvent(pool, {
        type: "mother_created",
        motherId: mother.id,
        email,
        message: `Mother account ${email} created with ${totalSeats} seats.`,
      });
    } else {
      mother.email = email;
      mother.alias = String(payload.alias ?? mother.alias ?? "").trim();
      if (payload.loginPassword !== undefined) mother.loginPassword = String(payload.loginPassword || "").trim();
      if (payload.recoveryEmail !== undefined) mother.recoveryEmail = normalizeEmail(payload.recoveryEmail);
      if (payload.totpSecret !== undefined) mother.totpSecret = String(payload.totpSecret || "").trim();
      mother.rosettaAccountId = Number(payload.rosettaAccountId) || mother.rosettaAccountId;
      if (payload.gfaAccountId !== undefined) mother.gfaAccountId = String(payload.gfaAccountId || "").trim() || undefined;
      if (payload.activationTaskId !== undefined) mother.activationTaskId = String(payload.activationTaskId || "").trim() || undefined;
      if (payload.activationStatus !== undefined) mother.activationStatus = String(payload.activationStatus || "").trim() || undefined;
      if (payload.activationError !== undefined) mother.activationError = String(payload.activationError || "").trim() || undefined;
      if (payload.tokenObtainedAt !== undefined) mother.tokenObtainedAt = String(payload.tokenObtainedAt || "").trim() || undefined;
      mother.planType = String(payload.planType ?? mother.planType ?? "").trim();
      mother.enabled = payload.enabled !== undefined ? payload.enabled !== false : mother.enabled;
      mother.status = String(payload.status || mother.status || "active");
      mother.notes = String(payload.notes ?? mother.notes ?? "").trim();
      mother.updatedAt = now;
      if (totalSeats > mother.totalSeats) {
        const existing = pool.seats.filter((seat) => seat.motherId === mother!.id).length;
        for (let i = existing + 1; i <= totalSeats; i += 1) {
          pool.seats.push({
            id: newId("seat"),
            motherId: mother.id,
            seatIndex: i,
            status: "empty",
            candidateEmails: [],
            createdAt: now,
            updatedAt: now,
          });
        }
      }
      mother.totalSeats = Math.max(totalSeats || mother.totalSeats, pool.seats.filter((seat) => seat.motherId === mother!.id).length);
      appendFamilyEvent(pool, {
        type: "mother_updated",
        motherId: mother.id,
        email,
        message: `Mother account ${email} updated.`,
      });
    }

    if (mother.rosettaAccountId) {
      const accountData = readAccountsData();
      const account = findAccountByIdOrEmail(accountData.accounts, mother.rosettaAccountId, email);
      if (account) {
        account.familyRole = "mother";
        account.familyStatus = mother.status || "active";
        account.motherId = mother.id;
        writeAccountsData(accountData);
        await notifyProxyReload();
      }
    }

    writeFamilyPool(pool);
    return json({ ok: true, mother, pool });
  } catch (err: any) {
    return json({ ok: false, error: err.message || String(err) }, { status: 500 });
  }
}

async function handleFamilySeat(req: NextRequest): Promise<NextResponse> {
  try {
    const payload = await req.json();
    const seatId = String(payload.seatId || "");
    const pool = readFamilyPool();
    const seat = pool.seats.find((item) => item.id === seatId);
    if (!seat) return json({ ok: false, error: "seat not found" }, { status: 404 });

    const now = nowIso();
    const candidateDetails = Array.isArray(payload.candidateDetails) ? payload.candidateDetails : [];
    const candidates: string[] = Array.isArray(payload.candidateEmails)
      ? payload.candidateEmails.map(normalizeEmail).filter(Boolean)
      : String(payload.candidateEmails || "").split(/[\s,;]+/).map(normalizeEmail).filter(Boolean);
    seat.candidateEmails = [...new Set(candidates)];
    if (payload.currentChildEmail !== undefined) seat.currentChildEmail = normalizeEmail(payload.currentChildEmail) || undefined;
    if (payload.currentRosettaAccountId !== undefined) seat.currentRosettaAccountId = Number(payload.currentRosettaAccountId) || undefined;
    if (payload.status) seat.status = String(payload.status);
    seat.updatedAt = now;

    for (const [index, email] of seat.candidateEmails.entries()) {
      const detail = candidateDetails.find((item: any) => normalizeEmail(item?.email) === email) || {};
      const existing = pool.candidates.find((item) => item.seatId === seat.id && normalizeEmail(item.email) === email);
      if (existing) {
        existing.priority = index + 1;
        if (detail.loginPassword !== undefined) existing.loginPassword = String(detail.loginPassword || "").trim();
        if (detail.recoveryEmail !== undefined) existing.recoveryEmail = normalizeEmail(detail.recoveryEmail);
        if (detail.totpSecret !== undefined) existing.totpSecret = String(detail.totpSecret || "").trim();
        if (detail.activationTaskId !== undefined) existing.activationTaskId = String(detail.activationTaskId || "").trim();
        if (detail.activationStatus !== undefined) existing.activationStatus = String(detail.activationStatus || "").trim();
        if (detail.activationError !== undefined) existing.activationError = String(detail.activationError || "").trim();
        if (detail.activatedAt !== undefined) existing.activatedAt = String(detail.activatedAt || "").trim();
        if (detail.inviteTaskId !== undefined) existing.inviteTaskId = String(detail.inviteTaskId || "").trim();
        if (detail.confirmTaskId !== undefined) existing.confirmTaskId = String(detail.confirmTaskId || "").trim();
        if (detail.joinStatus !== undefined) existing.joinStatus = String(detail.joinStatus || "").trim();
        if (detail.joinError !== undefined) existing.joinError = String(detail.joinError || "").trim();
        if (detail.isFamilyMember !== undefined) existing.isFamilyMember = detail.isFamilyMember === true;
        if (detail.rosettaAccountId !== undefined) existing.rosettaAccountId = Number(detail.rosettaAccountId) || undefined;
        existing.updatedAt = now;
      } else {
        pool.candidates.push({
          id: newId("cand"),
          motherId: seat.motherId,
          seatId: seat.id,
          email,
          loginPassword: String(detail.loginPassword || "").trim(),
          recoveryEmail: normalizeEmail(detail.recoveryEmail),
          totpSecret: String(detail.totpSecret || "").trim(),
          activationTaskId: String(detail.activationTaskId || "").trim() || undefined,
          activationStatus: String(detail.activationStatus || "").trim() || undefined,
          activationError: String(detail.activationError || "").trim() || undefined,
          activatedAt: String(detail.activatedAt || "").trim() || undefined,
          inviteTaskId: String(detail.inviteTaskId || "").trim() || undefined,
          confirmTaskId: String(detail.confirmTaskId || "").trim() || undefined,
          joinStatus: String(detail.joinStatus || "").trim() || undefined,
          joinError: String(detail.joinError || "").trim() || undefined,
          isFamilyMember: detail.isFamilyMember === true,
          rosettaAccountId: Number(detail.rosettaAccountId) || undefined,
          priority: index + 1,
          status: "candidate",
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    // Remove candidate records that are no longer in the email list
    const emailSet = new Set(seat.candidateEmails);
    pool.candidates = pool.candidates.filter(
      (item) => item.seatId !== seat.id || emailSet.has(normalizeEmail(item.email))
    );

    appendFamilyEvent(pool, {
      type: "seat_updated",
      motherId: seat.motherId,
      seatId: seat.id,
      email: seat.currentChildEmail,
      message: `Seat ${seat.seatIndex} updated.`,
    });
    writeFamilyPool(pool);
    return json({ ok: true, seat, pool });
  } catch (err: any) {
    return json({ ok: false, error: err.message || String(err) }, { status: 500 });
  }
}

async function handleFamilyBindAccount(req: NextRequest): Promise<NextResponse> {
  try {
    const payload = await req.json();
    const accountId = Number(payload.accountId);
    const role = String(payload.role || "");
    if (!Number.isFinite(accountId) || accountId <= 0) return json({ ok: false, error: "accountId is required" }, { status: 400 });
    if (role !== "mother" && role !== "child") return json({ ok: false, error: "role must be mother or child" }, { status: 400 });

    const pool = readFamilyPool();
    const accountData = readAccountsData();
    const account = findAccountByIdOrEmail(accountData.accounts, accountId);
    if (!account) return json({ ok: false, error: "account not found" }, { status: 404 });

    const now = nowIso();
    if (role === "mother") {
      let mother = String(payload.motherId || "")
        ? pool.mothers.find((item) => item.id === String(payload.motherId))
        : pool.mothers.find((item) => normalizeEmail(item.email) === normalizeEmail(account.email));
      if (!mother) {
        mother = {
          id: newId("mother"),
          email: normalizeEmail(account.email),
          alias: account.alias || "",
          rosettaAccountId: account.id,
          planType: String(account.planType || ""),
          totalSeats: Number(payload.totalSeats) || 0,
          enabled: true,
          status: "active",
          createdAt: now,
          updatedAt: now,
        };
        pool.mothers.push(mother);
      }
      mother.rosettaAccountId = account.id;
      mother.updatedAt = now;
      account.familyRole = "mother";
      account.familyStatus = String(payload.familyStatus || "active");
      account.motherId = mother.id;
      appendFamilyEvent(pool, {
        type: "account_bound",
        motherId: mother.id,
        email: account.email,
        message: `${account.email} bound as mother.`,
      });
    } else {
      const seat = pool.seats.find((item) => item.id === String(payload.seatId));
      if (!seat) return json({ ok: false, error: "seat not found" }, { status: 404 });
      seat.currentChildEmail = normalizeEmail(account.email);
      seat.currentRosettaAccountId = account.id;
      seat.status = String(payload.familyStatus || "active");
      seat.updatedAt = now;
      if (!seat.candidateEmails.includes(seat.currentChildEmail)) seat.candidateEmails.unshift(seat.currentChildEmail);
      let candidate = pool.candidates.find((item) => item.seatId === seat.id && normalizeEmail(item.email) === seat.currentChildEmail);
      if (!candidate) {
        candidate = {
          id: newId("cand"),
          motherId: seat.motherId,
          seatId: seat.id,
          email: seat.currentChildEmail,
          priority: 1,
          status: "active",
          rosettaAccountId: account.id,
          createdAt: now,
          updatedAt: now,
        };
        pool.candidates.push(candidate);
      } else {
        candidate.status = "active";
        candidate.rosettaAccountId = account.id;
        candidate.updatedAt = now;
      }
      account.familyRole = "child";
      account.familyStatus = seat.status;
      account.motherId = seat.motherId;
      account.seatId = seat.id;
      appendFamilyEvent(pool, {
        type: "account_bound",
        motherId: seat.motherId,
        seatId: seat.id,
        email: account.email,
        message: `${account.email} bound as child for seat ${seat.seatIndex}.`,
      });
    }

    writeAccountsData(accountData);
    writeFamilyPool(pool);
    await notifyProxyReload();
    return json({ ok: true, accountId, role, pool });
  } catch (err: any) {
    return json({ ok: false, error: err.message || String(err) }, { status: 500 });
  }
}

async function handleFamilyReplace(req: NextRequest): Promise<NextResponse> {
  try {
    const payload = await req.json();
    const seatId = String(payload.seatId || "");
    const newEmail = normalizeEmail(payload.newEmail);
    if (!newEmail) return json({ ok: false, error: "newEmail is required" }, { status: 400 });

    const pool = readFamilyPool();
    const seat = pool.seats.find((item) => item.id === seatId);
    if (!seat) return json({ ok: false, error: "seat not found" }, { status: 404 });

    const now = nowIso();
    const oldEmail = normalizeEmail(seat.currentChildEmail);
    const accountData = readAccountsData();
    const oldAccount = findAccountByIdOrEmail(accountData.accounts, Number(seat.currentRosettaAccountId) || undefined, oldEmail);
    if (oldAccount) {
      oldAccount.enabled = false;
      oldAccount.familyRole = "child";
      oldAccount.familyStatus = "replaced";
      oldAccount.replacedAt = now;
      oldAccount.replacedByEmail = newEmail;
      oldAccount.motherId = seat.motherId;
      oldAccount.seatId = seat.id;
    }

    seat.status = "replacing";
    seat.lastReplaceAt = now;
    seat.updatedAt = now;
    if (!seat.candidateEmails.includes(newEmail)) seat.candidateEmails.unshift(newEmail);

    let candidate = pool.candidates.find((item) => item.seatId === seat.id && normalizeEmail(item.email) === newEmail);
    if (!candidate) {
      candidate = {
        id: newId("cand"),
        motherId: seat.motherId,
        seatId: seat.id,
        email: newEmail,
        priority: 1,
        status: "pending_invite",
        createdAt: now,
        updatedAt: now,
      };
      pool.candidates.push(candidate);
    } else {
      candidate.status = "pending_invite";
      candidate.updatedAt = now;
    }

    appendFamilyEvent(pool, {
      type: "replace_requested",
      motherId: seat.motherId,
      seatId: seat.id,
      email: newEmail,
      message: `Manual replacement requested: ${oldEmail || "empty"} -> ${newEmail}.`,
      meta: { oldEmail, newEmail, oldAccountId: oldAccount?.id },
    });

    writeAccountsData(accountData);
    writeFamilyPool(pool);
    await notifyProxyReload();
    return json({
      ok: true,
      seat,
      oldEmail,
      newEmail,
      integrationStatus: "manual_required",
      nextSteps: [
        "Use the existing GFA family-group flow to remove the old child and invite the new email.",
        "After the new member accepts, import it once through OAuth on this page.",
        "Bind or activate the imported account on this seat.",
      ],
    });
  } catch (err: any) {
    return json({ ok: false, error: err.message || String(err) }, { status: 500 });
  }
}

async function handleFamilyActivateChild(req: NextRequest): Promise<NextResponse> {
  try {
    const payload = await req.json();
    const seatId = String(payload.seatId || "");
    const accountId = Number(payload.accountId);
    if (!Number.isFinite(accountId) || accountId <= 0) return json({ ok: false, error: "accountId is required" }, { status: 400 });

    const pool = readFamilyPool();
    const seat = pool.seats.find((item) => item.id === seatId);
    if (!seat) return json({ ok: false, error: "seat not found" }, { status: 404 });

    const accountData = readAccountsData();
    const account = findAccountByIdOrEmail(accountData.accounts, accountId);
    if (!account) return json({ ok: false, error: "account not found" }, { status: 404 });

    const now = nowIso();
    const email = normalizeEmail(account.email);
    const memberConfirmed = payload.memberConfirmed === true;
    const alreadyMember = normalizeEmail(seat.currentChildEmail) === email && seat.status === "active";
    const disqualified =
      account.familyStatus === "replaced" ||
      account.familyStatus === "blocked" ||
      account.familyStatus === "disabled" ||
      payload.disqualified === true;
    const eligibleToEnable = (memberConfirmed || alreadyMember) && !disqualified;
    if (memberConfirmed) {
      seat.currentChildEmail = email;
      seat.currentRosettaAccountId = account.id;
      seat.status = "active";
    }
    seat.updatedAt = now;
    if (!seat.candidateEmails.includes(email)) seat.candidateEmails.unshift(email);

    let matchedCandidate = false;
    for (const candidate of pool.candidates.filter((item) => item.seatId === seat.id)) {
      if (normalizeEmail(candidate.email) === email) {
        matchedCandidate = true;
        candidate.status = eligibleToEnable ? "active" : "activated_pending_member";
        candidate.rosettaAccountId = account.id;
        candidate.activatedAt = String(payload.activatedAt || candidate.activatedAt || now);
        candidate.isFamilyMember = eligibleToEnable;
      } else if (candidate.status === "active") {
        candidate.status = "replaced";
      }
      candidate.updatedAt = now;
    }
    if (!matchedCandidate) {
      pool.candidates.push({
        id: newId("cand"),
        motherId: seat.motherId,
        seatId: seat.id,
        email,
        priority: 1,
        status: eligibleToEnable ? "active" : "activated_pending_member",
        rosettaAccountId: account.id,
        activatedAt: String(payload.activatedAt || now),
        isFamilyMember: eligibleToEnable,
        createdAt: now,
        updatedAt: now,
      });
    }

    account.enabled = eligibleToEnable;
    account.familyRole = "child";
    account.familyStatus = eligibleToEnable ? "active" : "activated_pending_member";
    account.motherId = seat.motherId;
    account.seatId = seat.id;
    account.activatedAt = now;

    appendFamilyEvent(pool, {
      type: "child_activated",
      motherId: seat.motherId,
      seatId: seat.id,
      email,
      message: eligibleToEnable
        ? `${email} activated and enabled for seat ${seat.seatIndex}.`
        : `${email} activated for seat ${seat.seatIndex}, waiting for family membership.`,
    });

    writeAccountsData(accountData);
    writeFamilyPool(pool);
    await notifyProxyReload();
    return json({ ok: true, seat, accountId, pool });
  } catch (err: any) {
    return json({ ok: false, error: err.message || String(err) }, { status: 500 });
  }
}

function handleAccessKeys() {
  const data = readAccessKeysData();
  return json({
    keys: data.keys.map(safeAccessKey),
    accessKeysPath: ACCESS_KEYS_PATH,
    defaults: { windowMs: DEFAULT_ACCESS_KEY_WINDOW_MS, windowLimit: DEFAULT_ACCESS_KEY_WINDOW_LIMIT },
  });
}

async function handleCreateAccessKey(req: NextRequest) {
  try {
    const payload = await req.json();
    const data = readAccessKeysData();
    const now = nowIso();
    const record = {
      id: newId("key"),
      name: String(payload.name || "").trim(),
      key: newAccessKeyValue(),
      status: "active",
      durationMs: durationToMs(String(payload.duration || "1h")),
      firstUsedAt: "",
      totalRequests: 0,
      usageEvents: [],
      windowMs: DEFAULT_ACCESS_KEY_WINDOW_MS,
      windowLimit: Math.max(1, Math.min(5000, Number(payload.windowLimit || DEFAULT_ACCESS_KEY_WINDOW_LIMIT))),
      createdAt: now,
      updatedAt: now,
    };
    data.keys.unshift(record);
    writeAccessKeysData(data);
    return json({ ok: true, key: safeAccessKey(record) });
  } catch (err: any) {
    return json({ ok: false, error: err.message || String(err) }, { status: 500 });
  }
}

async function handleUpdateAccessKey(req: NextRequest) {
  try {
    const payload = await req.json();
    const id = String(payload.id || "").trim();
    const data = readAccessKeysData();
    const record = data.keys.find((item) => item.id === id);
    if (!record) return json({ ok: false, error: "Access key not found" }, { status: 404 });
    if (payload.status) record.status = String(payload.status);
    if (payload.windowLimit !== undefined) {
      record.windowLimit = Math.max(1, Math.min(5000, Number(payload.windowLimit || DEFAULT_ACCESS_KEY_WINDOW_LIMIT)));
    }
    record.updatedAt = nowIso();
    writeAccessKeysData(data);
    return json({ ok: true, key: safeAccessKey(record) });
  } catch (err: any) {
    return json({ ok: false, error: err.message || String(err) }, { status: 500 });
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const segments = (await params).path;
  const route = "/" + segments.join("/");

  switch (route) {
    case "/status":
      return forwardToProxy("/status", "GET");
    case "/health":
      return forwardToProxy("/health", "GET");
    case "/remote-token-status":
      return forwardToRemoteTokenServer();
    case "/access-keys":
      return handleAccessKeys();
    case "/family-pool":
      return handleFamilyPool();
    case "/accounts": {
      // Read accounts.json directly (doesn't need proxy running)
      try {
        if (!fs.existsSync(ACCOUNTS_PATH)) {
          return json({ accounts: [] });
        }
        const raw = fs.readFileSync(ACCOUNTS_PATH, "utf8");
        const data = JSON.parse(raw);
        const pool = readFamilyPool();
        const quotaData = readQuotaData();
        // Strip sensitive fields (refreshToken) for listing
        const safe = (data.accounts || []).map((a: any) => {
          const account = { ...a };
          ensureAccountFamilyIdentity(account, pool);
          const quotaSnapshot = quotaData[normalizeEmail(account.email)] || {};
          const quotaGroups = Array.isArray(account.quotaGroups) && account.quotaGroups.length
            ? account.quotaGroups
            : summarizeQuotaModels(quotaSnapshot.modelsJson);
          const quotaStatus = quotaStatusFromGroups(quotaGroups);
          return {
            id: account.id,
            email: account.email,
            enabled: account.enabled,
            alias: account.alias || "",
            projectId: account.projectId || "",
            planType: account.planType || "",
            oauthProfile: account.oauthProfile || "",
            hasToken: !!account.refreshToken,
            quotaGroups,
            quotaRefreshedAt: account.quotaRefreshedAt || quotaSnapshot.refreshedAt || "",
            accountResetTime: account.accountResetTime || quotaGroups[0]?.resetTime || "",
            quotaLiveBlockedCount: account.quotaLiveBlockedCount || quotaStatus.blockedCount,
            accountStatusLabel: account.accountStatusLabel || quotaStatus.label,
            accountStatusTone: account.accountStatusTone || quotaStatus.tone,
            hasCredentials: !!(account.loginPassword || account.totpSecret),
            familyRole: account.familyRole || "",
            familyStatus: account.familyStatus || "",
            motherId: account.motherId || "",
            seatId: account.seatId || "",
            replacedAt: account.replacedAt || "",
            replacedByEmail: account.replacedByEmail || "",
          };
        });
        return json({ accounts: safe, dataDir: DATA_DIR });
      } catch (err: any) {
        return json({ accounts: [], error: err.message });
      }
    }
    default:
      return json({ error: "Not found" }, { status: 404 });
  }
}

export async function OPTIONS() {
  return withCors(new NextResponse(null, { status: 204 }));
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const segments = (await params).path;
  const route = "/" + segments.join("/");

  switch (route) {
    case "/exchange-oob":
      return handleExchangeOob(req);
    case "/add-account":
      return handleAddAccount(req);
    case "/delete-account":
      return handleDeleteAccount(req);
    case "/toggle-account":
      return handleToggleAccount(req);
    case "/reload-accounts":
      return forwardToProxy("/reload-accounts", "POST");
    case "/refresh-quota":
      return forwardToProxy("/refresh-quota", "POST");
    case "/switch-account": {
      const body = await req.text();
      return forwardToProxy("/switch-account", "POST", body);
    }
    case "/family-mother":
      return handleFamilyMother(req);
    case "/family-seat":
      return handleFamilySeat(req);
    case "/family-bind-account":
      return handleFamilyBindAccount(req);
    case "/family-replace":
      return handleFamilyReplace(req);
    case "/family-activate-child":
      return handleFamilyActivateChild(req);
    case "/access-key":
      return handleCreateAccessKey(req);
    case "/access-key-update":
      return handleUpdateAccessKey(req);
    default:
      return json({ error: "Not found" }, { status: 404 });
  }
}
