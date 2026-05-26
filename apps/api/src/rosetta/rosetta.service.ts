import * as fs from "fs";
import * as crypto from "crypto";
import * as os from "os";
import * as path from "path";

import { Injectable } from "@nestjs/common";

import { billableTokenUsageTotal, readTokenCount, tokenWindowLimit } from "../token-server/token-billing";

type RosettaServiceOptions = {
  dataDir?: string;
};

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
  const windowMs = Number(key.tokenWindowMs || key.windowMs || 5 * 60 * 60 * 1000);
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

@Injectable()
export class RosettaService {
  private readonly dataDir: string;

  constructor(options: RosettaServiceOptions = {}) {
    this.dataDir = options.dataDir || defaultDataDir();
  }

  listAccessKeys(query: { search?: string }) {
    const data = readJson(path.join(this.dataDir, "access-keys.json"), { keys: [] });
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
    const data = readJson(path.join(this.dataDir, "accounts.json"), { accounts: [] });
    const accounts = (Array.isArray(data.accounts) ? data.accounts : []).map((account: any) => ({
      id: Number(account.id || 0),
      email: String(account.email || ""),
      enabled: account.enabled !== false,
      alias: String(account.alias || ""),
      projectId: String(account.projectId || ""),
      planType: String(account.planType || ""),
      oauthProfile: String(account.oauthProfile || ""),
      hasToken: Boolean(account.refreshToken),
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
    if (existing) {
      existing.refreshToken = refreshToken;
      existing.enabled = payload.enabled !== undefined ? payload.enabled !== false : true;
      existing.alias = String(payload.alias ?? existing.alias ?? "");
      if (payload.projectId !== undefined) existing.projectId = String(payload.projectId || "");
    } else {
      const maxId = accounts.reduce((max: number, account: any) => Math.max(max, Number(account.id || 0)), 0);
      accounts.push({
        id: maxId + 1,
        email,
        refreshToken,
        enabled: payload.enabled !== undefined ? payload.enabled !== false : true,
        alias: String(payload.alias || ""),
        oauthProfile: String(payload.oauthProfile || "antigravity"),
        projectId: String(payload.projectId || ""),
      });
    }
    writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });
    return { ok: true, email, isUpdate: Boolean(existing), totalAccounts: accounts.length };
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
    return { ok: true, totalAccounts: filtered.length };
  }

  createAccessKey(payload: any) {
    const filePath = path.join(this.dataDir, "access-keys.json");
    const data = readJson(filePath, { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const record = {
      id: String(payload?.id || `card_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`),
      key: String(payload?.key || newAccessKeyValue()),
      name: String(payload?.name || ""),
      status: String(payload?.status || "active"),
      durationMs: Number(payload?.durationMs || 60 * 60 * 1000),
      windowLimit: Number(payload?.windowLimit || 0),
      tokenWindowLimit: Number(payload?.tokenWindowLimit || 0),
      createdAt: nowIso(),
    };
    keys.push(record);
    writeJson(filePath, { ...data, keys, updatedAt: nowIso() });
    return { ok: true, key: this.publicAccessKey(record), totalKeys: keys.length };
  }

  updateAccessKey(payload: any) {
    const id = String(payload?.id || "");
    const filePath = path.join(this.dataDir, "access-keys.json");
    const data = readJson(filePath, { keys: [] });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const record = keys.find((key: any) => String(key.id) === id);
    if (!record) return { ok: false, error: "卡密不存在" };
    for (const field of ["name", "status", "durationMs", "windowLimit", "tokenWindowLimit"]) {
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
}
