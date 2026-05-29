import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { Injectable, Optional, OnModuleDestroy } from "@nestjs/common";

import { AccessKeyStore } from "./access-key-store";
import { isPermanentTokenRefreshError, maskEmail, readJsonFile, writeJsonFile } from "./data-store";
import { accountWeight, EnterpriseProbeManager, getModelQuotaResetAt, scoreAccount } from "./lease-scheduler";
import { ModelGateManager } from "./model-gates";
import {
  DEFAULT_AFFINITY_TTL_MS,
  DEFAULT_LEASE_TTL_MS,
  CAPACITY_COOLDOWN_MS,
  MAX_REMOTE_LEASE_TTL_MS,
  REMOTE_ACCOUNT_ERROR_THRESHOLD,
  REMOTE_TRANSIENT_ERROR_COOLDOWN_MS,
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
  creditTracker?: { record: (accountId: number, email: string, oldAmount: number, newAmount: number, accessKeyId?: string, accessKeyName?: string) => void };
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
  // Legacy (no-reportId) dedup only: once a success is seen, later no-reportId
  // success reports for this lease are ignored. reportId clients are deduped by
  // the access-key store's in-memory ring instead.
  successfulReportSeen: boolean;
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
  transientErrors: number;
  lastUsedAt: number;
  blockedModels: Map<string, { modelKey: string; reason: string; blockedAt: number; blockedUntil: number }>;
};

/** Per-account active-lease counts, built once per request from this.leases. */
type ActiveLeaseIndex = Map<number, { total: number; perModel: Map<string, number> }>;

const MAX_TOKEN_REFRESH_CANDIDATES = 5;
// Hard ceiling on how many candidates a single lease will scan, so a large
// account pool can't turn one lease into dozens of token-refresh round trips.
const MAX_TOKEN_CANDIDATE_SCAN_CAP = 30;
// 429 (quota exhausted) with no retryAfter: park the account until its 5h model
// quota actually refreshes, capped at 1h; if the reset time is unknown, fall
// back to 1h. (Both the cap and the fallback are this same 1h value.)
const QUOTA_EXHAUSTION_COOLDOWN_CAP_MS = 60 * 60 * 1000;
// 403 (verification / service_disabled) with no server-provided retry hint:
// bench the account for 1h instead of the soft transient path.
const FORBIDDEN_COOLDOWN_MS = 60 * 60 * 1000;
// After a lease's TTL, keep it around this much longer so a late/retried report
// (client switching to a fresh token at the TTL boundary) still finds it and
// counts. The lease is no longer "active" for load/scoring during the grace —
// only retained so its report can still be attributed.
const REPORT_GRACE_MS = 60 * 1000;

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
export class TokenServerService implements OnModuleDestroy {
  private readonly accountsFilePath: string;
  private readonly accessKeyStore: AccessKeyStore;
  private readonly tokenProvider: (account: TokenAccount) => Promise<string>;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly minClientVersion: string;
  private readonly leaseTtlMs: number;
  private readonly affinityTtlMs: number;
  private readonly creditTracker: { record: (accountId: number, email: string, oldAmount: number, newAmount: number, accessKeyId?: string, accessKeyName?: string) => void } | null;
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
    this.minClientVersion = options.minClientVersion ?? process.env.BCAI_MIN_CLIENT_VERSION ?? "5.2.0";
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
    const leaseIndex = this.buildActiveLeaseIndex();
    const activeLeaseCounts: Record<string, number> = {};
    let activeLeasesTotal = 0;
    for (const [accountId, entry] of leaseIndex) {
      activeLeaseCounts[String(accountId)] = entry.total;
      activeLeasesTotal += entry.total;
    }

    return {
      running: true,
      mode: "remote-token-server",
      authMode: "access-key",
      totalLeases: this.totalLeases,
      totalReports: this.totalReports,
      totalErrors: this.totalErrors,
      lastError: this.lastError,
      activeLeases: activeLeasesTotal,
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

    // Prune expired leases up front (this is the path that grows the Map), then
    // build the active-lease index ONCE for the whole retry loop — leases don't
    // change until we add ours at the end, so the index stays valid.
    this.cleanupExpiredLeases();
    const leaseIndex = this.buildActiveLeaseIndex();

    // Scan candidates (not just the top few) until one's token refreshes
    // successfully. Each failed candidate is excluded from the next
    // selectAccount() via tokenFailedIds, so selectAccount() returns null once
    // the pool is drained — the loop is guaranteed to terminate. Bounded to
    // [MAX_TOKEN_REFRESH_CANDIDATES, MAX_TOKEN_CANDIDATE_SCAN_CAP] so a small
    // pool still gets a floor of attempts and a large pool can't blow up into
    // dozens of token-refresh round trips on a single lease.
    const candidatePool = this.availableAccounts(payload, modelKey);
    const maxAttempts = Math.min(
      MAX_TOKEN_CANDIDATE_SCAN_CAP,
      Math.max(MAX_TOKEN_REFRESH_CANDIDATES, candidatePool.length),
    );
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const extendedPayload = { ...payload };
      if (tokenFailedIds.length > 0) {
        const existing = Array.isArray(payload?.excludeAccountIds) ? payload.excludeAccountIds : [];
        extendedPayload.excludeAccountIds = [...existing, ...tokenFailedIds];
      }
      account = this.selectAccount(modelKey, clientId, extendedPayload, leaseIndex);
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
    // NOTE: do NOT flush() here. refreshSession() already called markDirty(),
    // which schedules a debounced write. Flushing synchronously on every lease
    // forces a full-file writeFileSync of access-keys.json (+ a backup-dir scan)
    // on the event loop per request — under load that serializes all requests
    // and was the root of the lease/report timeout storm.
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
      accessTokenExpiresAt: lease.expiresAt,
      probation: false,
      candidateStats: { healthyForModel: candidatePool.length },
      retryPolicy: null,
    };
  }

  /**
   * Process a usage/error report. Designed so the dedup boundary is explicit:
   *   B (always, even for duplicates): session keep-alive + accountQuota state
   *     sync — these are latest-wins state, NOT accounting, so a duplicate
   *     report must NOT skip them.
   *   A (exactly once per request, gated by reportId dedup): card usage,
   *     account/daily stats, credit-consumption event, cooldown routing.
   * Counting no longer depends on the lease still existing: usage is taken from
   * the payload and attributed via payload.accountId, so a late report whose
   * sticky lease已被回收 still counts (no lost billing).
   */
  async reportResult(req: any, payload: any) {
    const auth = this.accessKeyStore.resolveFromRequest(req, payload);
    if (!auth.record) throw this.fail(401, auth.error || "Unauthorized");
    const cardId = auth.record.id;

    const leaseId = String(payload?.leaseId || "").trim();
    const lease = leaseId ? this.leases.get(leaseId) : undefined;
    if (lease && auth.record.id !== lease.accessKeyId) {
      throw this.fail(403, "Lease/access key mismatch");
    }

    const status = Number(payload?.status || 0);
    const success = status >= 200 && status < 400;
    const reportId = String(payload?.reportId || "").trim();
    const modelKey = String(payload?.modelKey || lease?.modelKey || "").trim();
    const accountId = lease?.accountId ?? (Number(payload?.accountId) || 0);
    const retryAfterMs = Number(payload?.retryAfterMs || 0);

    // ── B: state sync — runs even for duplicate reports ──
    // (session keep-alive + account quota/credits snapshot). Decoupling these
    // from dedup fixes "a duplicate report dropped the account quota refresh /
    // session keep-alive". No flush() here — markDirty()'s debounce persists it.
    this.accessKeyStore.refreshSession(auth.record, { clientId: lease?.clientId }, this.now());
    let creditDelta: { oldAmount: number; newAmount: number; available: boolean; email: string } | null = null;
    if (accountId && payload?.accountQuota && typeof payload.accountQuota === "object") {
      creditDelta = this.applyAccountQuotaSnapshot(accountId, payload.accountQuota);
    }

    // ── Dedup ──
    // No-reportId (legacy) clients: only the first success per lease counts.
    if (!reportId && success && lease?.successfulReportSeen) {
      return {
        ok: true, ignored: true, reason: "already_reported",
        accessKeyStatus: this.accessKeyStore.publicStatus(auth.record),
      };
    }
    // reportId clients: recordUsage() is idempotent and returns wasNew. It also
    // performs the card-level usage accounting in the same step.
    const usage = this.usageForBilling(lease, status, payload);
    const wasNew = this.accessKeyStore.recordUsage(cardId, status, usage, modelKey, reportId);
    if (!wasNew) {
      return {
        ok: true, ignored: true, reason: "already_reported",
        accessKeyStatus: this.accessKeyStore.publicStatus(auth.record),
      };
    }

    // ── A: count exactly once for this request ──
    this.totalReports++;
    this.ensureDaily();
    const tokens = Number(payload?.totalTokens || 0);
    const inputTokens = Number(payload?.inputTokens || 0);
    const outputTokens = Number(payload?.outputTokens || 0);

    const accStats = accountId ? this.ensureAccountStats(accountId) : null;
    if (accStats) {
      accStats.lastStatus = String(status);
      accStats.lastUsedAt = this.now();
    }

    if (success) {
      this.dailySuccesses++;
      this.dailyTokensUsed += tokens;
      if (accStats) {
        accStats.successCount++;
        accStats.totalTokensUsed += tokens;
        accStats.totalInputTokens += inputTokens;
        accStats.totalOutputTokens += outputTokens;
      }
      if (lease) this.enterpriseProbe.reportResult(lease.email, true);
      if (accountId) this.markAccountSuccess(accountId, modelKey);
      if (!reportId && lease) lease.successfulReportSeen = true;
    } else if (status >= 400) {
      this.dailyErrors++;
      if (accStats) accStats.errorCount++;
      if (lease) {
        lease.released = true;
        this.enterpriseProbe.reportResult(lease.email, false);
        this.clearAffinity(accountId, lease.clientId, modelKey);
      }
      if (accountId) {
        if (status === 429 || status === 503) {
          const reason = String(payload?.reason || (status === 429 ? "quota" : "capacity"));
          const cooldownMs = this.cooldownForExhaustion(status, reason, retryAfterMs, accountId, modelKey);
          this.markAccountExhausted(accountId, modelKey, reason, cooldownMs);
        } else if (status === 403) {
          // 403 = verification challenge / service_disabled: a real account-level
          // block. Bench for the server-provided retry hint (Google's
          // quotaResetDelay etc.), or 1h if none — not the soft 3-strike path.
          const reason = String(payload?.reason || "http_403");
          const cooldownMs = retryAfterMs > 0 ? retryAfterMs : FORBIDDEN_COOLDOWN_MS;
          this.markAccountExhausted(accountId, modelKey, reason, cooldownMs);
        } else {
          // Other upstream failures (4xx/5xx, network): a *run* of consecutive
          // failures cools the account; a single success resets the counter.
          const reason = String(payload?.reason || `http_${status}`);
          this.markAccountTransientError(accountId, modelKey, reason);
        }
      }
    }

    // Credit consumption event — once per counted report, only when credits are
    // genuinely available (Pro/Premium report creditAmount=0 / available=false).
    if (creditDelta && this.creditTracker && creditDelta.available) {
      this.creditTracker.record(
        accountId, creditDelta.email, creditDelta.oldAmount, creditDelta.newAmount,
        cardId, auth.record?.name || undefined,
      );
    }

    return {
      ok: true,
      accessKeyStatus: this.accessKeyStore.publicStatus(auth.record),
    };
  }

  /**
   * Apply a client-reported Google account-quota snapshot: credits state,
   * planType, per-model quota fractions + reset times. Pure latest-wins state
   * sync (idempotent) — safe to run on duplicate reports. Returns the credit
   * delta so the caller can emit a once-only consumption event, or null if the
   * account is unknown / no credits in the snapshot.
   */
  private applyAccountQuotaSnapshot(
    accountId: number,
    quota: any,
  ): { oldAmount: number; newAmount: number; available: boolean; email: string } | null {
    let delta: { oldAmount: number; newAmount: number; available: boolean; email: string } | null = null;
    this.mutateAccount(accountId, (account) => {
      if (quota.credits && typeof quota.credits === "object") {
        const oldAmount = Number(account.credits?.creditAmount || 0);
        const newAmount = Number(quota.credits.creditAmount || 0);
        delta = { oldAmount, newAmount, available: quota.credits.available !== false, email: account.email };
        account.credits = {
          known: Boolean(quota.credits.known),
          available: Boolean(quota.credits.available),
          creditAmount: newAmount,
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
        for (const [key, info] of Object.entries(quota.modelQuota as Record<string, any>)) {
          account.modelQuotaFractions[key] = Number(info?.remainingFraction || 0);
          if (info?.resetTime) account.modelQuotaResetTimes[key] = String(info.resetTime);
        }
        account.modelQuotaRefreshedAt = Date.now();
      }
      return account;
    });
    return delta;
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

  /**
   * Shutdown hook: force a final synchronous flush of any buffered state so the
   * debounce windows don't lose the last few seconds of writes on a clean exit.
   * This is the "critical node" flush — the per-request hot-path flushes were
   * removed in favour of the debounced timers. Requires the Nest app to enable
   * shutdown hooks (app.enableShutdownHooks()).
   */
  onModuleDestroy(): void {
    if (this._accountsSaveTimer) {
      clearTimeout(this._accountsSaveTimer);
      this._accountsSaveTimer = null;
    }
    try { this.flushAccounts(); } catch (err) { console.error("[token-server] flushAccounts on shutdown failed:", err); }
    try { this.flushAccessKeys(); } catch (err) { console.error("[token-server] accessKeyStore flush on shutdown failed:", err); }
  }

  /** Force the debounced access-key cache to persist now (shutdown / tests). */
  flushAccessKeys(): void {
    this.accessKeyStore.flush();
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

  private selectAccount(
    modelKey: string,
    clientId: string,
    payload: any,
    leaseIndex?: ActiveLeaseIndex,
  ): TokenAccount | null {
    const candidates = this.availableAccounts(payload, modelKey);
    if (!candidates.length) return null;
    const preferredAccountId = this.preferredAccountId(clientId, modelKey);
    const now = this.now();
    // Build the index once if the caller didn't supply one (e.g. tests calling
    // selectAccount directly). leaseToken passes a shared index for the whole
    // retry loop so it is built once per lease, not once per candidate.
    const index = leaseIndex ?? this.buildActiveLeaseIndex();
    return candidates
      .map((account) => ({
        account,
        score: scoreAccount(account, {
          now,
          preferredAccountId,
          modelKey,
          activeLeaseCount: (accountId, targetModel) => this.activeLeaseCountFrom(index, accountId, targetModel),
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
      successfulReportSeen: false,
    };
  }

  private usageForBilling(lease: LeaseRecord | undefined, status: number, payload: any) {
    const reported = Number(payload?.totalTokens || payload?.rawTotalTokens || 0);
    if (lease && status >= 200 && status < 400 && lease.isGeneration && reported <= 0) {
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

  /**
   * Build an active-lease count index in a SINGLE pass over this.leases:
   * per account, the total active leases and a per-model breakdown.
   *
   * Replaces the old per-candidate activeLeaseCount() scan. Scoring N candidates
   * used to be O(N×L) (two O(L) lease scans per candidate); with this index it
   * is O(N+L): build once, then O(1) lookups. Shared by selectAccount() and
   * getStatus() so the counting logic lives in one place.
   */
  private buildActiveLeaseIndex(): ActiveLeaseIndex {
    const now = this.now();
    const index: ActiveLeaseIndex = new Map();
    for (const lease of this.leases.values()) {
      // Skip released leases and ones past their TTL: a lease kept only for the
      // report grace window is no longer active load and must not inflate
      // account scoring.
      if (lease.released || Date.parse(lease.expiresAt) <= now) continue;
      let entry = index.get(lease.accountId);
      if (!entry) {
        entry = { total: 0, perModel: new Map() };
        index.set(lease.accountId, entry);
      }
      entry.total++;
      const m = normalizeModelKey(lease.modelKey);
      if (m) entry.perModel.set(m, (entry.perModel.get(m) || 0) + 1);
    }
    return index;
  }

  /** O(1) active-lease count from a prebuilt index. Empty modelKey → total. */
  private activeLeaseCountFrom(index: ActiveLeaseIndex, accountId: number, modelKey: string): number {
    const entry = index.get(accountId);
    if (!entry) return 0;
    const m = normalizeModelKey(modelKey);
    return m ? (entry.perModel.get(m) || 0) : entry.total;
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
        exhaustedUntil: 0, consecutiveErrors: 0, transientErrors: 0, lastUsedAt: 0,
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

  /**
   * Decide how long to bench an account that just hit 429/503.
   * - Any server-provided retryAfterMs wins.
   * - 503 (capacity / unavailable) → short CAPACITY_COOLDOWN_MS. Detected by
   *   status AND reason text ("capacity"/"503") so http_503_unavailable — which
   *   contains neither "capacity" nor a retryAfter — no longer falls through to
   *   the long quota cooldown.
   * - 429 (quota) → park until the model's 5h quota refreshes, capped at 1h;
   *   1h fallback when the reset time is unknown.
   */
  private cooldownForExhaustion(
    status: number,
    reason: string,
    retryAfterMs: number,
    accountId: number,
    modelKey: string,
  ): number {
    if (retryAfterMs > 0) return retryAfterMs;
    if (status === 503 || reason.includes("capacity") || reason.includes("503")) {
      return CAPACITY_COOLDOWN_MS || 10_000;
    }
    const account = this.readAccounts().find((a) => a.id === accountId);
    const resetAt = account ? getModelQuotaResetAt(account, modelKey) : 0;
    const remaining = resetAt > this.now() ? resetAt - this.now() : QUOTA_EXHAUSTION_COOLDOWN_CAP_MS;
    return Math.min(remaining, QUOTA_EXHAUSTION_COOLDOWN_CAP_MS);
  }

  private markAccountExhausted(accountId: number, modelKey: string, reason: string, cooldownMs: number) {
    const state = this.ensureRuntime(accountId);
    const now = this.now();
    const normalized = normalizeModelKey(modelKey);
    const isCapacity = reason.includes("capacity") || reason.includes("503");
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

  /**
   * Record a non-429/503 upstream failure (4xx/5xx/network). Only cools the
   * account once REMOTE_ACCOUNT_ERROR_THRESHOLD *consecutive* failures pile up,
   * using a short self-healing cooldown. The counter is reset by any success
   * (markAccountSuccess), so isolated failures interleaved with successes never
   * trip it — only a sustained run of failures takes the account out of rotation.
   */
  private markAccountTransientError(accountId: number, modelKey: string, reason: string) {
    const state = this.ensureRuntime(accountId);
    state.transientErrors++;
    if (state.transientErrors < REMOTE_ACCOUNT_ERROR_THRESHOLD) return;

    const now = this.now();
    const normalized = normalizeModelKey(modelKey);
    const blockedUntil = now + REMOTE_TRANSIENT_ERROR_COOLDOWN_MS;

    state.quotaStatus = "cooling";
    state.quotaStatusReason = reason;
    state.exhaustedAt = now;

    if (normalized) {
      state.blockedModels.set(normalized, { modelKey: normalized, reason, blockedAt: now, blockedUntil });
      this.modelGates.blockAccountForModel(accountId, normalized, reason, REMOTE_TRANSIENT_ERROR_COOLDOWN_MS);
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
    state.transientErrors = 0;
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
    // DELETE leases only after TTL + report grace (previously they were merely
    // marked released → the Map grew unboundedly, a leak that also inflated
    // every O(L) lease scan). The grace keeps a just-expired lease around long
    // enough for a late/retried report to still find it and be counted.
    for (const [id, lease] of this.leases) {
      if (Date.parse(lease.expiresAt) + REPORT_GRACE_MS <= now) this.leases.delete(id);
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
