/**
 * Rosetta state collection — ported from manager-extension/lib/repo-state.js + extension.js collectState().
 *
 * Discovers the Rosetta repo on disk, reads config / accounts / quota,
 * polls the local proxy and reverse proxy HTTP endpoints, and returns
 * a single RosettaState object that the Webview can render.
 */

import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as vscode from "vscode";

// ─── Types ──────────────────────────────────────────────────────────────
export interface RosettaQuotaEntry {
  key: string;
  label: string;
  fraction: number;
  percent: number;
  hasSnapshotPercent: boolean;
  resetTime: string;
  provider: string;
  isBlocked: boolean;
  displayPercent: number;
}

export interface RosettaQuotaGroup {
  key: string;
  title: string;
  fraction: number;
  percent: number;
  hasSnapshotPercent: boolean;
  resetTime: string;
  modelCount: number;
  blockedCount: number;
  entries: RosettaQuotaEntry[];
}

export interface RosettaAccount {
  id: number;
  email: string;
  enabled: boolean;
  alias: string;
  planType: string;
  projectId: string;
  isActive: boolean;
  quotaStatus: string;
  canRotate: boolean;
  quotaLiveBlockedCount: number;
  quotaRefreshedAt: string;
  accountResetTime: string;
  quotaGroups: RosettaQuotaGroup[];
  accountStatusLabel: string;
  accountStatusTone: string;
  hasCredentials: boolean;
  successRate: number | null;
  qualityTier: string;
  requestStats: { total: number; successes: number; failures: number };
}

export interface RosettaReverseProxy {
  running: boolean;
  url: string;
  port: number;
  apiKey: string;
  defaultModel: string;
  totalRequests: number;
  totalErrors: number;
  models: Array<{ id: string }>;
  endpoints: Array<{ path: string; format: string }>;
  routeHits: Record<string, number>;
  toolBridge: boolean;
}

export interface RosettaState {
  ready: boolean;
  problem: string;
  proxy: {
    running: boolean;
    activeEmail: string;
    totalAccounts: number;
    rotatableAccounts: number;
    totalRequests: number;
    totalRotations: number;
    statusUrl: string;
    switchUrl: string;
    reloadAccountsUrl: string;
    refreshQuotaUrl: string;
    url: string;
  };
  reverseProxy: RosettaReverseProxy;
  ide: {
    configuredUrl: string;
    expectedUrl: string;
    isConfigured: boolean;
    isLiveAttached: boolean;
  };
  logs: {
    path: string;
    exists: boolean;
    updatedAt: number;
    lines: string[];
  };
  accounts: RosettaAccount[];
  workspace: {
    rootPath: string;
    paths: RepoPaths;
  };
  config: Record<string, any>;
}

interface RepoPaths {
  rootPath: string;
  configPath: string;
  accountsPath: string;
  startScriptPath: string;
  startProcessPattern: string;
  reverseProxyScriptPath: string;
  reverseProxyProcessPattern: string;
  diagnosePath: string;
  addAccountPath: string;
  logPath: string;
  ideSettingsPath: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

function getAppDataDir(): string {
  if (IS_WIN) return process.env.APPDATA || "";
  if (IS_MAC) return process.env.HOME ? path.join(process.env.HOME, "Library", "Application Support") : "";
  // Linux / others: XDG_CONFIG_HOME or ~/.config
  return process.env.XDG_CONFIG_HOME || (process.env.HOME ? path.join(process.env.HOME, ".config") : "");
}

const PROXY_ROOT_STATE_KEY = "rosettaProxyRepoRoot";
const APP_DATA_DIR = getAppDataDir();
const DEFAULT_IDE_SETTINGS_PATH = APP_DATA_DIR
  ? path.join(APP_DATA_DIR, "Antigravity", "User", "settings.json")
  : "";
const DEFAULT_DATA_DIR = APP_DATA_DIR
  ? path.join(APP_DATA_DIR, "Antigravity", "rosetta")
  : "";

function stripJsonComments(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,\s*([}\]])/g, "$1");
}

function parseJsonc<T>(raw: string, fallback: T): T {
  try {
    const cleaned = stripJsonComments(raw).trim();
    return cleaned ? JSON.parse(cleaned) : fallback;
  } catch {
    return fallback;
  }
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  return parseJsonc(fs.readFileSync(filePath, "utf8"), fallback);
}

export function writeJsonFile(filePath: string, value: any): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// ─── Proxy repo discovery ───────────────────────────────────────────────

function hasProxyRepoFiles(rootPath: string): boolean {
  if (!rootPath) return false;
  const hasEntry =
    fs.existsSync(path.join(rootPath, "start-token-proxy.js")) ||
    fs.existsSync(path.join(rootPath, "token-proxy", "index.js"));
  if (hasEntry) return true;
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(rootPath, "package.json"), "utf8")
    );
    return pkg.name === "antigravity-rosetta";
  } catch {
    return false;
  }
}

export function resolveProxyRepoRoot(context: vscode.ExtensionContext): string {
  const candidates: string[] = [];
  const add = (p: string | undefined) => {
    if (!p) return;
    const r = path.resolve(p);
    if (!candidates.includes(r)) candidates.push(r);
  };

  // 1. User configured path (highest priority)
  const config = vscode.workspace.getConfiguration("bcai");
  add(config.get<string>("rosettaRepoPath"));

  // 2. Bundled rosetta (shipped with extension — always up-to-date)
  add(path.join(context.extensionPath, "bundled-rosetta"));

  return candidates.find((c) => hasProxyRepoFiles(c)) || "";
}

// ─── IDE settings ───────────────────────────────────────────────────────

function resolveIdeSettingsPath(filePath?: string): string {
  const candidate = (filePath || DEFAULT_IDE_SETTINGS_PATH || "").trim();
  return candidate ? path.resolve(candidate) : "";
}

export function readIdeCloudCodeUrl(filePath: string): string {
  const p = resolveIdeSettingsPath(filePath);
  if (!p || !fs.existsSync(p)) return "";
  const settings = parseJsonc(fs.readFileSync(p, "utf8"), {} as any);
  return String(settings["jetski.cloudCodeUrl"] || "").trim();
}

export function writeIdeCloudCodeUrl(filePath: string, url: string): void {
  const p = resolveIdeSettingsPath(filePath);
  if (!p) throw new Error("找不到 IDE 设置文件。");
  const next = fs.existsSync(p)
    ? parseJsonc(fs.readFileSync(p, "utf8"), {} as any)
    : ({} as any);
  if (url) {
    next["jetski.cloudCodeUrl"] = url.trim();
  } else {
    delete next["jetski.cloudCodeUrl"];
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

// ─── Log reading ────────────────────────────────────────────────────────

function readLogTail(filePath: string, maxLines = 60) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { exists: false, updatedAt: 0, lines: [] as string[] };
  }
  const stats = fs.statSync(filePath);
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean);
  return {
    exists: true,
    updatedAt: stats.mtimeMs || 0,
    lines: lines.slice(-Math.max(1, maxLines)),
  };
}

// ─── Quota snapshot ─────────────────────────────────────────────────────

function normalizePlanType(v: any): string {
  return String(v || "").trim().toLowerCase();
}

function normalizeQuotaFraction(v: any): number | null {
  const f = Number(v);
  if (!Number.isFinite(f)) return null;
  return Math.min(1, Math.max(0, f));
}

function normalizeModelLabel(label: string): string {
  return label
    .replace(/\s*\((high|low)\)\s*$/i, "")
    .replace(/\s+(high|low)\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function getProviderSortOrder(provider: string): number {
  const v = (provider || "").toUpperCase();
  if (v.includes("GOOGLE_GEMINI")) return 10;
  if (v.includes("ANTHROPIC")) return 20;
  if (v.includes("OPENAI")) return 30;
  return 40;
}

function shouldIncludeQuotaModel(m: any): boolean {
  if (!String(m?.displayName || "").trim()) return false;
  const p = String(m?.apiProvider || "").toUpperCase();
  return !p.includes("API_PROVIDER_INTERNAL");
}

function summarizeQuotaModels(modelsValue: any, options: any = {}) {
  const payload =
    typeof modelsValue === "string"
      ? parseJsonc(modelsValue, {} as any)
      : modelsValue && typeof modelsValue === "object"
        ? modelsValue
        : {};
  const models = payload?.models || payload || {};
  const groupsByBucket = new Map<string, any>();

  for (const [modelKey, modelData] of Object.entries(models) as [string, any][]) {
    if (!shouldIncludeQuotaModel(modelData)) continue;
    let fraction = normalizeQuotaFraction(modelData?.quotaInfo?.remainingFraction);
    const resetTime = String(modelData?.quotaInfo?.resetTime || "").trim();
    if (fraction === null && !resetTime) continue;
    if (fraction === null && resetTime) fraction = 0;
    const label = normalizeModelLabel(String(modelData?.displayName || modelKey));
    const hasSnapshotPercent = fraction !== null;
    const bucketKey = hasSnapshotPercent ? `${fraction}` : `unknown:${resetTime || "n/a"}`;
    const entry = {
      key: modelKey.trim(),
      label,
      fraction: hasSnapshotPercent ? fraction! : 0,
      percent: hasSnapshotPercent ? Number(((fraction! as number) * 100).toFixed(2)) : 0,
      hasSnapshotPercent,
      resetTime,
      provider: String(modelData?.apiProvider || "").trim(),
      sortOrder: getProviderSortOrder(modelData?.apiProvider || ""),
    };
    if (!groupsByBucket.has(bucketKey)) {
      groupsByBucket.set(bucketKey, {
        bucketKey,
        fraction: entry.fraction,
        percent: entry.percent,
        hasSnapshotPercent,
        resetTime,
        entriesByLabel: new Map(),
      });
    }
    const group = groupsByBucket.get(bucketKey)!;
    if (!group.entriesByLabel.has(label)) {
      group.entriesByLabel.set(label, entry);
    }
  }

  const groups = Array.from(groupsByBucket.values())
    .map((g) => ({
      key: g.bucketKey,
      title: "",
      fraction: g.fraction,
      percent: g.percent,
      hasSnapshotPercent: g.hasSnapshotPercent,
      resetTime: g.resetTime,
      modelCount: g.entriesByLabel.size,
      entries: Array.from(g.entriesByLabel.values()).sort((a: any, b: any) =>
        a.sortOrder !== b.sortOrder
          ? a.sortOrder - b.sortOrder
          : a.label.localeCompare(b.label)
      ),
    }))
    .sort((a, b) => {
      if (a.hasSnapshotPercent !== b.hasSnapshotPercent) return a.hasSnapshotPercent ? -1 : 1;
      return b.percent - a.percent;
    });
  groups.forEach((g, i) => {
    g.title = g.entries.length === 1 ? (g.entries[0] as any).label : `Group ${i + 1}`;
  });

  return {
    groups,
    planType: normalizePlanType(options.planType),
    refreshedAt: String(options.refreshedAt || "").trim(),
    accountResetTime: "",
  };
}

function readQuotaSnapshotMap(rootPath: string, config: any = {}): Map<string, any> {
  const snapshots = new Map<string, any>();
  const candidatePaths: string[] = [];

  // Centralized AppData path
  try {
    const centralPaths = require(path.join(rootPath, "shared", "paths"));
    if (typeof centralPaths.quotaDataPath === "function") {
      candidatePaths.push(centralPaths.quotaDataPath());
    }
  } catch { /* ignore */ }

  // Root fallback
  candidatePaths.push(path.join(rootPath, "quota-data.json"));

  // AppData fallback
  if (DEFAULT_DATA_DIR) {
    candidatePaths.push(path.join(DEFAULT_DATA_DIR, "quota-data.json"));
  }

  for (const qp of candidatePaths) {
    if (fs.existsSync(qp)) {
      try {
        const data = JSON.parse(fs.readFileSync(qp, "utf8"));
        for (const [email, entry] of Object.entries(data || {}) as [string, any][]) {
          const s = summarizeQuotaModels(entry.modelsJson, {
            refreshedAt: entry.refreshedAt || entry.fetchedAt,
            planType: entry.planType || entry.tier,
          });
          (s as any).alias = String(entry.alias || "").trim();
          snapshots.set(email.trim(), s);
        }
        break;
      } catch { /* next */ }
    }
  }

  return snapshots;
}

// ─── Account merging ────────────────────────────────────────────────────

function applyRuntimeQuotaState(quotaGroups: any[], blockedModels: any[]): any[] {
  const blockedMap = new Map<string, any>();
  for (const item of blockedModels || []) {
    const k = String(item?.modelKey || "").trim();
    if (k) blockedMap.set(k, item);
  }
  return (quotaGroups || []).map((group) => {
    const entries = (group.entries || []).map((entry: any) => {
      const blocked = blockedMap.get(String(entry?.key || "").trim());
      const isBlocked = Boolean(blocked);
      return {
        ...entry,
        snapshotPercent: Number(entry?.percent || 0),
        displayPercent: isBlocked ? 0 : Number(entry?.percent || 0),
        isBlocked,
      };
    });
    const blockedCount = entries.filter((e: any) => e.isBlocked).length;
    return { ...group, entries, blockedCount };
  });
}

function summarizeAccountHealth(projectId: string, quotaGroups: any[], qualityTier: string) {
  if (!projectId)
    return { statusLabel: "未拿到项目号，点刷新额度", statusTone: "danger" };
  const groups = quotaGroups || [];
  const allBlocked =
    groups.length > 0 &&
    groups.every(
      (g) => g.modelCount > 0 && g.blockedCount >= g.modelCount
    );
  if (allBlocked)
    return { statusLabel: "这号已打满", statusTone: "danger" };
  if (qualityTier === "bad")
    return { statusLabel: "质量差", statusTone: "danger" };
  const someBlocked = groups.some((g) => g.blockedCount > 0);
  if (someBlocked)
    return { statusLabel: "部分模型受限", statusTone: "warning" };
  if (qualityTier === "poor")
    return { statusLabel: "质量偏低", statusTone: "warning" };
  return { statusLabel: "", statusTone: "success" };
}

function mergeAccounts(
  accounts: any[],
  proxyStatus: any,
  quotaSnapshots: Map<string, any>
): RosettaAccount[] {
  const proxyAccounts = Array.isArray(proxyStatus?.accounts)
    ? proxyStatus.accounts
    : [];
  const proxyById = new Map(proxyAccounts.map((a: any) => [Number(a.id), a]));

  return (accounts || []).map((account) => {
    const proxyAcc = proxyById.get(Number(account.id)) || ({} as any);
    const quotaSnapshot =
      quotaSnapshots.get(String(account.email || "").trim()) || null;
    const projectId = String(
      account.projectId || proxyAcc.projectId || ""
    ).trim();
    const blockedModels = proxyAcc.blockedModels || [];
    const quotaGroups = applyRuntimeQuotaState(
      quotaSnapshot?.groups || [],
      blockedModels
    );
    const qualityTier = String(proxyAcc.qualityTier || "new");
    const health = summarizeAccountHealth(projectId, quotaGroups, qualityTier);
    return {
      id: Number(account.id),
      email: String(account.email || ""),
      enabled: account.enabled !== false,
      alias: String(account.alias || quotaSnapshot?.alias || ""),
      planType: normalizePlanType(
        proxyAcc.planType || quotaSnapshot?.planType || account.planType || ""
      ),
      projectId,
      isActive: Boolean(proxyAcc.isActive),
      quotaStatus: String(proxyAcc.quotaStatus || "unknown"),
      canRotate: Boolean(projectId),
      quotaLiveBlockedCount: quotaGroups.reduce(
        (s: number, g: any) => s + (g.blockedCount || 0),
        0
      ),
      quotaRefreshedAt: quotaSnapshot?.refreshedAt || "",
      accountResetTime: quotaSnapshot?.accountResetTime || "",
      quotaGroups,
      accountStatusLabel: health.statusLabel,
      accountStatusTone: health.statusTone,
      hasCredentials: Boolean(
        String(account.loginPassword || "").trim() &&
        String(account.totpSecret || "").trim()
      ),
      successRate: proxyAcc.successRate != null ? Number(proxyAcc.successRate) : null,
      qualityTier,
      requestStats: {
        total: Number(proxyAcc.requestStats?.total || 0),
        successes: Number(proxyAcc.requestStats?.successes || 0),
        failures: Number(proxyAcc.requestStats?.failures || 0),
      },
    };
  });
}

// ─── HTTP helpers ───────────────────────────────────────────────────────

function fetchJson(urlString: string, options: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const target = new URL(urlString);
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: options.headers || {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`状态接口返回 ${res.statusCode || 0}`));
            return;
          }
          try { resolve(raw ? JSON.parse(raw) : {}); }
          catch (e: any) { reject(new Error(`状态接口返回了坏数据: ${e.message}`)); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(options.timeoutMs || 3000, () => req.destroy(new Error("状态接口超时")));
    req.end();
  });
}

export function postJson(urlString: string, payload: any, options: { timeoutMs?: number } = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload || {}), "utf8");
    const target = new URL(urlString);
    const req = http.request(
      {
        method: "POST",
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: { "Content-Type": "application/json", "Content-Length": body.length },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            const data = raw ? JSON.parse(raw) : {};
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300 || data.ok === false)
              reject(new Error(data.error || `请求失败 (${res.statusCode})`));
            else resolve(data);
          } catch { reject(new Error("返回数据无效")); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(options.timeoutMs || 5000, () => req.destroy(new Error("请求超时")));
    req.write(body);
    req.end();
  });
}

// ─── Repo paths ─────────────────────────────────────────────────────────

function getRepoPaths(rootPath: string, config: any = {}): RepoPaths {
  let centralPaths: any = null;
  try {
    centralPaths = require(path.join(rootPath, "shared", "paths"));
  } catch { /* fallback */ }

  const resolveScript = (legacy: string, split: string): string => {
    const lp = path.resolve(rootPath, legacy);
    return fs.existsSync(lp) ? lp : path.resolve(rootPath, split);
  };

  const startScriptPath = resolveScript("start-token-proxy.js", path.join("token-proxy", "index.js"));
  const reverseProxyScriptPath = resolveScript(
    path.join("reverse-proxy", "index.js"),
    path.join("reverse-proxy", "index.js")
  );
  const diagnosePath = resolveScript("diagnose.js", "diagnose.js");
  const addAccountPath = resolveScript("add-account.js", path.join("token-proxy", "add-account.js"));

  return {
    rootPath,
    configPath: centralPaths ? centralPaths.configPath() : path.resolve(rootPath, "proxy.config.json"),
    accountsPath: centralPaths ? centralPaths.accountsPath() : path.resolve(rootPath, "accounts.json"),
    startScriptPath,
    startProcessPattern: path.relative(rootPath, startScriptPath),
    reverseProxyScriptPath,
    reverseProxyProcessPattern: path.relative(rootPath, reverseProxyScriptPath),
    diagnosePath,
    addAccountPath,
    logPath: centralPaths ? centralPaths.tokenProxyLogPath() : path.resolve(rootPath, "logs", "token-proxy.log"),
    ideSettingsPath: resolveIdeSettingsPath(config.ideSettingsPath),
  };
}

// ─── Proxy port helpers ─────────────────────────────────────────────────

function getTokenProxyPort(config: any): number {
  const v = Number(config?.tokenProxyPort);
  return Number.isFinite(v) && v > 0 ? v : 60670;
}

function getStatusPort(config: any): number {
  return getTokenProxyPort(config) + 1;
}

function getProxyUrl(config: any): string {
  return `http://127.0.0.1:${getTokenProxyPort(config)}`;
}

// ─── Main state collector ───────────────────────────────────────────────

function createEmptyState(): RosettaState {
  return {
    ready: false,
    problem: "",
    workspace: { rootPath: "", paths: {} as any },
    config: {},
    proxy: {
      running: false,
      activeEmail: "",
      totalAccounts: 0,
      rotatableAccounts: 0,
      totalRequests: 0,
      totalRotations: 0,
      statusUrl: "",
      switchUrl: "",
      reloadAccountsUrl: "",
      refreshQuotaUrl: "",
      url: "",
    },
    reverseProxy: {
      running: false,
      url: "",
      port: 8787,
      apiKey: "",
      defaultModel: "",
      totalRequests: 0,
      totalErrors: 0,
      models: [],
      endpoints: [],
      routeHits: {},
      toolBridge: false,
    },
    ide: {
      configuredUrl: "",
      expectedUrl: "",
      isConfigured: false,
      isLiveAttached: false,
    },
    logs: { path: "", exists: false, updatedAt: 0, lines: [] },
    accounts: [],
  };
}

export async function collectState(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel
): Promise<RosettaState> {
  const rootPath = resolveProxyRepoRoot(context);
  const log = (msg: string) => outputChannel.appendLine(`[rosetta-diag] ${msg}`);

  log(`rootPath=${rootPath || "(empty)"}`);

  if (!rootPath || !hasProxyRepoFiles(rootPath)) {
    log("PROBLEM: proxy repo not found");
    return {
      ...createEmptyState(),
      problem: "没找到 Rosetta 代理目录。请确认 Antigravity-Rosetta 已安装。",
    };
  }

  await context.globalState.update(PROXY_ROOT_STATE_KEY, rootPath);

  // Auto-create default config from example
  let centralPaths: any = null;
  try { centralPaths = require(path.join(rootPath, "shared", "paths")); } catch { /* */ }
  const configPath = centralPaths ? centralPaths.configPath() : path.resolve(rootPath, "proxy.config.json");
  if (!fs.existsSync(configPath)) {
    const examplePath = path.resolve(rootPath, "proxy.config.example.json");
    if (fs.existsSync(examplePath)) {
      try { fs.mkdirSync(path.dirname(configPath), { recursive: true }); fs.copyFileSync(examplePath, configPath); } catch { /* */ }
    }
  }

  const config = readJsonFile(configPath, {} as any);
  const repoPaths = getRepoPaths(rootPath, config);
  const proxyUrl = getProxyUrl(config);
  const statusPort = getStatusPort(config);
  const statusUrl = `http://127.0.0.1:${statusPort}/status`;
  const switchUrl = `http://127.0.0.1:${statusPort}/switch-account`;
  const reloadAccountsUrl = `http://127.0.0.1:${statusPort}/reload-accounts`;
  const refreshQuotaUrl = `http://127.0.0.1:${statusPort}/refresh-quota`;

  log(`configPath=${configPath} tokenProxyPort=${config.tokenProxyPort || 60670} statusPort=${statusPort}`);
  log(`accountsPath=${repoPaths.accountsPath} startScript=${repoPaths.startScriptPath}`);

  // Read IDE config
  const configuredUrl = readIdeCloudCodeUrl(repoPaths.ideSettingsPath);
  log(`IDE settings: path=${repoPaths.ideSettingsPath} configuredUrl=${configuredUrl || "(empty)"} expectedUrl=${proxyUrl}`);

  // Read logs
  const logs = { path: repoPaths.logPath, ...readLogTail(repoPaths.logPath, 60) };

  // Poll proxy status
  let proxyStatus: any = { running: false, accounts: [], totalRequests: 0, totalRotations: 0, totalAccounts: 0, rotatableAccounts: 0, activeEmail: "" };
  try {
    proxyStatus = await fetchJson(statusUrl);
    log(`proxy: running=${proxyStatus.running} accounts=${proxyStatus.totalAccounts || 0} active=${proxyStatus.activeEmail || "none"} requests=${proxyStatus.totalRequests || 0}`);
  } catch (e: any) {
    log(`proxy: OFFLINE (${e.message})`);
  }

  // Read accounts + quota
  const accountsData = readJsonFile(repoPaths.accountsPath, { accounts: [] } as any);
  const rawAccounts: any[] = Array.isArray(accountsData.accounts) ? accountsData.accounts : [];
  log(`accounts.json: ${rawAccounts.length} account(s): ${rawAccounts.map((a: any) => `${a.email}(id=${a.id},enabled=${a.enabled},oauth=${a.oauthProfile || "MISSING"})`).join(", ") || "none"}`);

  const quotaSnapshots = readQuotaSnapshotMap(rootPath, config);
  const accounts = mergeAccounts(accountsData.accounts, proxyStatus, quotaSnapshots);

  // Reverse proxy
  const rpPort = Number(config.port) || 8787;
  const rpApiKey = String(config.localApiKey || "").trim();
  const rpHeaders: Record<string, string> = rpApiKey ? { Authorization: `Bearer ${rpApiKey}` } : {};
  let reverseProxy: RosettaReverseProxy = {
    running: false,
    url: `http://127.0.0.1:${rpPort}`,
    port: rpPort,
    apiKey: rpApiKey,
    defaultModel: String(config.antigravityModel || ""),
    totalRequests: 0,
    totalErrors: 0,
    models: [],
    endpoints: [],
    routeHits: {},
    toolBridge: false,
  };
  try {
    const rpStatus = await fetchJson(`http://127.0.0.1:${rpPort}/v1/proxy/status`, { headers: rpHeaders });
    reverseProxy.running = true;
    reverseProxy.defaultModel = String(rpStatus?.default_model || config.antigravityModel || "");
    reverseProxy.totalRequests = Number(rpStatus?.metrics?.total_requests || 0);
    reverseProxy.totalErrors = Number(rpStatus?.metrics?.total_errors || 0);
    reverseProxy.routeHits = rpStatus?.metrics?.route_hits || {};
    reverseProxy.toolBridge = Boolean(rpStatus?.config?.tool_bridge?.enabled);
    log(`reverseProxy: running model=${reverseProxy.defaultModel} requests=${reverseProxy.totalRequests}`);
    try {
      const modelsResp = await fetchJson(`http://127.0.0.1:${rpPort}/v1/models`, { headers: rpHeaders });
      reverseProxy.models = (modelsResp?.data || []).map((m: any) => ({ id: m.id || m.display_name || "" }));
    } catch { /* optional */ }
    reverseProxy.endpoints = [
      { path: "/v1/chat/completions", format: "OpenAI Chat" },
      { path: "/v1/completions", format: "OpenAI Legacy" },
      { path: "/v1/responses", format: "OpenAI Responses" },
      { path: "/v1/messages", format: "Anthropic" },
      { path: "/v1/models", format: "Models List" },
    ];
  } catch { log(`reverseProxy: OFFLINE (port ${rpPort})`); }

  const ideMatch = configuredUrl === proxyUrl;
  log(`summary: proxy=${proxyStatus.running ? "ON" : "OFF"} reverseProxy=${reverseProxy.running ? "ON" : "OFF"} IDE=${ideMatch ? "ATTACHED" : "DETACHED"} accounts=${accounts.length}`);

  return {
    ready: true,
    problem: "",
    workspace: { rootPath, paths: repoPaths },
    config,
    proxy: {
      running: Boolean(proxyStatus.running),
      activeEmail: String(proxyStatus.activeEmail || ""),
      totalAccounts: Number(proxyStatus.totalAccounts || accounts.length || 0),
      rotatableAccounts: Number(proxyStatus.rotatableAccounts || 0),
      totalRequests: Number(proxyStatus.totalRequests || 0),
      totalRotations: Number(proxyStatus.totalRotations || 0),
      statusUrl,
      switchUrl,
      reloadAccountsUrl,
      refreshQuotaUrl,
      url: proxyUrl,
    },
    reverseProxy,
    ide: {
      configuredUrl,
      expectedUrl: proxyUrl,
      isConfigured: ideMatch,
      isLiveAttached: ideMatch,
    },
    logs,
    accounts,
  };
}

export function updateAccountRecord(
  data: any,
  accountId: number,
  patch: Partial<{ enabled: boolean; alias: string; loginPassword: string; totpSecret: string }>
): any {
  const next = { ...(data || {}) };
  const accounts = Array.isArray(next.accounts) ? next.accounts.map((a: any) => ({ ...a })) : [];
  const target = accounts.find((a: any) => Number(a.id) === accountId);
  if (!target) throw new Error(`Account #${accountId} not found`);
  if (patch.enabled !== undefined) target.enabled = patch.enabled;
  if (patch.alias !== undefined) target.alias = patch.alias;
  if (patch.loginPassword !== undefined) target.loginPassword = patch.loginPassword;
  if (patch.totpSecret !== undefined) target.totpSecret = patch.totpSecret;
  next.accounts = accounts;
  return next;
}
