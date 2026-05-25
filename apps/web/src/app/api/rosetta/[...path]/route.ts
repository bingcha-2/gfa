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
import { spawn } from "child_process";
import { CONSOLE_AUTH_COOKIE } from "../../../../lib/auth-cookie";

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
const EMPLOYEES_PATH = path.join(DATA_DIR, "employees.json");
const CAPTCHA_UNBLOCK_PATH = path.join(DATA_DIR, "captcha-unblock.json");
const THROTTLE_CONFIG_PATH = path.join(DATA_DIR, "throttle-config.json");
const DEFAULT_ACCESS_KEY_WINDOW_MS = 5 * 60 * 60 * 1000;
const DEFAULT_ACCESS_KEY_WINDOW_LIMIT = 300;
const DEFAULT_ACCESS_KEY_TOKENS_PER_REQUEST = 100_000;
const BACKEND_BASE_URL =
  process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001/api";

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

async function requireConsoleAuth(req: NextRequest): Promise<NextResponse | null> {
  const authorization = req.headers.get("authorization");
  const cookieToken = req.cookies.get(CONSOLE_AUTH_COOKIE)?.value;
  const token = authorization?.replace(/^Bearer\s+/i, "").trim() || cookieToken;

  if (!token) {
    return json({ ok: false, error: "Console login required" }, { status: 401 });
  }

  try {
    const response = await fetch(`${BACKEND_BASE_URL}/auth/me`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return json({ ok: false, error: "Console login expired" }, { status: 401 });
    }
    return null;
  } catch (err: any) {
    return json(
      { ok: false, error: `Unable to verify console login: ${err.message || err}` },
      { status: 502 }
    );
  }
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
      signal: AbortSignal.timeout(15000),
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

async function forwardToRemoteTokenServerPost(path: string): Promise<NextResponse> {
  const port = getRemoteTokenServerPort();
  const url = `http://127.0.0.1:${port}${path}`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(10000),
    });
    const text = await resp.text();
    return textJson(text, { status: resp.status });
  } catch (err: any) {
    return json(
      { ok: false, error: `Remote Token Server 请求失败: ${err.message}` },
      { status: 502 }
    );
  }
}

async function forwardToRemoteTokenServerPostWithBody(rtsPath: string, body: string): Promise<NextResponse> {
  const port = getRemoteTokenServerPort();
  const url = `http://127.0.0.1:${port}${rtsPath}`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(10000),
    });
    const text = await resp.text();
    return textJson(text, { status: resp.status });
  } catch (err: any) {
    return json(
      { ok: false, error: `Remote Token Server 请求失败: ${err.message}` },
      { status: 502 }
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
  children: ChildPoolRecord[];
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

interface ChildPoolRecord {
  id: string;
  email: string;
  alias?: string;
  loginPassword?: string;
  recoveryEmail?: string;
  totpSecret?: string;
  rosettaAccountId?: number;
  activationTaskId?: string;
  activationStatus?: string;
  activationError?: string;
  activatedAt?: string;
  tokenObtainedAt?: string;
  assignedMotherId?: string;
  assignedSeatId?: string;
  isFamilyMember?: boolean;
  joinStatus?: string;
  joinError?: string;
  status: string;
  notes?: string;
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
  const caller = new Error().stack?.split('\n')[2]?.trim() || 'unknown';
  console.log(`[writeAccountsData] Writing ${data.accounts.length} accounts. Last: ${data.accounts[data.accounts.length - 1]?.email || 'none'}. Caller: ${caller}`);
  // Atomic write: temp file then rename to avoid partial writes
  const tmpPath = ACCOUNTS_PATH + `.tmp.${process.pid}.${Date.now()}`;
  const content = JSON.stringify(data, null, 2) + "\n";
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, ACCOUNTS_PATH);
  // Post-write verification: read back and confirm the data is correct
  try {
    const verify = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8"));
    if (!Array.isArray(verify.accounts) || verify.accounts.length !== data.accounts.length) {
      console.error(`[writeAccountsData] ⚠ POST-WRITE VERIFICATION FAILED: wrote ${data.accounts.length} accounts, read back ${verify.accounts?.length ?? 0}`);
    }
  } catch (verifyErr: any) {
    console.error(`[writeAccountsData] ⚠ POST-WRITE VERIFICATION ERROR: ${verifyErr.message}`);
  }
}

function readAccessKeysData(): { keys: any[]; updatedAt?: string } {
  if (!fs.existsSync(ACCESS_KEYS_PATH)) return { keys: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(ACCESS_KEYS_PATH, "utf8"));
    return { keys: Array.isArray(parsed.keys) ? parsed.keys : [], updatedAt: parsed.updatedAt || "" };
  } catch (error: any) {
    throw new Error(`access-keys.json 解析失败，已阻止覆盖写入：${error?.message || error}`);
  }
}

function readEmployeesData(): { employees: any[]; accounts: any[]; sessions: any[]; updatedAt?: string } {
  if (!fs.existsSync(EMPLOYEES_PATH)) return { employees: [], accounts: [], sessions: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(EMPLOYEES_PATH, "utf8"));
    return {
      employees: Array.isArray(parsed.employees) ? parsed.employees : [],
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      updatedAt: parsed.updatedAt || "",
    };
  } catch {
    return { employees: [], accounts: [], sessions: [] };
  }
}

function writeEmployeesData(data: { employees: any[]; accounts: any[]; sessions: any[]; updatedAt?: string }) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(EMPLOYEES_PATH, JSON.stringify({
    employees: Array.isArray(data.employees) ? data.employees : [],
    accounts: Array.isArray(data.accounts) ? data.accounts : [],
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
    updatedAt: nowIso(),
  }, null, 2), "utf8");
}

function hashEmployeePassword(password: string, salt = nodeCrypto.randomBytes(16).toString("hex")) {
  const hash = nodeCrypto.pbkdf2Sync(password, salt, 120_000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyEmployeePassword(password: string, stored: string): boolean {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const next = hashEmployeePassword(password, salt).split(":")[1];
  try {
    return nodeCrypto.timingSafeEqual(Buffer.from(hash), Buffer.from(next));
  } catch {
    return false;
  }
}

function employeeSessionFromRequest(req: NextRequest, data = readEmployeesData()) {
  const raw = req.headers.get("authorization") || "";
  const token = raw.toLowerCase().startsWith("bearer ") ? raw.slice(7).trim() : "";
  if (!token) return null;
  const session = data.sessions.find((item) => item.token === token && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now()));
  if (!session) return null;
  const employee = data.employees.find((item) => item.id === session.employeeId && item.status !== "disabled");
  if (!employee) return null;
  return { token, session, employee };
}

function safeEmployee(employee: any, accounts: any[] = []) {
  const mine = accounts.filter((item) => item.employeeId === employee.id);
  return {
    id: employee.id,
    email: employee.email,
    status: employee.status || "active",
    createdAt: employee.createdAt || "",
    lastActiveAt: employee.lastActiveAt || "",
    stats: {
      total: mine.length,
      accepted: mine.filter((item) => item.status === "accepted").length,
      failed: mine.filter((item) => String(item.status || "").includes("failed") || String(item.status || "").includes("invalid")).length,
      disabled: mine.filter((item) => item.disabledByEmployee).length,
      deleted: mine.filter((item) => item.deletedByEmployee).length,
    },
  };
}

function writeAccessKeysData(data: { keys: any[]; updatedAt?: string }) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(ACCESS_KEYS_PATH)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(ACCESS_KEYS_PATH, `${ACCESS_KEYS_PATH}.bak-${stamp}`);
  }
  fs.writeFileSync(ACCESS_KEYS_PATH, JSON.stringify({
    keys: Array.isArray(data.keys) ? data.keys : [],
    updatedAt: nowIso(),
  }, null, 2), "utf8");
  // Notify remote-token-server to invalidate its in-memory cache (fire-and-forget)
  const rtsPort = getRemoteTokenServerPort();
  fetch(`http://127.0.0.1:${rtsPort}/reload-access-keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(5000),
  }).catch(() => { /* rts might not be running */ });
}

function accessKeyBackupStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
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
  const tokenWindowMs = Number(key.tokenWindowMs || windowMs);
  const tokenCutoff = now - tokenWindowMs;
  const tokenUsageEvents = (Array.isArray(key.tokenUsageEvents) ? key.tokenUsageEvents : []).filter((item: any) => Number(item?.at || 0) >= tokenCutoff);
  
  let opusTokensUsed = 0;
  let geminiTokensUsed = 0;
  let recentWindowTokens = 0;
  
  tokenUsageEvents.forEach((item: any) => {
    const modelKey = String(item?.modelKey || "").toLowerCase();
    const isGemini = modelKey.includes("gemini") || modelKey.startsWith("gem");
    const total = Number(item?.totalTokens || 0);
    const input = Number(item?.inputTokens || 0);
    const output = Number(item?.outputTokens || 0);
    const billable = Math.max(0, Math.floor(total || input + output || 0));
    
    recentWindowTokens += billable;
    if (isGemini) {
      geminiTokensUsed += billable;
    } else {
      opusTokensUsed += billable;
    }
  });

  const baseTokenLimit = Math.max(0, Math.floor(Number(
    key.tokenWindowLimit ??
    key.windowTokenLimit ??
    key.tokenLimit ??
    ((Number(key.windowLimit || 0) || 0) * DEFAULT_ACCESS_KEY_TOKENS_PER_REQUEST)
  )));

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
    windowLimit: Number(key.windowLimit || 0),
    totalInputTokens: Number(key.totalInputTokens || 0),
    totalOutputTokens: Number(key.totalOutputTokens || 0),
    totalTokensUsed: Number(key.totalTokensUsed || 0),
    recentWindowTokens,
    opusTokensUsed,
    opusTokenLimit: baseTokenLimit,
    geminiTokensUsed,
    geminiTokenLimit: baseTokenLimit * 5,
    tokenWindowMs,
    tokenWindowLimit: baseTokenLimit,
    tokenWindowRemaining: baseTokenLimit > 0 ? Math.max(0, baseTokenLimit - recentWindowTokens) : 0,
    lastUsedAt: key.lastUsedAt || "",
    createdAt: key.createdAt || "",
  };
}

function durationToMs(value: string): number {
  if (value === "1h") return 60 * 60 * 1000;
  if (value === "5h") return 5 * 60 * 60 * 1000;
  if (value === "1d") return 24 * 60 * 60 * 1000;
  if (value === "1m") return 30 * 24 * 60 * 60 * 1000;
  return 60 * 60 * 1000;
}

function readAccessKeyDurationMs(payload: any): number {
  const amount = Math.max(1, Math.min(3650, Math.floor(Number(payload?.durationValue || payload?.durationAmount || 0))));
  const unit = String(payload?.durationUnit || payload?.durationType || "").toLowerCase();
  if (amount > 0 && (unit === "d" || unit === "day" || unit === "days")) return amount * 24 * 60 * 60 * 1000;
  if (amount > 0 && (unit === "h" || unit === "hour" || unit === "hours")) return amount * 60 * 60 * 1000;
  return durationToMs(String(payload?.duration || "1h"));
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
  try {
    const rtsPort = getRemoteTokenServerPort();
    await fetch(`http://127.0.0.1:${rtsPort}/reload-accounts`, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
    });
  } catch { /* rts might not be running */ }
}

function emptyFamilyPool(): FamilyPoolData {
  return { mothers: [], seats: [], candidates: [], children: [], events: [] };
}

function readFamilyPool(): FamilyPoolData {
  if (!fs.existsSync(FAMILY_POOL_PATH)) return emptyFamilyPool();
  try {
    const parsed = JSON.parse(fs.readFileSync(FAMILY_POOL_PATH, "utf8"));
    return {
      mothers: Array.isArray(parsed.mothers) ? parsed.mothers : [],
      seats: Array.isArray(parsed.seats) ? parsed.seats : [],
      candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [],
      children: Array.isArray(parsed.children) ? parsed.children : [],
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
      const METADATA = { ideName: "antigravity", ideType: "ANTIGRAVITY", ideVersion: "1.21.6", pluginVersion: "1.21.6", platform: "WINDOWS_AMD64", updateChannel: "stable", pluginType: "GEMINI" };
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

    let child = pool.children.find((item) => normalizeEmail(item.email) === email);
    if (!child) {
      child = {
        id: newId("child"),
        email,
        rosettaAccountId: account.id,
        status: eligibleToEnable ? "active" : "activated_pending_member",
        createdAt: now,
        updatedAt: now,
      };
      pool.children.push(child);
    }
    child.rosettaAccountId = account.id;
    child.assignedMotherId = seat.motherId;
    child.assignedSeatId = seat.id;
    child.activatedAt = String(payload.activatedAt || child.activatedAt || now);
    child.tokenObtainedAt = child.tokenObtainedAt || child.activatedAt;
    child.isFamilyMember = eligibleToEnable;
    child.status = eligibleToEnable ? "active" : "activated_pending_member";
    child.updatedAt = now;

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

async function handleFamilyChild(req: NextRequest): Promise<NextResponse> {
  try {
    const payload = await req.json();
    const email = normalizeEmail(payload.email);
    const now = nowIso();
    const pool = readFamilyPool();

    if (payload.delete === true) {
      const id = String(payload.id || "");
      const before = pool.children.length;
      pool.children = pool.children.filter((item) => {
        if (id && item.id === id) return false;
        return !(email && normalizeEmail(item.email) === email);
      });
      if (pool.children.length === before) return json({ ok: false, error: "child not found" }, { status: 404 });
      appendFamilyEvent(pool, {
        type: "child_deleted",
        email,
        message: `Child pool account ${email || id} deleted.`,
      });
      writeFamilyPool(pool);
      return json({ ok: true, pool });
    }

    if (!email) return json({ ok: false, error: "child email is required" }, { status: 400 });

    let child = String(payload.id || "")
      ? pool.children.find((item) => item.id === String(payload.id))
      : pool.children.find((item) => normalizeEmail(item.email) === email);
    if (!child) {
      child = {
        id: newId("child"),
        email,
        alias: String(payload.alias || "").trim(),
        loginPassword: String(payload.loginPassword || "").trim(),
        recoveryEmail: normalizeEmail(payload.recoveryEmail),
        totpSecret: String(payload.totpSecret || "").trim(),
        rosettaAccountId: Number(payload.rosettaAccountId) || undefined,
        activationTaskId: String(payload.activationTaskId || "").trim() || undefined,
        activationStatus: String(payload.activationStatus || "").trim() || undefined,
        activationError: String(payload.activationError || "").trim() || undefined,
        activatedAt: String(payload.activatedAt || "").trim() || undefined,
        tokenObtainedAt: String(payload.tokenObtainedAt || "").trim() || undefined,
        assignedMotherId: String(payload.assignedMotherId || "").trim() || undefined,
        assignedSeatId: String(payload.assignedSeatId || "").trim() || undefined,
        isFamilyMember: payload.isFamilyMember === true,
        joinStatus: String(payload.joinStatus || "").trim() || undefined,
        joinError: String(payload.joinError || "").trim() || undefined,
        status: String(payload.status || "idle"),
        notes: String(payload.notes || "").trim(),
        createdAt: now,
        updatedAt: now,
      };
      pool.children.push(child);
      appendFamilyEvent(pool, {
        type: "child_created",
        email,
        message: `Child pool account ${email} created.`,
      });
    } else {
      child.email = email;
      if (payload.alias !== undefined) child.alias = String(payload.alias || "").trim();
      if (payload.loginPassword !== undefined) child.loginPassword = String(payload.loginPassword || "").trim();
      if (payload.recoveryEmail !== undefined) child.recoveryEmail = normalizeEmail(payload.recoveryEmail);
      if (payload.totpSecret !== undefined) child.totpSecret = String(payload.totpSecret || "").trim();
      if (payload.rosettaAccountId !== undefined) child.rosettaAccountId = Number(payload.rosettaAccountId) || undefined;
      if (payload.activationTaskId !== undefined) child.activationTaskId = String(payload.activationTaskId || "").trim() || undefined;
      if (payload.activationStatus !== undefined) child.activationStatus = String(payload.activationStatus || "").trim() || undefined;
      if (payload.activationError !== undefined) child.activationError = String(payload.activationError || "").trim() || undefined;
      if (payload.activatedAt !== undefined) child.activatedAt = String(payload.activatedAt || "").trim() || undefined;
      if (payload.tokenObtainedAt !== undefined) child.tokenObtainedAt = String(payload.tokenObtainedAt || "").trim() || undefined;
      if (payload.assignedMotherId !== undefined) child.assignedMotherId = String(payload.assignedMotherId || "").trim() || undefined;
      if (payload.assignedSeatId !== undefined) child.assignedSeatId = String(payload.assignedSeatId || "").trim() || undefined;
      if (payload.isFamilyMember !== undefined) child.isFamilyMember = payload.isFamilyMember === true;
      if (payload.joinStatus !== undefined) child.joinStatus = String(payload.joinStatus || "").trim() || undefined;
      if (payload.joinError !== undefined) child.joinError = String(payload.joinError || "").trim() || undefined;
      if (payload.status !== undefined) child.status = String(payload.status || "idle");
      if (payload.notes !== undefined) child.notes = String(payload.notes || "").trim();
      child.updatedAt = now;
      appendFamilyEvent(pool, {
        type: "child_updated",
        email,
        message: `Child pool account ${email} updated.`,
      });
    }

    if (child.rosettaAccountId) {
      const accountData = readAccountsData();
      const account = findAccountByIdOrEmail(accountData.accounts, child.rosettaAccountId, email);
      if (account) {
        account.familyRole = "child";
        account.familyStatus = child.status || account.familyStatus || "activated_pending_member";
        account.motherId = child.assignedMotherId || account.motherId || "";
        account.seatId = child.assignedSeatId || account.seatId || "";
        writeAccountsData(accountData);
        await notifyProxyReload();
      }
    }

    writeFamilyPool(pool);
    return json({ ok: true, child, pool });
  } catch (err: any) {
    return json({ ok: false, error: err.message || String(err) }, { status: 500 });
  }
}

function accessKeyMatchesSearch(key: any, search: string): boolean {
  const term = search.trim().toLowerCase();
  if (!term) return true;
  const values = [
    key.id,
    key.name,
    key.key,
    key.status,
    key.sessionClientId,
    key.activeSessionId,
    key.firstUsedAt,
    key.lastUsedAt,
    key.createdAt,
  ];
  return values.some((value) => String(value || "").toLowerCase().includes(term));
}

function handleAccessKeys(req: NextRequest) {
  const data = readAccessKeysData();
  const search = String(req.nextUrl.searchParams.get("search") || req.nextUrl.searchParams.get("q") || "").trim();
  const keys = data.keys.filter((key) => accessKeyMatchesSearch(key, search));
  return json({
    keys: keys.map(safeAccessKey),
    total: keys.length,
    totalAll: data.keys.length,
    search,
    accessKeysPath: ACCESS_KEYS_PATH,
    defaults: {
      windowMs: DEFAULT_ACCESS_KEY_WINDOW_MS,
      windowLimit: 0,
      tokenWindowLimit: 0,
    },
  });
}

function readAccessKeyWindowLimit(value: unknown): number {
  if (value === undefined || value === null || String(value).trim() === "") return 0;
  const num = Number(value);
  return Math.max(0, Math.min(5000, Number.isFinite(num) && num > 0 ? Math.floor(num) : 0));
}

function readAccessKeyTokenWindowLimit(payload: any, windowLimit: number): number {
  const raw =
    payload?.tokenWindowLimit ??
    payload?.windowTokenLimit ??
    payload?.tokenLimit;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return windowLimit > 0 ? Math.min(500_000_000, windowLimit * DEFAULT_ACCESS_KEY_TOKENS_PER_REQUEST) : 0;
  }
  const explicit = Number(raw);
  return Math.max(
    0,
    Math.min(500_000_000, Number.isFinite(explicit) && explicit > 0 ? Math.floor(explicit) : 0)
  );
}

async function handleCreateAccessKey(req: NextRequest) {
  try {
    const payload = await req.json();
    const data = readAccessKeysData();
    const now = nowIso();
    const count = Math.max(1, Math.min(200, Math.floor(Number(payload.count || 1))));
    const baseName = String(payload.name || "").trim();
    const windowLimit = readAccessKeyWindowLimit(payload.windowLimit);
    const tokenWindowLimit = readAccessKeyTokenWindowLimit(payload, windowLimit);
    const records = Array.from({ length: count }, (_, index) => ({
      id: newId("key"),
      name: count > 1 && baseName ? `${baseName}-${index + 1}` : baseName,
      key: newAccessKeyValue(),
      status: "active",
      durationMs: readAccessKeyDurationMs(payload),
      firstUsedAt: "",
      totalRequests: 0,
      usageEvents: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokensUsed: 0,
      tokenUsageEvents: [],
      windowMs: DEFAULT_ACCESS_KEY_WINDOW_MS,
      windowLimit,
      tokenWindowMs: DEFAULT_ACCESS_KEY_WINDOW_MS,
      tokenWindowLimit,
      createdAt: now,
      updatedAt: now,
    }));
    data.keys.unshift(...records);
    writeAccessKeysData(data);
    return json({ ok: true, key: safeAccessKey(records[0]), keys: records.map(safeAccessKey), count: records.length });
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
      record.windowLimit = readAccessKeyWindowLimit(payload.windowLimit);
    }
    if (payload.tokenWindowLimit !== undefined || payload.windowTokenLimit !== undefined || payload.tokenLimit !== undefined) {
      record.tokenWindowLimit = readAccessKeyTokenWindowLimit(payload, Number(record.windowLimit || 0));
      record.tokenWindowMs = Number(record.tokenWindowMs || record.windowMs || DEFAULT_ACCESS_KEY_WINDOW_MS);
    }
    record.updatedAt = nowIso();
    writeAccessKeysData(data);
    return json({ ok: true, key: safeAccessKey(record) });
  } catch (err: any) {
    return json({ ok: false, error: err.message || String(err) }, { status: 500 });
  }
}

async function handleDeleteAccessKey(req: NextRequest) {
  try {
    const payload = await req.json();
    const ids: string[] = Array.isArray(payload.ids)
      ? payload.ids.map((v: any) => String(v).trim()).filter(Boolean)
      : [String(payload.id || "").trim()].filter(Boolean);
    if (!ids.length) return json({ ok: false, error: "id or ids required" }, { status: 400 });
    const data = readAccessKeysData();
    const idSet = new Set(ids);
    const before = data.keys.length;
    data.keys = data.keys.filter((item) => !idSet.has(item.id));
    const deleted = before - data.keys.length;
    if (deleted === 0) return json({ ok: false, error: "No matching keys found" }, { status: 404 });
    writeAccessKeysData(data);
    return json({ ok: true, deleted });
  } catch (err: any) {
    return json({ ok: false, error: err.message || String(err) }, { status: 500 });
  }
}

async function handleEmployeeRegister(req: NextRequest) {
  try {
    const payload = await req.json();
    const email = normalizeEmail(payload.email);
    const password = String(payload.password || "");
    if (!email || !email.includes("@")) return json({ ok: false, error: "邮箱不正确" }, { status: 400 });
    if (password.length < 6) return json({ ok: false, error: "密码至少 6 位" }, { status: 400 });
    const data = readEmployeesData();
    if (data.employees.some((item) => normalizeEmail(item.email) === email)) {
      return json({ ok: false, error: "员工已注册" }, { status: 409 });
    }
    const now = nowIso();
    const employee = {
      id: newId("emp"),
      email,
      passwordHash: hashEmployeePassword(password),
      status: "active",
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now,
    };
    const token = `emp_${cryptoRandom(24).toLowerCase()}`;
    data.employees.push(employee);
    data.sessions.push({
      token,
      employeeId: employee.id,
      createdAt: now,
      expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
    });
    writeEmployeesData(data);
    return json({ ok: true, token, employee: safeEmployee(employee, data.accounts) });
  } catch (err: any) {
    return json({ ok: false, error: err.message || String(err) }, { status: 500 });
  }
}

async function handleEmployeeLogin(req: NextRequest) {
  try {
    const payload = await req.json();
    const email = normalizeEmail(payload.email);
    const password = String(payload.password || "");
    const data = readEmployeesData();
    const employee = data.employees.find((item) => normalizeEmail(item.email) === email && item.status !== "disabled");
    if (!employee || !verifyEmployeePassword(password, employee.passwordHash)) {
      return json({ ok: false, error: "邮箱或密码错误" }, { status: 401 });
    }
    const now = nowIso();
    const token = `emp_${cryptoRandom(24).toLowerCase()}`;
    employee.lastActiveAt = now;
    employee.updatedAt = now;
    data.sessions.push({
      token,
      employeeId: employee.id,
      createdAt: now,
      expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
    });
    data.sessions = data.sessions.filter((item) => !item.expiresAt || Date.parse(item.expiresAt) > Date.now()).slice(-1000);
    writeEmployeesData(data);
    return json({ ok: true, token, employee: safeEmployee(employee, data.accounts) });
  } catch (err: any) {
    return json({ ok: false, error: err.message || String(err) }, { status: 500 });
  }
}

function handleEmployeeMe(req: NextRequest) {
  const data = readEmployeesData();
  const auth = employeeSessionFromRequest(req, data);
  if (!auth) return json({ ok: false, error: "未登录" }, { status: 401 });
  return json({
    ok: true,
    employee: safeEmployee(auth.employee, data.accounts),
    accounts: data.accounts.filter((item) => item.employeeId === auth.employee.id),
  });
}

async function handleEmployeeSubmitAccount(req: NextRequest) {
  try {
    const data = readEmployeesData();
    const auth = employeeSessionFromRequest(req, data);
    if (!auth) return json({ ok: false, error: "未登录" }, { status: 401 });
    const payload = await req.json();
    const email = normalizeEmail(payload.email);
    const refreshToken = String(payload.refreshToken || "").trim();
    const projectId = String(payload.projectId || "").trim();
    const localAccountId = Number(payload.localAccountId || 0) || undefined;
    const lastConversationOkAt = String(payload.lastConversationOkAt || "").trim();
    if (!email || !refreshToken || !projectId) {
      return json({ ok: false, error: "缺少邮箱、refreshToken 或 projectId" }, { status: 400 });
    }
    if (!lastConversationOkAt) {
      return json({ ok: false, error: "账号还没有完成一次真实对话测试" }, { status: 400 });
    }

    const now = nowIso();
    let employeeAccount = data.accounts.find(
      (item) => item.employeeId === auth.employee.id && normalizeEmail(item.email) === email
    );
    if (!employeeAccount) {
      employeeAccount = { id: newId("empacc"), employeeId: auth.employee.id, email, createdAt: now };
      data.accounts.unshift(employeeAccount);
    }
    Object.assign(employeeAccount, {
      localAccountId,
      projectId,
      planType: String(payload.planType || employeeAccount.planType || ""),
      status: "accepted",
      acceptedAt: employeeAccount.acceptedAt || now,
      lastSubmittedAt: now,
      lastConversationOkAt,
      disabledByEmployee: Boolean(payload.disabledByEmployee || false),
      deletedByEmployee: Boolean(payload.deletedByEmployee || false),
      updatedAt: now,
    });
    auth.employee.lastActiveAt = now;
    auth.employee.updatedAt = now;

    const central = readAccountsData();
    const existing = central.accounts.find((item) => normalizeEmail(item.email) === email);
    if (existing) {
      existing.refreshToken = refreshToken;
      existing.enabled = existing.enabled !== false;
      existing.projectId = projectId;
      existing.projectIdSource = existing.projectIdSource || "employee";
      existing.planType = String(payload.planType || existing.planType || "");
      existing.source = existing.source || "employee";
      existing.sourceEmployeeId = auth.employee.id;
      existing.sourceEmployeeEmail = auth.employee.email;
      existing.lastConversationOkAt = lastConversationOkAt;
    } else {
      const maxId = central.accounts.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0);
      central.accounts.push({
        id: maxId + 1,
        email,
        refreshToken,
        enabled: true,
        alias: `employee:${auth.employee.email}`,
        oauthProfile: "antigravity",
        projectId,
        projectIdSource: "employee",
        planType: String(payload.planType || ""),
        source: "employee",
        sourceEmployeeId: auth.employee.id,
        sourceEmployeeEmail: auth.employee.email,
        lastConversationOkAt,
      } as any);
    }
    writeAccountsData(central);
    writeEmployeesData(data);
    void notifyProxyReload().catch(() => undefined);
    return json({ ok: true, account: employeeAccount, employee: safeEmployee(auth.employee, data.accounts) });
  } catch (err: any) {
    return json({ ok: false, error: err.message || String(err) }, { status: 500 });
  }
}

function handleEmployeesAdmin() {
  const data = readEmployeesData();
  return json({
    ok: true,
    employees: data.employees.map((employee) => safeEmployee(employee, data.accounts)),
    accounts: data.accounts,
    employeesPath: EMPLOYEES_PATH,
  });
}


// ─── Captcha Unblock (file-based state) ──────────────────────────────────

interface CaptchaUnblockTask {
  id: string;
  email: string;
  password: string;
  recoveryEmail: string;
  totpSecret: string;
  phase: "first" | "second";
  source: string;
  status: string; // PENDING | RUNNING | CAPTCHA_WAITING | PHONE_VERIFYING | APPEAL_REQUIRED | WAITING_SECOND_VERIFY | UNBLOCKED | FAILED_FINAL
  taskId?: string;
  usedPhone?: string;
  appealAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

function readCaptchaUnblockData(): { tasks: CaptchaUnblockTask[] } {
  if (!fs.existsSync(CAPTCHA_UNBLOCK_PATH)) return { tasks: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(CAPTCHA_UNBLOCK_PATH, "utf8"));
    return { tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [] };
  } catch {
    return { tasks: [] };
  }
}

function writeCaptchaUnblockData(data: { tasks: CaptchaUnblockTask[] }) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CAPTCHA_UNBLOCK_PATH, JSON.stringify(data, null, 2), "utf8");
}

async function handleCaptchaUnblock(req: NextRequest): Promise<NextResponse> {
  try {
    const payload = await req.json();
    const creds = payload.credentials || {};
    const email = normalizeEmail(creds.email);
    const password = String(creds.password || "");
    const recoveryEmail = String(creds.recoveryEmail || "");
    const totpSecret = String(creds.totpSecret || "");
    const phase = String(payload.phase || "first");
    const source = String(payload.source || "captcha-unblock");

    if (!email) return json({ ok: false, error: "email 不能为空" }, { status: 400 });
    if (!password) return json({ ok: false, error: "password 不能为空" }, { status: 400 });

    const data = readCaptchaUnblockData();

    // Create task
    const task: CaptchaUnblockTask = {
      id: newId("unblock"),
      email,
      password,
      recoveryEmail,
      totpSecret,
      phase: phase === "second" ? "second" : "first",
      source,
      status: "PENDING",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    // For phase 2, try to find existing phase 1 task to get usedPhone
    if (phase === "second") {
      const existing = data.tasks.find(
        (t) => normalizeEmail(t.email) === email && t.usedPhone && t.status === "WAITING_SECOND_VERIFY"
      );
      if (existing) {
        task.usedPhone = existing.usedPhone;
        existing.status = "PHASE2_STARTED";
        existing.updatedAt = nowIso();
      }
    }

    data.tasks.unshift(task);
    // Keep last 500 tasks
    data.tasks = data.tasks.slice(0, 500);
    writeCaptchaUnblockData(data);

    // Parse phones from payload
    const rawPhones = Array.isArray(payload.phones) ? payload.phones : [];
    const phones = rawPhones
      .filter((p: any) => p && p.phoneNumber && p.smsUrl)
      .map((p: any) => ({
        phoneNumber: String(p.phoneNumber),
        countryCode: String(p.countryCode || "+1"),
        smsUrl: String(p.smsUrl),
      }));

    // Submit to backend worker queue
    try {
      const automationPayload: Record<string, unknown> = {
        action: "oauth" as const,
        email,
        password,
        recoveryEmail,
        totpSecret,
        source,
        keepBrowserOpenOnChallenge: true,
      };
      if (phones.length > 0) {
        automationPayload.phones = phones;
      }
      const backendResp = await fetch(`${BACKEND_BASE_URL}/automation/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(automationPayload),
        signal: AbortSignal.timeout(10000),
      });
      const backendData = await backendResp.json().catch(() => ({}));
      if (backendData.taskId) {
        task.taskId = backendData.taskId;
        task.status = "RUNNING";
        task.updatedAt = nowIso();
        writeCaptchaUnblockData(data);
      }
    } catch (err: any) {
      console.warn("[captcha-unblock] Failed to submit to backend:", err.message);
    }

    return json({ ok: true, task: { id: task.id, email, status: task.status } });
  } catch (err: any) {
    return json({ ok: false, error: err.message }, { status: 500 });
  }
}

async function handleCaptchaUnblockStatus(): Promise<NextResponse> {
  const data = readCaptchaUnblockData();

  // Refresh status from backend for running tasks
  for (const task of data.tasks) {
    if (task.taskId && ["RUNNING", "PENDING"].includes(task.status)) {
      try {
        const resp = await fetch(`${BACKEND_BASE_URL}/automation/status/${task.taskId}`, {
          signal: AbortSignal.timeout(5000),
        });
        const taskData = await resp.json().catch(() => null);
        if (taskData) {
          const backendStatus = String(taskData.status || "");
          if (backendStatus === "SUCCESS") {
            task.status = task.phase === "second" ? "UNBLOCKED" : "APPEAL_REQUIRED";
            task.updatedAt = nowIso();
          } else if (backendStatus === "MANUAL_REVIEW") {
            const code = String(taskData.lastErrorCode || "");
            if (code === "PHONE_VERIFIED_APPEAL_REQUIRED") {
              task.status = "APPEAL_REQUIRED";
              // Extract used phone from task payload
              try {
                const pl = JSON.parse(taskData.payload || "{}");
                if (pl.result?.usedPhone?.phoneNumber) {
                  task.usedPhone = pl.result.usedPhone.phoneNumber;
                }
              } catch {}
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
      } catch {
        // silent
      }
    }
  }

  // Save updated statuses
  writeCaptchaUnblockData(data);

  // Split into active tasks and phase2 waiting
  const tasks = data.tasks.filter((t) => t.status !== "WAITING_SECOND_VERIFY");
  const phase2 = data.tasks.filter((t) => t.status === "WAITING_SECOND_VERIFY" || t.status === "APPEAL_REQUIRED");

  return json({ tasks, phase2 });
}

async function handleCaptchaUnblockRetry(req: NextRequest): Promise<NextResponse> {
  try {
    const payload = await req.json();
    const taskId = String(payload.taskId || "");
    if (!taskId) return json({ ok: false, error: "taskId required" }, { status: 400 });

    const data = readCaptchaUnblockData();
    const task = data.tasks.find((t) => t.id === taskId);
    if (!task) return json({ ok: false, error: "Task not found" }, { status: 404 });

    // Re-submit
    task.status = "PENDING";
    task.lastErrorCode = undefined;
    task.lastErrorMessage = undefined;
    task.updatedAt = nowIso();

    try {
      const automationPayload = {
        action: "oauth" as const,
        email: task.email,
        password: task.password,
        recoveryEmail: task.recoveryEmail || "",
        totpSecret: task.totpSecret || "",
        source: task.source || "captcha-unblock",
        keepBrowserOpenOnChallenge: true,
      };
      const resp = await fetch(`${BACKEND_BASE_URL}/automation/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(automationPayload),
        signal: AbortSignal.timeout(10000),
      });
      const result = await resp.json().catch(() => ({}));
      if (result.taskId) {
        task.taskId = result.taskId;
        task.status = "RUNNING";
      }
    } catch (err: any) {
      console.warn("[captcha-unblock] Retry submit failed:", err.message);
    }

    task.updatedAt = nowIso();
    writeCaptchaUnblockData(data);
    return json({ ok: true });
  } catch (err: any) {
    return json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const segments = (await params).path;
  const route = "/" + segments.join("/");

  if (route !== "/employee/me") {
    const authError = await requireConsoleAuth(req);
    if (authError) return authError;
  }

  switch (route) {
    case "/status":
      return forwardToProxy("/status", "GET");
    case "/health":
      return forwardToProxy("/health", "GET");
    case "/remote-token-status":
      return forwardToRemoteTokenServer();
    case "/throttle-config": {
      try {
        if (!fs.existsSync(THROTTLE_CONFIG_PATH)) {
          return json({ ok: true, config: null, path: THROTTLE_CONFIG_PATH });
        }
        const raw = fs.readFileSync(THROTTLE_CONFIG_PATH, "utf8");
        const config = JSON.parse(raw);
        return json({ ok: true, config, path: THROTTLE_CONFIG_PATH });
      } catch (err: any) {
        return json({ ok: false, error: err.message }, { status: 500 });
      }
    }
    case "/access-keys":
      return handleAccessKeys(req);
    case "/employee/me":
      return handleEmployeeMe(req);
    case "/employees":
      return handleEmployeesAdmin();
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
    case "/captcha-unblock/status":
      return handleCaptchaUnblockStatus();
    case "/adspower-import-status":
      return handleAdspowerImportStatus(req);
    case "/adspower-import-history":
      return handleAdspowerImportHistory(req);
    default:
      return json({ error: "Not found" }, { status: 404 });
  }
}

// ─── AdsPower batch import: file-based profile lock + parallel workers ────

const PROFILE_LOCK_DIR = path.join(DATA_DIR, "profile-locks");

const ADSPOWER_HISTORY_FILE = path.join(DATA_DIR, "adspower-history.json");

function loadAdspowerBatches(): Map<string, any> {
  try {
    if (fs.existsSync(ADSPOWER_HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(ADSPOWER_HISTORY_FILE, "utf8"));
      return new Map(Object.entries(data));
    }
  } catch { /* ignore */ }
  return new Map();
}

function saveAdspowerBatches(batches: Map<string, any>) {
  try {
    fs.writeFileSync(ADSPOWER_HISTORY_FILE, JSON.stringify(Object.fromEntries(batches), null, 2));
  } catch { /* ignore */ }
}

// In-memory batch state backed by file
const _adspowerBatches = loadAdspowerBatches();

function lockProfile(profileId: string, owner: string): boolean {
  if (!fs.existsSync(PROFILE_LOCK_DIR)) fs.mkdirSync(PROFILE_LOCK_DIR, { recursive: true });
  const lockFile = path.join(PROFILE_LOCK_DIR, `${profileId}.lock`);
  try {
    // Check if lock exists and is stale (> 10 minutes)
    if (fs.existsSync(lockFile)) {
      const stat = fs.statSync(lockFile);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < 10 * 60 * 1000) return false; // lock is fresh, profile is busy
      // Stale lock — remove it
    }
    fs.writeFileSync(lockFile, JSON.stringify({ owner, lockedAt: new Date().toISOString(), pid: process.pid }), { flag: "wx" });
    return true;
  } catch {
    // writeFileSync with 'wx' fails if file exists (race condition safe)
    // If it exists, try the stale check
    try {
      if (fs.existsSync(lockFile)) {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs >= 10 * 60 * 1000) {
          fs.unlinkSync(lockFile);
          fs.writeFileSync(lockFile, JSON.stringify({ owner, lockedAt: new Date().toISOString(), pid: process.pid }));
          return true;
        }
      }
    } catch { /* ignore */ }
    return false;
  }
}

function unlockProfile(profileId: string): void {
  try {
    const lockFile = path.join(PROFILE_LOCK_DIR, `${profileId}.lock`);
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  } catch { /* ignore */ }
}

function touchProfileLock(profileId: string): void {
  try {
    const lockFile = path.join(PROFILE_LOCK_DIR, `${profileId}.lock`);
    if (fs.existsSync(lockFile)) {
      const now = new Date();
      fs.utimesSync(lockFile, now, now);
    }
  } catch { /* ignore */ }
}

function getAdspowerConfig(): { url: string; apiKey: string; profileIds: string[] } {
  const cfg = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) : {};
  const adspower = cfg?.employee?.adspower || {};
  return {
    url: String(adspower.url || "http://localhost:50325"),
    apiKey: String(adspower.apiKey || ""),
    profileIds: Array.isArray(adspower.profileIds) ? adspower.profileIds : [],
  };
}

function findWorkerScript(): string {
  // Try several locations
  const candidates = [
    path.join(process.cwd(), "bundled-rosetta", "employee-auto-import", "index.js"),
    path.join(process.cwd(), "..", "gfa-extension", "bundled-rosetta", "employee-auto-import", "index.js"),
    path.resolve(DATA_DIR, "..", "employee-auto-import", "index.js"),
  ];
  // Also check the extension directory pattern
  const antigravityExt = path.join(os.homedir(), ".antigravity", "extensions");
  if (fs.existsSync(antigravityExt)) {
    try {
      const dirs = fs.readdirSync(antigravityExt).filter(d => d.startsWith("bingcha.bcai-account-assistant"));
      for (const d of dirs.sort().reverse()) {
        candidates.push(path.join(antigravityExt, d, "bundled-rosetta", "employee-auto-import", "index.js"));
      }
    } catch { /* ignore */ }
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("找不到 employee-auto-import/index.js 脚本");
}

function spawnImportWorker(
  workerScript: string,
  input: Record<string, unknown>,
  onProgress: (msg: string) => void
): Promise<{ ok: boolean; refreshToken?: string; email?: string; projectId?: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [workerScript], {
      cwd: path.dirname(workerScript),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    let lastResult: any = null;
    let stdoutBuf = "";
    let stderrBuf = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "progress") onProgress(msg.message);
          else if (msg.type === "result") lastResult = msg;
        } catch { /* ignore */ }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => { stderrBuf += chunk.toString("utf8"); });

    child.on("close", (code) => {
      if (stdoutBuf.trim()) {
        try {
          const msg = JSON.parse(stdoutBuf.trim());
          if (msg.type === "result") lastResult = msg;
        } catch { /* ignore */ }
      }
      resolve(lastResult || { ok: false, error: `Worker 退出 (code=${code})${stderrBuf ? `: ${stderrBuf.substring(0, 300)}` : ""}` });
    });

    child.on("error", (err) => { resolve({ ok: false, error: `Worker 启动失败: ${err.message}` }); });

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

async function processOneImport(
  batchId: string,
  idx: number,
  cred: { email: string; password: string; recoveryEmail?: string; totpSecret?: string },
  profileId: string,
  adsCfg: { url: string; apiKey: string },
  workerScript: string
) {
  const batch = _adspowerBatches.get(batchId);
  if (!batch) return;

  batch.items[idx].status = "running";
  batch.items[idx].message = `正在使用浏览器 ${profileId} 录入...`;
  batch.running++;

  // Touch lock periodically so it doesn't go stale
  const touchTimer = setInterval(() => touchProfileLock(profileId), 60_000);

  try {
    const result = await spawnImportWorker(workerScript, {
      adspowerUrl: adsCfg.url,
      adspowerApiKey: adsCfg.apiKey || undefined,
      profileId,
      email: cred.email,
      password: cred.password,
      recoveryEmail: cred.recoveryEmail || undefined,
      totpSecret: cred.totpSecret || undefined,
    }, (msg) => {
      if (batch) batch.items[idx].message = msg;
    });

    if (result.ok && result.refreshToken) {
      // Write to accounts.json
      try {
        console.log(`[processOneImport] START SAVE for ${cred.email}`);
        const accountsData = readAccountsData();
        const email = String(result.email || cred.email).trim();
        console.log(`[processOneImport] READ: ${accountsData.accounts.length} accounts. Has ${email}: ${accountsData.accounts.some(a => normalizeEmail(a.email) === normalizeEmail(email))}`);
        const existingIdx = accountsData.accounts.findIndex(a => normalizeEmail(a.email) === normalizeEmail(email));
        const maxId = accountsData.accounts.reduce((m, a) => Math.max(m, a.id || 0), 0);
        const hasProjectId = Boolean(result.projectId);
        const patch: any = {
          email,
          refreshToken: result.refreshToken,
          enabled: hasProjectId,  // Only enable if we got a projectId
          loginPassword: cred.password,
          recoveryEmail: cred.recoveryEmail || "",
          totpSecret: cred.totpSecret || "",
          oauthProfile: "antigravity",
          ...(result.projectId ? { projectId: result.projectId } : {}),
        };
        if (existingIdx >= 0) {
          accountsData.accounts[existingIdx] = { ...accountsData.accounts[existingIdx], ...patch };
          console.log(`[processOneImport] UPDATED existing at idx=${existingIdx}, total=${accountsData.accounts.length}`);
        } else {
          accountsData.accounts.push({ id: maxId + 1, alias: "", ...patch });
          console.log(`[processOneImport] APPENDED as id=${maxId + 1}, total=${accountsData.accounts.length}`);
        }
        writeAccountsData(accountsData);
        console.log(`[processOneImport] WRITE COMPLETE for ${email}`);

        // Post-save verification: confirm the account is actually in the file
        const verifyData = readAccountsData();
        const savedOk = verifyData.accounts.some(a => normalizeEmail(a.email) === normalizeEmail(email));
        console.log(`[processOneImport] VERIFY: ${verifyData.accounts.length} accounts. Has ${email}: ${savedOk}`);
        if (!savedOk) {
          console.error(`[processOneImport] ⚠ ACCOUNT NOT FOUND AFTER WRITE: ${email} (total: ${verifyData.accounts.length})`);
          batch.items[idx].status = "failed";
          batch.items[idx].message = `⚠️ 写入验证失败: 账号未保存到文件中`;
        } else {
          console.log(`[processOneImport] Notifying proxy reload for ${email}...`);
          await notifyProxyReload();
          console.log(`[processOneImport] Proxy reload done for ${email}. Checking file again...`);
          // Check if the account survived the proxy reload
          const postReloadData = readAccountsData();
          const survivedReload = postReloadData.accounts.some(a => normalizeEmail(a.email) === normalizeEmail(email));
          console.log(`[processOneImport] POST-RELOAD: ${postReloadData.accounts.length} accounts. Has ${email}: ${survivedReload}`);
          if (!survivedReload) {
            console.error(`[processOneImport] ⚠⚠⚠ ACCOUNT DISAPPEARED AFTER PROXY RELOAD: ${email} (was ${verifyData.accounts.length}, now ${postReloadData.accounts.length})`);
          }

          if (hasProjectId) {
            batch.items[idx].status = "success";
            batch.items[idx].message = `✅ 录入成功 (项目: ${result.projectId})`;
            batch.items[idx].projectId = result.projectId;
          } else {
            batch.items[idx].status = "failed";
            batch.items[idx].message = `⚠️ 已获取Token但未拿到项目号，账号已保存但未启用`;
          }
        }
      } catch (saveErr: any) {
        console.error(`[processOneImport] SAVE ERROR for ${cred.email}: ${saveErr.message}`);
        batch.items[idx].status = "failed";
        batch.items[idx].message = `保存失败: ${saveErr.message}`;
      }
    } else {
      batch.items[idx].status = "failed";
      batch.items[idx].message = `❌ ${result.error || "未知错误"}`;
    }
  } catch (err: any) {
    batch.items[idx].status = "failed";
    batch.items[idx].message = `❌ 异常: ${err.message}`;
  } finally {
    clearInterval(touchTimer);
    unlockProfile(profileId);
    batch.running--;
    batch.completed++;
    saveAdspowerBatches(_adspowerBatches);
  }
}

async function handleAdspowerImport(req: NextRequest): Promise<NextResponse> {
  try {
    const payload = await req.json();
    const credentials: Array<{ email: string; password: string; recoveryEmail?: string; totpSecret?: string }> =
      Array.isArray(payload.credentials) ? payload.credentials : [];

    if (!credentials.length) {
      return json({ ok: false, error: "请提供至少一个账号凭证" }, { status: 400 });
    }

    const adsCfg = getAdspowerConfig();
    if (!adsCfg.profileIds.length) {
      return json({ ok: false, error: "未配置 AdsPower Profile ID，请先在插件中配置" }, { status: 400 });
    }

    const workerScript = findWorkerScript();
    const batchId = `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    // Read existing accounts to skip them
    let existingEmails = new Set<string>();
    try {
      const data = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8"));
      if (Array.isArray(data.accounts)) {
        existingEmails = new Set(data.accounts.map((a: any) => String(a.email || "").trim().toLowerCase()));
      }
    } catch { /* ignore */ }

    const initialItems = credentials.map((c) => {
      const emailLower = String(c.email || "").trim().toLowerCase();
      if (existingEmails.has(emailLower)) {
        return { email: c.email, status: "success" as const, message: "已在库中 (自动跳过)" };
      }
      return { email: c.email, status: "pending" as const, message: "排队中" };
    });

    // Initialize batch state
    _adspowerBatches.set(batchId, {
      items: initialItems,
      total: credentials.length,
      completed: initialItems.filter(i => i.status === "success").length,
      running: 0,
      createdAt: new Date().toISOString(),
    });
    saveAdspowerBatches(_adspowerBatches);

    // Fire-and-forget: process all credentials with parallel profiles
    void (async () => {
      const batch = _adspowerBatches.get(batchId)!;
      // Only queue the ones that are still "pending"
      const queue = [...credentials.map((c, i) => ({ cred: c, idx: i })).filter((_, i) => initialItems[i].status === "pending")];

      async function tryProcessNext() {
        while (queue.length > 0) {
          // Find an available profile
          let profileId: string | null = null;
          for (const pid of adsCfg.profileIds) {
            if (lockProfile(pid, `web-batch-${batchId}`)) {
              profileId = pid;
              break;
            }
          }
          if (!profileId) {
            // All profiles busy, wait and retry
            await new Promise(r => setTimeout(r, 5000));
            continue;
          }

          const item = queue.shift();
          if (!item) {
            unlockProfile(profileId);
            break;
          }

          // Process in background, don't await — allows parallel processing
          void processOneImport(batchId, item.idx, item.cred, profileId, adsCfg, workerScript);

          // Small delay before trying to grab next profile
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      await tryProcessNext();

      // Wait for all running workers to finish
      while (batch.running > 0) {
        await new Promise(r => setTimeout(r, 2000));
      }
      saveAdspowerBatches(_adspowerBatches);
    })();

    return json({ ok: true, batchId, total: credentials.length });
  } catch (err: any) {
    return json({ ok: false, error: err.message || String(err) }, { status: 500 });
  }
}

function handleAdspowerImportStatus(req: NextRequest): NextResponse {
  const batchId = new URL(req.url).searchParams.get("batchId") || "";
  const batch = _adspowerBatches.get(batchId);
  if (!batch) {
    return json({ ok: false, error: "批次不存在" }, { status: 404 });
  }
  return json({
    ok: true,
    batchId,
    items: batch.items,
    total: batch.total,
    completed: batch.completed,
    running: batch.running,
    done: batch.completed >= batch.total,
  });
}

function handleAdspowerImportHistory(req: NextRequest): NextResponse {
  // Combine all items from all batches, sorted by newest first
  const allBatches = Array.from(_adspowerBatches.values()).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const items = allBatches.flatMap(b => b.items);
  
  const total = items.length;
  const completed = items.filter(i => i.status === "success" || i.status === "failed").length;
  const running = items.filter(i => i.status === "running").length;
  
  return json({
    ok: true,
    items,
    total,
    completed,
    running,
    done: running === 0 && items.filter(i => i.status === "pending").length === 0,
  });
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

  if (!["/employee/register", "/employee/login", "/employee/submit-account"].includes(route)) {
    const authError = await requireConsoleAuth(req);
    if (authError) return authError;
  }

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
    case "/family-child":
      return handleFamilyChild(req);
    case "/access-key":
      return handleCreateAccessKey(req);
    case "/access-key-update":
      return handleUpdateAccessKey(req);
    case "/access-key-delete":
      return handleDeleteAccessKey(req);
    case "/employee/register":
      return handleEmployeeRegister(req);
    case "/employee/login":
      return handleEmployeeLogin(req);
    case "/employee/submit-account":
      return handleEmployeeSubmitAccount(req);
    case "/unblock-location":
      return forwardToRemoteTokenServerPost("/unblock-location");
    case "/unblock-accounts": {
      const body = await req.text();
      return forwardToRemoteTokenServerPostWithBody("/unblock-accounts", body);
    }
    case "/captcha-unblock":
      return handleCaptchaUnblock(req);
    case "/captcha-unblock/retry":
      return handleCaptchaUnblockRetry(req);
    case "/adspower-import":
      return handleAdspowerImport(req);
    case "/adspower-import-status":
      return handleAdspowerImportStatus(req);
    case "/adspower-import-history":
      return handleAdspowerImportHistory(req);
    case "/toggle-account": {
      const body = await req.text();
      return forwardToRemoteTokenServerPostWithBody("/toggle-account", body);
    }
    case "/export-accounts": {
      try {
        const payload = await req.json();
        const ids: number[] = Array.isArray(payload.accountIds)
          ? payload.accountIds.map((v: any) => Number(v)).filter((v: number) => Number.isFinite(v) && v > 0)
          : [];
        if (!ids.length) {
          return json({ ok: false, error: "accountIds array is required" }, { status: 400 });
        }
        const data = readAccountsData();
        const idSet = new Set(ids);
        const lines = data.accounts
          .filter((a) => idSet.has(a.id))
          .map((a) => `${a.email}-----${a.refreshToken || ""}`);
        return json({ ok: true, lines });
      } catch (err: any) {
        return json({ ok: false, error: err.message || String(err) }, { status: 500 });
      }
    }
    case "/throttle-config": {
      try {
        const payload = await req.json();
        if (payload.delete) {
          if (fs.existsSync(THROTTLE_CONFIG_PATH)) {
            fs.unlinkSync(THROTTLE_CONFIG_PATH);
          }
          return json({ ok: true, deleted: true });
        }
        const config = payload.config;
        if (!config || typeof config !== "object") {
          return json({ ok: false, error: "config object is required" }, { status: 400 });
        }
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(THROTTLE_CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
        return json({ ok: true, saved: true, path: THROTTLE_CONFIG_PATH });
      } catch (err: any) {
        return json({ ok: false, error: err.message }, { status: 500 });
      }
    }
    default:
      return json({ error: "Not found" }, { status: 404 });
  }
}
