import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { Injectable, Optional } from "@nestjs/common";

import { AccessKeyStore } from "./access-key-store";
import { isPermanentTokenRefreshError, maskEmail, readJsonFile, writeJsonFile } from "./data-store";
import { accountWeight, EnterpriseProbeManager, scoreAccount } from "./lease-scheduler";
import { ModelGateManager } from "./model-gates";
import {
  DEFAULT_AFFINITY_TTL_MS,
  DEFAULT_LEASE_TTL_MS,
  FIRST_QUOTA_COOLDOWN_MS,
  CAPACITY_COOLDOWN_MS,
  MAX_REMOTE_LEASE_TTL_MS,
  REMOTE_ACCOUNT_ERROR_THRESHOLD,
  TOKEN_REFRESH_FAILURE_COOLDOWN_MS,
  accessKeySessionTtlMs,
  affinityKey,
  normalizeModelKey,
  validateClientVersion,
} from "./token-billing";
import { refreshGoogleAccessToken, TokenAccount } from "./account-token-provider";

type ServiceOptions = {
  accountsFilePath?: string;
  accessKeysFilePath?: string;
  tokenProvider?: (account: TokenAccount) => Promise<string>;
  now?: () => number;
  randomId?: () => string;
  minClientVersion?: string;
  leaseTtlMs?: number;
  affinityTtlMs?: number;
  creditTracker?: { record: (accountId: number, email: string, oldAmount: number, newAmount: number) => void };
};

type LeaseRecord = {
  leaseId: string;
  accountId: number;
  email: string;
  projectId: string;
  clientId: string;
  modelKey: string;
  accessKeyId: string;
  accessKeySessionId: string;
  createdAt: number;
  expiresAt: string;
  released: boolean;
  isGeneration: boolean;
  requestBodyBytes: number;
};

type HttpErrorBody = {
  statusCode: number;
  message: string;
};

type AccountRuntimeState = {
  quotaStatus: string;
  quotaStatusReason: string;
  exhaustedAt: number;
  exhaustedUntil: number;
  consecutiveErrors: number;
  lastUsedAt: number;
  blockedModels: Map<string, { modelKey: string; reason: string; blockedAt: number; blockedUntil: number }>;
};

const MAX_TOKEN_REFRESH_CANDIDATES = 5;
const DEFAULT_COOLDOWN_MS = FIRST_QUOTA_COOLDOWN_MS || 5 * 60 * 1000;

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

export class TokenServerHttpError extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly body?: unknown) {
    super(message);
  }

  toBody(): HttpErrorBody | unknown {
    return this.body || { ok: false, error: this.message };
  }
}

@Injectable()
export class TokenServerService {
  private readonly accountsFilePath: string;
  private readonly accessKeyStore: AccessKeyStore;
  private readonly tokenProvider: (account: TokenAccount) => Promise<string>;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly minClientVersion: string;
  private readonly leaseTtlMs: number;
  private readonly affinityTtlMs: number;
  private readonly creditTracker: { record: (accountId: number, email: string, oldAmount: number, newAmount: number) => void } | null;
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly clientAffinity = new Map<string, { accountId: number; expiresAt: number }>();
  private readonly enterpriseProbe = new EnterpriseProbeManager({ log: () => undefined });
  private totalLeases = 0;
  private totalReports = 0;
  private totalErrors = 0;
  private lastError = "";
  private dailyDate = "";
  private dailyLeases = 0;
  private dailySuccesses = 0;
  private dailyErrors = 0;
  private dailyTokensUsed = 0;
  private perAccountStats = new Map<number, {
    totalLeases: number; successCount: number; errorCount: number;
    totalTokensUsed: number; totalInputTokens: number; totalOutputTokens: number;
    lastStatus: string; lastUsedAt: number;
  }>();
  private readonly accountRuntime = new Map<number, AccountRuntimeState>();
  private readonly modelGates = new ModelGateManager({ log: () => undefined });
  private _cachedAccounts: TokenAccount[] | null = null;
  private _cachedMtimeMs = 0;
  private _accountsDirty = false;
  private _accountsSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly ACCOUNTS_FLUSH_MS = 60_000; // 1 minute debounce

  private ensureDaily() {
    const today = new Date().toISOString().slice(0, 10);
    if (this.dailyDate !== today) {
      this.dailyDate = today;
      this.dailyLeases = 0;
      this.dailySuccesses = 0;
      this.dailyErrors = 0;
      this.dailyTokensUsed = 0;
    }
  }

  private ensureAccountStats(accountId: number) {
    let s = this.perAccountStats.get(accountId);
    if (!s) {
      s = { totalLeases: 0, successCount: 0, errorCount: 0, totalTokensUsed: 0, totalInputTokens: 0, totalOutputTokens: 0, lastStatus: "", lastUsedAt: 0 };
      this.perAccountStats.set(accountId, s);
    }
    return s;
  }

  constructor(@Optional() options: ServiceOptions = {}) {
    const dataDir = defaultDataDir();
    this.accountsFilePath = options.accountsFilePath || path.join(dataDir, "accounts.json");
    this.accessKeyStore = new AccessKeyStore(options.accessKeysFilePath || path.join(dataDir, "access-keys.json"));
    this.tokenProvider = options.tokenProvider || refreshGoogleAccessToken;
    this.now = options.now || Date.now;
    this.randomId = options.randomId || (() => crypto.randomUUID());
    this.minClientVersion = options.minClientVersion || process.env.BCAI_MIN_CLIENT_VERSION || "";
    this.leaseTtlMs = Number(options.leaseTtlMs || DEFAULT_LEASE_TTL_MS);
    this.affinityTtlMs = Number(options.affinityTtlMs || DEFAULT_AFFINITY_TTL_MS);
    this.creditTracker = options.creditTracker || null;
  }

  getStatus() {
    this.cleanupExpiredLeases();
    const now = this.now();
    this.modelGates.cleanupExpiredGates(now);
    for (const accountId of this.accountRuntime.keys()) {
      this.cleanupExpiredBlocks(accountId, now);
    }
    const accounts = this.readAccounts();
    const activeLeaseList = Array.from(this.leases.values()).filter((lease) => !lease.released);

    const activeLeaseCounts: Record<string, number> = {};
    for (const lease of activeLeaseList) {
      const key = String(lease.accountId);
      activeLeaseCounts[key] = (activeLeaseCounts[key] || 0) + 1;
    }

    return {
      running: true,
      mode: "remote-token-server",
      authMode: "access-key",
      totalLeases: this.totalLeases,
      totalReports: this.totalReports,
      totalErrors: this.totalErrors,
      lastError: this.lastError,
      activeLeases: activeLeaseList.length,
      affinityClients: this.clientAffinity.size,
      accounts: {
        total: accounts.length,
        enabled: accounts.filter((account) => account.enabled !== false).length,
        withProject: accounts.filter((account) => account.projectId).length,
      },
      quota: {
        accounts: accounts.map((account) => {
          const runtime = this.accountRuntime.get(account.id);
          return {
            id: account.id,
            email: account.email,
            enabled: account.enabled !== false,
            planType: account.planType || "",
            projectId: account.projectId || "",
            quotaStatus: runtime?.quotaStatus || account.quotaStatus || "ok",
            quotaStatusReason: runtime?.quotaStatusReason || account.quotaStatusReason || "",
            blockedUntil: runtime?.exhaustedUntil || account.blockedUntil || 0,
            credits: account.credits || {},
            modelQuotaFractions: account.modelQuotaFractions || {},
            modelQuotaResetTimes: account.modelQuotaResetTimes || {},
            modelQuotaRefreshedAt: account.modelQuotaRefreshedAt || 0,
            activeLeases: activeLeaseCounts[String(account.id)] || 0,
            lastConversationOkAt: account.lastConversationOkAt || "",
            lastStatus: account.lastStatus || "",
            blockedModels: runtime
              ? Array.from(runtime.blockedModels.values()).map((b) => ({
                  modelKey: b.modelKey,
                  reason: b.reason,
                  blockedAt: b.blockedAt,
                  blockedUntil: b.blockedUntil,
                }))
              : [],
          };
        }),
      },
      daily: {
        date: this.dailyDate || new Date().toISOString().slice(0, 10),
        leases: this.dailyLeases,
        successes: this.dailySuccesses,
        errors: this.dailyErrors,
        tokensUsed: this.dailyTokensUsed,
      },
      scheduler: {
        activeLeaseCounts,
        accountStats: Object.fromEntries(
          Array.from(this.perAccountStats.entries()).map(([id, s]) => [String(id), s]),
        ),
        modelGates: this.modelGates.serializeModelGates(),
        affinityClients: this.clientAffinity.size,
      },
      enterpriseProbe: this.enterpriseProbe.getStatus(),
    };
  }

  async leaseToken(req: any, payload: any) {
    const modelKey = String(payload?.modelKey || payload?.model || "").trim();
    const auth = this.accessKeyStore.resolveFromRequest(req, payload, {
      activate: true,
      enforceLimit: true,
      modelKey,
    });
    if (!auth.record) throw this.fail(401, auth.error || "Unauthorized");

    const versionCheck = validateClientVersion(payload, this.minClientVersion);
    if (!versionCheck.ok) {
      throw this.fail(versionCheck.statusCode || 426, "当前插件版本过低", {
        code: "CLIENT_UPGRADE_REQUIRED",
        error: "当前插件版本过低",
        ...versionCheck,
        ok: false,
      });
    }

    const sessionCheck = this.accessKeyStore.validateSession(auth.record, payload, this.now());
    if (!sessionCheck.ok) {
      throw this.fail(sessionCheck.statusCode || 409, sessionCheck.error || "Access key session conflict", {
        ok: false,
        error: sessionCheck.error,
        sessionClientId: sessionCheck.sessionClientId,
        sessionExpiresAt: sessionCheck.sessionExpiresAt,
        accessKeyStatus: this.accessKeyStore.publicStatus(auth.record),
      });
    }

    const clientId = String(payload?.clientId || payload?.client || "").trim();
    const accessKeySessionId = this.accessKeyStore.refreshSession(auth.record, { clientId }, this.now(), {
      create: sessionCheck.action === "create",
      rotate: sessionCheck.action === "refresh",
    });

    const tokenFailedIds: number[] = [];
    let lastError: Error | null = null;
    let account: TokenAccount | null = null;
    let accessToken = "";

    for (let attempt = 0; attempt < MAX_TOKEN_REFRESH_CANDIDATES; attempt++) {
      const extendedPayload = { ...payload };
      if (tokenFailedIds.length > 0) {
        const existing = Array.isArray(payload?.excludeAccountIds) ? payload.excludeAccountIds : [];
        extendedPayload.excludeAccountIds = [...existing, ...tokenFailedIds];
      }
      account = this.selectAccount(modelKey, clientId, extendedPayload);
      if (!account) break;

      try {
        accessToken = await this.tokenProvider(account);
        const runtime = this.ensureRuntime(account.id);
        runtime.consecutiveErrors = 0;
        lastError = null;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.markAccountTokenError(account.id, lastError.message);
        tokenFailedIds.push(account.id);
        account = null;
      }
    }

    if (!account || !accessToken) {
      throw this.fail(503, lastError?.message || "No account with projectId is available.");
    }

    this.mutateAccount(account.id, () => ({ ...account! }));
    const lease = this.createLease(account, accessKeySessionId, auth.record.id, clientId, modelKey, payload);
    this.leases.set(lease.leaseId, lease);
    this.rememberAffinity(clientId, modelKey, account.id);
    this.totalLeases++;
    this.ensureDaily();
    this.dailyLeases++;
    const accStats = this.ensureAccountStats(account.id);
    accStats.totalLeases++;
    accStats.lastUsedAt = this.now();
    this.accessKeyStore.flush();
    return {
      ok: true,
      leaseId: lease.leaseId,
      accessKeySessionId,
      sessionId: accessKeySessionId,
      sessionExpiresAt: auth.record.sessionExpiresAt || "",
      accessKeyStatus: this.accessKeyStore.publicStatus(auth.record),
      accountId: account.id,
      emailHint: maskEmail(account.email),
      accessToken,
      projectId: account.projectId,
      expiresAt: lease.expiresAt,
      probation: false,
      candidateStats: { healthyForModel: this.availableAccounts(payload, modelKey).length },
      retryPolicy: null,
    };
  }

  async reportResult(req: any, payload: any) {
    const auth = this.accessKeyStore.resolveFromRequest(req, payload);
    if (!auth.record) throw this.fail(401, auth.error || "Unauthorized");

    const leaseId = String(payload?.leaseId || "").trim();
    const lease = this.leases.get(leaseId);
    if (!lease) {
      return { ok: true, ignored: true, reason: "lease_not_found", status: this.getStatus() };
    }
    if (auth.record.id !== lease.accessKeyId) {
      throw this.fail(403, "Lease/access key mismatch");
    }

    const status = Number(payload?.status || 0);

    // 去重：已处理过的成功请求不再重复记账
    // client 的 doReportWithRetry / postBcaiWithFallback 可能导致同一个 report 被发送多次
    if (lease.released && status >= 200 && status < 400) {
      return {
        ok: true, ignored: true, reason: "already_reported",
        accessKeyStatus: this.accessKeyStore.publicStatus(auth.record),
        status: this.getStatus(),
      };
    }

    const modelKey = String(payload?.modelKey || lease.modelKey || "").trim();
    const usage = this.usageForBilling(lease, status, payload);
    this.accessKeyStore.recordUsage(lease.accessKeyId, status, usage, modelKey);
    this.accessKeyStore.refreshSession(auth.record, { clientId: lease.clientId }, this.now());
    this.accessKeyStore.flush();

    this.totalReports++;
    this.ensureDaily();
    const accStats = this.ensureAccountStats(lease.accountId);
    accStats.lastStatus = String(status);
    accStats.lastUsedAt = this.now();
    const tokens = Number(payload?.totalTokens || 0);
    const inputTokens = Number(payload?.inputTokens || 0);
    const outputTokens = Number(payload?.outputTokens || 0);
    if (status >= 200 && status < 400) {
      this.enterpriseProbe.reportResult(lease.email, true);
      this.dailySuccesses++;
      accStats.successCount++;
      accStats.totalTokensUsed += tokens;
      accStats.totalInputTokens += inputTokens;
      accStats.totalOutputTokens += outputTokens;
      this.dailyTokensUsed += tokens;
      this.markAccountSuccess(lease.accountId, modelKey);
    } else if (status >= 400) {
      lease.released = true;
      this.enterpriseProbe.reportResult(lease.email, false);
      this.clearAffinity(lease.accountId, lease.clientId, modelKey);
      this.dailyErrors++;
      accStats.errorCount++;

      if (status === 429 || status === 503) {
        const reason = String(payload?.reason || (status === 429 ? "quota" : "capacity"));
        const retryAfterMs = Number(payload?.retryAfterMs || 0);
        this.markAccountExhausted(lease.accountId, modelKey, reason, retryAfterMs);
      }
    }
    // ── 接收客户端上报的 Google 账号额度快照 ──
    if (payload?.accountQuota && typeof payload.accountQuota === "object") {
      const quota = payload.accountQuota;
      this.mutateAccount(lease.accountId, (account) => {
        if (quota.credits && typeof quota.credits === "object") {
          const oldCreditAmount = Number(account.credits?.creditAmount || 0);
          const newCreditAmount = Number(quota.credits.creditAmount || 0);
          if (this.creditTracker) {
            this.creditTracker.record(
              account.id, account.email, oldCreditAmount, newCreditAmount,
              lease.accessKeyId, auth.record.name || undefined,
            );
          }
          account.credits = {
            known: Boolean(quota.credits.known),
            available: Boolean(quota.credits.available),
            creditAmount: newCreditAmount,
            minCreditAmount: Number(quota.credits.minCreditAmount || 0),
            paidTierID: String(quota.credits.paidTierID || ""),
            creditsRefreshedAt: new Date().toISOString(),
          };
        }
        if (quota.planType && typeof quota.planType === "string") {
          account.planType = quota.planType;
        }
        if (quota.modelQuota && typeof quota.modelQuota === "object") {
          account.modelQuotaFractions = {};
          account.modelQuotaResetTimes = {};
          for (const [key, info] of Object.entries(
            quota.modelQuota as Record<string, any>,
          )) {
            account.modelQuotaFractions[key] = Number(
              info?.remainingFraction || 0,
            );
            if (info?.resetTime) {
              account.modelQuotaResetTimes[key] = String(info.resetTime);
            }
          }
          account.modelQuotaRefreshedAt = Date.now();
        }
        return account;
      });
    }

    lease.released = true;

    return {
      ok: true,
      accessKeyStatus: this.accessKeyStore.publicStatus(auth.record),
      status: this.getStatus(),
    };
  }

  activateAccessKey(req: any, payload: any) {
    const accountCard = AccessKeyStore.extractKeyFromRequest(req, payload);
    const clientId = String(payload?.deviceId || payload?.clientId || payload?.client || "").trim();

    if (!accountCard) {
      return {
        success: false,
        code: "ACCOUNT_CARD_REQUIRED",
        message: "Account card is required",
      };
    }
    if (!clientId) {
      return {
        success: false,
        code: "ACCOUNT_CARD_AND_DEVICE_REQUIRED",
        message: "Account card and device id are required",
      };
    }

    const auth = this.accessKeyStore.resolveFromRequest(req, { ...payload, accessKey: accountCard }, { activate: true });
    if (!auth.record) {
      return {
        success: false,
        code: this.activationErrorCode(auth.error),
        message: auth.error || "Account card activation failed",
      };
    }

    const sessionPayload = { ...payload, clientId };
    const sessionCheck = this.accessKeyStore.validateSession(auth.record, sessionPayload, this.now());
    if (!sessionCheck.ok) {
      return {
        success: false,
        code: "DEVICE_BOUND_TO_ANOTHER_CLIENT",
        message: sessionCheck.error || "Account card is already active on another device",
        data: {
          sessionClientId: sessionCheck.sessionClientId,
          sessionExpiresAt: sessionCheck.sessionExpiresAt,
        },
      };
    }

    this.accessKeyStore.refreshSession(auth.record, sessionPayload, this.now(), {
      create: sessionCheck.action === "create",
      rotate: sessionCheck.action === "refresh",
    });
    this.accessKeyStore.flush();

    const accessKeyStatus = this.accessKeyStore.publicStatus(auth.record);
    return {
      success: true,
      code: "OK",
      message: "Activated",
      data: {
        accountCard: {
          id: auth.record.id,
          expiresAt: accessKeyStatus.expiresAt || "",
        },
        accessKeyStatus,
      },
    };
  }

  async shadowReport(req: any, payload: any) {
    this.accessKeyStore.resolveFromRequest(req, payload);
    return { ok: true };
  }

  reloadAccessKeys() {
    this.accessKeyStore.reload();
    return { ok: true, reloaded: true };
  }

  private readAccounts(): TokenAccount[] {
    // mtime-based cache: skip re-read if file hasn't changed
    try {
      const stat = fs.statSync(this.accountsFilePath);
      if (this._cachedAccounts && stat.mtimeMs === this._cachedMtimeMs) {
        return this._cachedAccounts;
      }
      this._cachedMtimeMs = stat.mtimeMs;
    } catch {
      // File doesn't exist
      return [];
    }

    const data = readJsonFile(this.accountsFilePath);
    const accounts = Array.isArray(data) ? data : Array.isArray(data.accounts) ? data.accounts : [];
    this._cachedAccounts = accounts.map((account: any) => ({
      ...account,
      id: Number(account.id),
      email: String(account.email || ""),
      refreshToken: String(account.refreshToken || ""),
      projectId: String(account.projectId || "").trim(),
      enabled: account.enabled !== false,
    }));
    return this._cachedAccounts;
  }

  private writeAccounts(accounts: TokenAccount[]) {
    const previous = readJsonFile(this.accountsFilePath);
    const value = Array.isArray(previous) ? accounts : { ...previous, accounts };
    writeJsonFile(this.accountsFilePath, value);
    // Write-through: update cache directly to avoid re-read after frequent writes
    this._cachedAccounts = accounts;
    this._accountsDirty = false;
    try { this._cachedMtimeMs = fs.statSync(this.accountsFilePath).mtimeMs; } catch { /* noop */ }
  }

  private markAccountsDirty(): void {
    this._accountsDirty = true;
    if (!this._accountsSaveTimer) {
      this._accountsSaveTimer = setTimeout(() => {
        this._accountsSaveTimer = null;
        this.flushAccounts();
      }, TokenServerService.ACCOUNTS_FLUSH_MS);
    }
  }

  /** Modify a single account in-memory and schedule a debounced disk write. */
  mutateAccount(accountId: number, updater: (account: TokenAccount) => TokenAccount): void {
    const accounts = this.readAccounts();
    const idx = accounts.findIndex((a) => a.id === accountId);
    if (idx < 0) return;
    accounts[idx] = updater({ ...accounts[idx] });
    this._cachedAccounts = accounts;
    this.markAccountsDirty();
  }

  /** Flush dirty accounts to disk. Discards buffer if external modification detected. */
  flushAccounts(): void {
    if (this._accountsSaveTimer) {
      clearTimeout(this._accountsSaveTimer);
      this._accountsSaveTimer = null;
    }
    if (!this._accountsDirty || !this._cachedAccounts) return;

    // External modification detection: if mtime changed since our last read/write,
    // someone else modified the file → discard dirty buffer, reload from disk
    try {
      const currentMtime = fs.statSync(this.accountsFilePath).mtimeMs;
      if (currentMtime !== this._cachedMtimeMs) {
        this._cachedAccounts = null;
        this._accountsDirty = false;
        this.readAccounts(); // reload from disk
        return;
      }
    } catch { /* file deleted, proceed with write to recreate */ }

    this._accountsDirty = false;
    const previous = readJsonFile(this.accountsFilePath);
    const value = Array.isArray(previous) ? this._cachedAccounts : { ...previous, accounts: this._cachedAccounts };
    writeJsonFile(this.accountsFilePath, value);
    try { this._cachedMtimeMs = fs.statSync(this.accountsFilePath).mtimeMs; } catch { /* noop */ }
  }

  private availableAccounts(payload: any, modelKey?: string) {
    const excluded = new Set(
      (Array.isArray(payload?.excludeAccountIds) ? payload.excludeAccountIds : [])
        .map((value: unknown) => Number(value))
        .filter((value: number) => Number.isFinite(value) && value > 0),
    );
    const now = this.now();
    this.modelGates.cleanupExpiredGates(now);
    return this.readAccounts().filter((account) =>
      account.enabled !== false &&
      Boolean(account.projectId) &&
      Boolean(account.refreshToken) &&
      !excluded.has(account.id) &&
      !this.isAccountBlocked(account.id, modelKey || "", now),
    );
  }

  private selectAccount(modelKey: string, clientId: string, payload: any): TokenAccount | null {
    const candidates = this.availableAccounts(payload, modelKey);
    if (!candidates.length) return null;
    const preferredAccountId = this.preferredAccountId(clientId, modelKey);
    const now = this.now();
    return candidates
      .map((account) => ({
        account,
        score: scoreAccount(account, {
          now,
          preferredAccountId,
          modelKey,
          activeLeaseCount: (accountId, targetModel) => this.activeLeaseCount(accountId, targetModel),
          accountStats: { lastUsedAt: 0 },
          accountWeight: accountWeight(account, this.enterpriseProbe),
        }),
      }))
      .sort((a, b) => a.score - b.score || a.account.id - b.account.id)[0].account;
  }

  private createLease(
    account: TokenAccount,
    accessKeySessionId: string,
    accessKeyId: string,
    clientId: string,
    modelKey: string,
    payload: any,
  ): LeaseRecord {
    const ttlMs = Math.max(60_000, Math.min(this.leaseTtlMs, MAX_REMOTE_LEASE_TTL_MS));
    return {
      leaseId: this.randomId(),
      accountId: account.id,
      email: account.email,
      projectId: String(account.projectId || ""),
      clientId,
      modelKey,
      accessKeyId,
      accessKeySessionId,
      createdAt: this.now(),
      expiresAt: new Date(this.now() + Math.min(ttlMs, accessKeySessionTtlMs({ sessionTtlMs: ttlMs }))).toISOString(),
      released: false,
      isGeneration: payload?.isGeneration !== false,
      requestBodyBytes: Math.max(0, Number(payload?.bodyBytes || payload?.requestBodyBytes || 0)),
    };
  }

  private usageForBilling(lease: LeaseRecord, status: number, payload: any) {
    const reported = Number(payload?.totalTokens || payload?.rawTotalTokens || 0);
    if (status >= 200 && status < 400 && lease.isGeneration && reported <= 0) {
      const inputTokens = Math.max(100, Math.ceil(lease.requestBodyBytes / 4));
      const outputTokens = Math.max(50, Math.ceil(inputTokens * 0.1));
      return { inputTokens, outputTokens, rawTotalTokens: inputTokens + outputTokens, totalTokens: inputTokens + outputTokens };
    }
    return {
      inputTokens: payload?.inputTokens,
      outputTokens: payload?.outputTokens,
      cachedInputTokens: payload?.cachedInputTokens,
      rawTotalTokens: payload?.rawTotalTokens,
      totalTokens: payload?.totalTokens,
    };
  }

  private activeLeaseCount(accountId: number, modelKey: string) {
    const targetModel = normalizeModelKey(modelKey);
    return Array.from(this.leases.values()).filter((lease) =>
      !lease.released &&
      lease.accountId === accountId &&
      (!targetModel || normalizeModelKey(lease.modelKey) === targetModel),
    ).length;
  }

  private preferredAccountId(clientId: string, modelKey: string) {
    if (!clientId) return 0;
    const affinity = this.clientAffinity.get(affinityKey(clientId, modelKey));
    if (!affinity || affinity.expiresAt <= this.now()) return 0;
    return affinity.accountId;
  }

  private rememberAffinity(clientId: string, modelKey: string, accountId: number) {
    if (!clientId) return;
    this.clientAffinity.set(affinityKey(clientId, modelKey), {
      accountId,
      expiresAt: this.now() + Math.max(60_000, this.affinityTtlMs),
    });
  }

  private clearAffinity(accountId: number, clientId: string, modelKey: string) {
    if (!clientId) return;
    const key = affinityKey(clientId, modelKey);
    if (this.clientAffinity.get(key)?.accountId === accountId) this.clientAffinity.delete(key);
  }

  // ── Account runtime state management ─────────────────────────────────────

  private ensureRuntime(accountId: number): AccountRuntimeState {
    let state = this.accountRuntime.get(accountId);
    if (!state) {
      state = {
        quotaStatus: "ok", quotaStatusReason: "", exhaustedAt: 0,
        exhaustedUntil: 0, consecutiveErrors: 0, lastUsedAt: 0,
        blockedModels: new Map(),
      };
      this.accountRuntime.set(accountId, state);
    }
    return state;
  }

  private isAccountBlocked(accountId: number, modelKey: string, now: number): boolean {
    const state = this.accountRuntime.get(accountId);
    if (!state) return false;

    this.cleanupExpiredBlocks(accountId, now);

    if (state.quotaStatus === "error") return true;

    if ((state.quotaStatus === "exhausted" || state.quotaStatus === "cooling") && state.exhaustedUntil > now) {
      if (!modelKey) return true;
      const normalized = normalizeModelKey(modelKey);
      if (normalized && state.blockedModels.has(normalized)) return true;
      if (state.blockedModels.size === 0) return true;
      return false;
    }
    return false;
  }

  private cleanupExpiredBlocks(accountId: number, now: number) {
    const state = this.accountRuntime.get(accountId);
    if (!state) return;
    for (const [key, block] of state.blockedModels) {
      if (block.blockedUntil > 0 && block.blockedUntil <= now) {
        state.blockedModels.delete(key);
      }
    }
    if (state.blockedModels.size === 0 && state.exhaustedUntil > 0 && state.exhaustedUntil <= now) {
      state.quotaStatus = "ok";
      state.quotaStatusReason = "";
      state.exhaustedAt = 0;
      state.exhaustedUntil = 0;
    }
  }

  private markAccountTokenError(accountId: number, errorMessage: string) {
    const state = this.ensureRuntime(accountId);
    state.consecutiveErrors++;

    if (isPermanentTokenRefreshError(errorMessage)) {
      state.quotaStatus = "error";
      state.quotaStatusReason = "invalid_grant";
      state.exhaustedUntil = this.now() + TOKEN_REFRESH_FAILURE_COOLDOWN_MS;
    } else if (state.consecutiveErrors >= REMOTE_ACCOUNT_ERROR_THRESHOLD) {
      state.quotaStatus = "error";
      state.quotaStatusReason = "consecutive_errors";
    }
  }

  private markAccountExhausted(accountId: number, modelKey: string, reason: string, retryAfterMs: number) {
    const state = this.ensureRuntime(accountId);
    const now = this.now();
    const normalized = normalizeModelKey(modelKey);
    const isCapacity = reason.includes("capacity");
    const cooldownMs = retryAfterMs > 0 ? retryAfterMs : isCapacity ? (CAPACITY_COOLDOWN_MS || 15000) : DEFAULT_COOLDOWN_MS;
    const blockedUntil = now + cooldownMs;

    state.quotaStatus = isCapacity ? "cooling" : "exhausted";
    state.quotaStatusReason = reason;
    state.exhaustedAt = now;

    if (normalized) {
      state.blockedModels.set(normalized, { modelKey: normalized, reason, blockedAt: now, blockedUntil });
      this.modelGates.blockAccountForModel(accountId, normalized, reason, cooldownMs);
    }

    state.exhaustedUntil = Math.max(
      blockedUntil,
      ...Array.from(state.blockedModels.values()).map((b) => b.blockedUntil),
    );
  }

  private markAccountSuccess(accountId: number, modelKey: string) {
    const state = this.accountRuntime.get(accountId);
    if (!state) return;

    state.consecutiveErrors = 0;
    state.lastUsedAt = this.now();

    const normalized = normalizeModelKey(modelKey);
    if (normalized) {
      state.blockedModels.delete(normalized);
      this.modelGates.clearModelGate(accountId, normalized);
    }

    if (state.blockedModels.size === 0) {
      state.quotaStatus = "ok";
      state.quotaStatusReason = "";
      state.exhaustedAt = 0;
      state.exhaustedUntil = 0;
    } else {
      state.exhaustedUntil = Math.max(
        ...Array.from(state.blockedModels.values()).map((b) => b.blockedUntil),
      );
    }
  }

  private cleanupExpiredLeases() {
    const now = this.now();
    for (const lease of this.leases.values()) {
      if (Date.parse(lease.expiresAt) <= now) lease.released = true;
    }
    for (const [key, affinity] of this.clientAffinity.entries()) {
      if (affinity.expiresAt <= now) this.clientAffinity.delete(key);
    }
  }

  private fail(statusCode: number, message: string, body?: unknown) {
    this.totalErrors++;
    this.lastError = message;
    return new TokenServerHttpError(statusCode, message, body);
  }

  private activationErrorCode(error?: string) {
    if (!error) return "ACCOUNT_CARD_NOT_FOUND";
    if (error.includes("Missing")) return "ACCOUNT_CARD_REQUIRED";
    if (error.includes("Invalid")) return "ACCOUNT_CARD_NOT_FOUND";
    if (error.includes("disabled")) return "ACCOUNT_CARD_INACTIVE";
    if (error.includes("expired")) return "ACCOUNT_CARD_EXPIRED";
    return "ACCOUNT_CARD_NOT_FOUND";
  }
}
