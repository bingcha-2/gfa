import * as fs from "fs";
import * as crypto from "crypto";
import * as os from "os";
import * as path from "path";

import { Injectable, Logger, Optional } from "@nestjs/common";
import { AutomationService } from "../automation/automation.service";

import { billableTokenUsageTotal, readTokenCount, tokenWindowLimit } from "../token-server/token-billing";
import {
  type CachedToken,
  getAccessToken,
  fetchAccountHealth,
  fetchAvailableModels,
  discoverProject,
  extractTierFromModelsJson,
  DEFAULT_CLOUD_ENDPOINT,
} from "./google-api";

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
  private readonly logger = new Logger(RosettaService.name);
  /** In-memory access_token cache: accountId → { accessToken, expiresAt } */
  private readonly tokenCache = new Map<number, CachedToken>();
  /** mtime-cached file readers for hot-path list queries */
  private readonly accessKeysFile: CachedJsonFile;
  private readonly accountsFile: CachedJsonFile;

  constructor(
    @Optional() options: RosettaServiceOptions = {},
    @Optional() private readonly automation?: AutomationService,
  ) {
    this.dataDir = options.dataDir || defaultDataDir();
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
        durationMs: Number(key.durationMs || 0),
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

  private adspowerBatchRunning = false;

  /** Resolve the employee-auto-import script path */
  private get importScriptPath() {
    // Prefer the _deprecated copy that is always present on this server
    const deprecated = path.resolve(__dirname, "..", "..", "..", "..", "_deprecated", "gfa-extension", "bundled-rosetta", "employee-auto-import", "index.js");
    if (fs.existsSync(deprecated)) return deprecated;
    // Fallback: bcai-tools node_modules copy
    const nm = path.resolve(__dirname, "..", "..", "..", "..", "node_modules", ".pnpm", "node_modules", "bcai-tools", "bundled-rosetta", "employee-auto-import", "index.js");
    if (fs.existsSync(nm)) return nm;
    return "";
  }

  adspowerImport(payload: any) {
    const credentials = payload?.credentials;
    if (!Array.isArray(credentials) || !credentials.length) return { ok: false, error: "credentials array required" };

    if (this.adspowerBatchRunning) return { ok: false, error: "另一个批量录入正在进行中" };

    const scriptPath = this.importScriptPath;
    if (!scriptPath) return { ok: false, error: "employee-auto-import script not found" };

    const batchId = `batch_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
    const batch = {
      batchId,
      status: "running",
      total: credentials.length,
      completed: 0,
      failed: 0,
      createdAt: nowIso(),
      items: credentials.map((c: any) => ({
        email: String(c.email || ""),
        password: String(c.password || ""),
        recoveryEmail: String(c.recoveryEmail || ""),
        totpSecret: String(c.totpSecret || ""),
        status: "pending",
        error: "",
      })),
    };
    writeJson(this.adspowerFile, batch);

    // Fire-and-forget the batch executor
    this.runAdspowerBatch(scriptPath, batch).catch((err) => {
      this.logger.error(`[adspower-import] batch executor crashed: ${err.message}`);
    });

    return { ok: true, batchId };
  }

  /** Background batch executor: runs import script for each pending account sequentially */
  private async runAdspowerBatch(scriptPath: string, batch: any) {
    this.adspowerBatchRunning = true;
    const adspowerUrl = "http://127.0.0.1:50325";
    const adspowerApiKey = process.env.ADSPOWER_API_KEY || "";
    const poolIds = (process.env.ADSPOWER_POOL_IDS || "").split(",").filter(Boolean);
    // Use last profile in pool for import to avoid conflicts with worker
    const profileId = poolIds.length > 0 ? poolIds[poolIds.length - 1] : "";

    if (!profileId) {
      this.logger.error("[adspower-import] No ADSPOWER_POOL_IDS configured");
      batch.status = "failed";
      batch.done = true;
      writeJson(this.adspowerFile, batch);
      this.adspowerBatchRunning = false;
      return;
    }

    this.logger.log(`[adspower-import] Starting batch ${batch.batchId}: ${batch.total} accounts, profile=${profileId}`);

    try {
      for (let i = 0; i < batch.items.length; i++) {
        const item = batch.items[i];
        if (item.status !== "pending") continue;

        item.status = "running";
        writeJson(this.adspowerFile, batch);

        this.logger.log(`[adspower-import] Processing ${i + 1}/${batch.total}: ${item.email}`);

        try {
          const result = await this.spawnImportScript(scriptPath, {
            adspowerUrl,
            adspowerApiKey,
            profileId,
            email: item.email,
            password: item.password,
            totpSecret: item.totpSecret,
            recoveryEmail: item.recoveryEmail,
          });

          if (result.ok) {
            item.status = "success";
            item.message = `refreshToken: ${(result.refreshToken || "").substring(0, 15)}...`;
            if (result.projectId) item.message += ` | projectId: ${result.projectId}`;
            batch.completed++;
            this.logger.log(`[adspower-import] ✅ ${item.email} success`);

            // Auto-add to accounts.json if we got a refresh token
            if (result.refreshToken) {
              this.tryAddAccount(item.email, result.refreshToken, result.projectId);
            }
          } else {
            item.status = "failed";
            item.error = result.error || "unknown error";
            batch.failed++;
            this.logger.warn(`[adspower-import] ❌ ${item.email} failed: ${item.error}`);
          }
        } catch (err: any) {
          item.status = "failed";
          item.error = err.message || String(err);
          batch.failed++;
          this.logger.error(`[adspower-import] ❌ ${item.email} exception: ${item.error}`);
        }

        // Clear sensitive fields after processing
        delete item.password;
        delete item.totpSecret;
        delete item.recoveryEmail;
        writeJson(this.adspowerFile, batch);

        // Small delay between accounts to let AdsPower settle
        if (i < batch.items.length - 1) {
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    } finally {
      batch.status = "completed";
      batch.done = true;
      writeJson(this.adspowerFile, batch);
      this.adspowerBatchRunning = false;
      this.logger.log(`[adspower-import] Batch ${batch.batchId} done: ${batch.completed} success, ${batch.failed} failed`);
    }
  }

  /** Spawn employee-auto-import/index.js, pipe JSON via stdin, collect result from stdout */
  private spawnImportScript(scriptPath: string, input: Record<string, string>): Promise<any> {
    const { spawn } = require("child_process") as typeof import("child_process");
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath], {
        cwd: path.dirname(scriptPath),
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, NODE_PATH: path.resolve(__dirname, "..", "..", "..", "..", "node_modules") },
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      let result: any = null;

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        // Parse JSON lines as they arrive
        const lines = stdout.split("\n");
        stdout = lines.pop() || ""; // keep incomplete line
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "result") {
              result = parsed;
            } else if (parsed.type === "progress") {
              this.logger.debug(`[import-worker] ${parsed.message}`);
            }
          } catch { /* not JSON */ }
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // 6 minute timeout (script has its own 5 minute timeout)
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("import script timed out (6min)"));
      }, 6 * 60 * 1000);

      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        // Try to parse any remaining stdout
        if (stdout.trim()) {
          try {
            const parsed = JSON.parse(stdout.trim());
            if (parsed.type === "result") result = parsed;
          } catch { /* ignore */ }
        }
        if (result) {
          resolve(result);
        } else {
          reject(new Error(`script exited with code ${code}: ${stderr.substring(0, 300)}`));
        }
      });

      child.on("error", (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });

      // Write input JSON to stdin and close
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    });
  }

  /** Try to add a successfully imported account to accounts.json (Rosetta proxy) */
  private tryAddAccount(email: string, refreshToken: string, projectId?: string) {
    try {
      const accountsPath = path.join(this.dataDir, "accounts.json");
      const data = readJson(accountsPath, { accounts: [] });
      const accounts = Array.isArray(data.accounts) ? data.accounts : [];

      // Check if already exists
      if (accounts.some((a: any) => a.email === email)) {
        this.logger.log(`[adspower-import] Account ${email} already exists in accounts.json, skipping`);
        return;
      }

      // Generate next ID
      const maxId = accounts.reduce((max: number, a: any) => Math.max(max, Number(a.id) || 0), 0);
      accounts.push({
        id: maxId + 1,
        email,
        refreshToken,
        enabled: true,
        ...(projectId ? { projectId } : {}),
      });
      data.accounts = accounts;
      writeJson(accountsPath, data);
      this.logger.log(`[adspower-import] Added ${email} to accounts.json (id=${maxId + 1})`);
    } catch (err: any) {
      this.logger.warn(`[adspower-import] Failed to add ${email} to accounts.json: ${err.message}`);
    }
  }

  adspowerImportStatus(batchId: string) {
    const data = readJson(this.adspowerFile, null);
    if (!data || data.batchId !== batchId) return { ok: false, error: "batch not found" };
    // Normalize: old files on disk use "accounts", new ones use "items"
    const items = (data.items || data.accounts || []).map((it: any) => ({
      email: it.email,
      status: it.status,
      message: it.message || "",
      error: it.error || "",
    }));
    const { accounts: _drop, items: _drop2, ...rest } = data;
    return { ok: true, ...rest, items };
  }

  adspowerImportHistory() {
    const data = readJson(this.adspowerFile, null);
    if (!data) return { ok: true, batchId: null };
    // Return full data so the frontend can restore progress on page load
    const items = (data.items || data.accounts || []).map((it: any) => ({
      email: it.email,
      status: it.status,
      message: it.message || "",
      error: it.error || "",
    }));
    return {
      ok: true,
      batchId: data.batchId,
      status: data.status,
      total: data.total ?? items.length,
      completed: data.completed ?? 0,
      failed: data.failed ?? 0,
      done: data.done ?? false,
      items,
    };
  }
}
