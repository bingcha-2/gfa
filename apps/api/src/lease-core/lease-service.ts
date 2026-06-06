import * as crypto from "crypto";
import * as fs from "fs";

import { defaultRemoteAccessDataDir } from "../remote-access/data-dir";
import { AccessKeyStore } from "../token-server/access-key-store";
import { isPermanentTokenRefreshError, maskEmail, readJsonFile, writeJsonFile } from "../token-server/data-store";
import { FairShareTracker } from "../token-server/fair-share-tracker";
import { accountWeight, EnterpriseProbeManager, getModelQuotaFraction, getModelQuotaResetAt, scoreAccount } from "../token-server/lease-scheduler";
import { ModelGateManager } from "../token-server/model-gates";
import {
  DEFAULT_AFFINITY_TTL_MS,
  DEFAULT_LEASE_TTL_MS,
  CAPACITY_COOLDOWN_MS,
  BOUND_LEASE_TTL_MS,
  decodeJwtExpMs,
  MAX_REMOTE_LEASE_TTL_MS,
  REMOTE_ACCOUNT_ERROR_THRESHOLD,
  REMOTE_TRANSIENT_ERROR_COOLDOWN_MS,
  TOKEN_REFRESH_FAILURE_COOLDOWN_MS,
  accessKeySessionTtlMs,
  affinityKey,
  normalizeModelKey,
  validateClientVersion,
} from "../token-server/token-billing";
import { bucketKey } from "./product-bucket";
import type { CreditDelta, Provider } from "./provider";

export type CreditTracker = {
  record: (
    accountId: number,
    email: string,
    oldAmount: number,
    newAmount: number,
    accessKeyId?: string,
    accessKeyName?: string,
  ) => void;
};

export type TokenUsageTracker = {
  record: (event: {
    accessKeyId: string;
    accessKeyName?: string;
    accountId?: number;
    modelKey: string;
    bucket: string;
    status: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    rawTotalTokens?: number;
    totalTokens?: number;
  }) => void;
};

export type LeaseHttpErrorClass = new (statusCode: number, message: string, body?: unknown) => Error;

export type LeaseServiceOptions = {
  accessKeysFilePath?: string;
  now?: () => number;
  randomId?: () => string;
  minClientVersion?: string;
  leaseTtlMs?: number;
  affinityTtlMs?: number;
  creditTracker?: CreditTracker;
  tokenUsageTracker?: TokenUsageTracker;
  /** Fair-share tracker for bound-card dynamic quota. */
  fairShareTracker?: FairShareTracker;
  /** Error class thrown by fail(); the controller routes on `instanceof`. */
  errorClass?: LeaseHttpErrorClass;
  /** getStatus().mode label. Default "remote-token-server". */
  mode?: string;
  /** 503 message when no eligible account is available. */
  noAccountMessage?: string;
  /** 503 message when a card's statically-bound account is unavailable. */
  busyMessage?: string;
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
const MAX_TOKEN_CANDIDATE_SCAN_CAP = 30;
const QUOTA_EXHAUSTION_COOLDOWN_CAP_MS = 60 * 60 * 1000;
// 403 冷却的封顶(也是无 retry-after 时的默认)。短 —— 403 多为瞬时验证挑战/反滥用,
// 绑定卡无备号,长冷却=该模型几小时不可用。瞬时挑战 ~60s 内自愈。
const FORBIDDEN_COOLDOWN_MS = 60 * 1000;
const REPORT_GRACE_MS = 60 * 1000;
const ACCOUNTS_FLUSH_MS = 60_000; // 1 minute debounce

/** Base HTTP error. Provider-specific services subclass this so controllers can
 * route on `instanceof`. */
export class LeaseServiceHttpError extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly body?: unknown) {
    super(message);
  }

  toBody(): HttpErrorBody | unknown {
    return this.body || { ok: false, error: this.message };
  }
}

/**
 * Generic token-leasing engine, parameterized by a Provider. Holds all the
 * shared/full-featured logic (candidate-scan retry, runtime state machine,
 * cooldown routing, model gates, affinity, scoring, stats, report dedup, lease
 * lifecycle, debounced account persistence). Provider supplies only the pieces
 * that differ between upstreams.
 */
export class LeaseService<TAccount extends { id: number; email: string; refreshToken: string }> {
  protected readonly provider: Provider<TAccount>;
  private readonly accountsFilePath: string;
  protected readonly accessKeyStore: AccessKeyStore;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly minClientVersion: string;
  private readonly leaseTtlMs: number;
  private readonly affinityTtlMs: number;
  private readonly creditTracker: CreditTracker | null;
  private readonly tokenUsageTracker: TokenUsageTracker | null;
  readonly fairShareTracker: FairShareTracker | null;
  private readonly errorClass: LeaseHttpErrorClass;
  private readonly mode: string;
  private readonly noAccountMessage: string;
  private readonly busyMessage: string;
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
  private _cachedAccounts: TAccount[] | null = null;
  private _cachedMtimeMs = 0;
  private _accountsDirty = false;
  private _accountsSaveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(provider: Provider<TAccount>, options: LeaseServiceOptions = {}) {
    const dataDir = defaultRemoteAccessDataDir();
    this.provider = provider;
    this.accountsFilePath = provider.accountsFilePath;
    this.accessKeyStore = new AccessKeyStore(
      options.accessKeysFilePath || `${dataDir}/access-keys.json`,
      provider.billing,
    );
    this.now = options.now || Date.now;
    this.randomId = options.randomId || (() => crypto.randomUUID());
    this.minClientVersion = options.minClientVersion ?? "8.4.0";
    this.leaseTtlMs = Number(options.leaseTtlMs || DEFAULT_LEASE_TTL_MS);
    this.affinityTtlMs = Number(options.affinityTtlMs || DEFAULT_AFFINITY_TTL_MS);
    this.creditTracker = options.creditTracker || null;
    this.tokenUsageTracker = options.tokenUsageTracker || null;
    this.fairShareTracker = options.fairShareTracker || null;
    this.errorClass = options.errorClass || LeaseServiceHttpError;
    this.mode = options.mode || "remote-token-server";
    this.noAccountMessage = options.noAccountMessage || "No account with projectId is available.";
    this.busyMessage = options.busyMessage || "当前账号繁忙，额度恢复中，请稍后重试";
  }

  private ensureDaily() {
    // Use the injectable clock so the daily-bucket boundary agrees with every
    // other this.now()-based time decision (tests / clock-skew handling).
    const today = new Date(this.now()).toISOString().slice(0, 10);
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

    const accessKeys = this.accessKeyStore.readAll().keys;
    return {
      running: true,
      mode: this.mode,
      authMode: "access-key",
      totalLeases: this.totalLeases,
      totalReports: this.totalReports,
      totalErrors: this.totalErrors,
      lastError: this.lastError,
      activeLeases: activeLeasesTotal,
      affinityClients: this.clientAffinity.size,
      accounts: {
        total: accounts.length,
        enabled: accounts.filter((account) => (account as any).enabled !== false).length,
        withProject: accounts.filter((account) => (account as any).projectId).length,
      },
      accessKeys: {
        total: accessKeys.length,
        active: accessKeys.filter((key: any) => !key.status || key.status === "active").length,
      },
      quota: {
        accounts: accounts.map((account) => {
          const a = account as any;
          const runtime = this.accountRuntime.get(account.id);
          return {
            id: account.id,
            email: account.email,
            enabled: a.enabled !== false,
            planType: a.planType || "",
            projectId: a.projectId || "",
            quotaStatus: runtime?.quotaStatus || a.quotaStatus || "ok",
            quotaStatusReason: runtime?.quotaStatusReason || a.quotaStatusReason || "",
            blockedUntil: runtime?.exhaustedUntil || a.blockedUntil || 0,
            credits: a.credits || {},
            modelQuotaFractions: a.modelQuotaFractions || {},
            modelQuotaResetTimes: a.modelQuotaResetTimes || {},
            modelQuotaRefreshedAt: a.modelQuotaRefreshedAt || 0,
            activeLeases: activeLeaseCounts[String(account.id)] || 0,
            lastConversationOkAt: a.lastConversationOkAt || "",
            lastStatus: a.lastStatus || "",
            blockedModels: runtime
              ? Array.from(runtime.blockedModels.values()).map((b) => ({
                  modelKey: b.modelKey,
                  reason: b.reason,
                  blockedAt: b.blockedAt,
                  blockedUntil: b.blockedUntil,
                }))
              : [],
            ...(this.provider.statusAccountExtras ? this.provider.statusAccountExtras(account) : {}),
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
      models: this.provider.models ? this.provider.models.list() : [],
    };
  }

  /**
   * Best-effort upstream model-catalog refresh. Leases a token from any eligible
   * account to authenticate the upstream call; no-ops when the provider has no
   * catalog or no eligible account. Never throws.
   */
  async refreshModels(): Promise<void> {
    const catalog = this.provider.models;
    if (!catalog) return;
    await catalog.refresh(async () => {
      const account = this.availableAccounts({}, "").find(() => true);
      if (!account) return "";
      try {
        return await this.provider.refreshToken(account);
      } catch {
        return "";
      }
    });
  }

  async leaseToken(req: any, payload: any) {
    const modelKey = String(payload?.modelKey || payload?.model || "").trim();
    // Static-binding model: each card shares one upstream account (≤4 cards/acct)
    // and relies purely on the account's native 5h rolling quota. The GFA-side
    // per-card token cap is intentionally NOT enforced — usage is still recorded
    // (for stats) but never blocks a lease.
    const auth = this.accessKeyStore.resolveFromRequest(req, payload, {
      activate: true,
      enforceLimit: false,
      modelKey,
    });
    if (!auth.record) throw this.fail(401, auth.error || "Unauthorized");

    // Two card modes:
    //  • Bound  (boundAccountId > 0): pinned to one account in this pool — lease
    //    only from it, no dynamic-pool fallback.
    //  • Pool   (no binding at all): legacy dynamic pool with failover.
    // A card bound for a DIFFERENT pool only is not sold for this one → rejected.
    const boundAccountId = this.accessKeyStore.boundAccountIdFor(auth.record, this.provider.id);
    if (boundAccountId === 0 && this.accessKeyStore.hasAnyBinding(auth.record)) {
      throw this.fail(409, "此卡未开通该服务，请联系客服");
    }

    // Fair-share check: bound cards with multiple co-tenants get dynamic quotas.
    if (boundAccountId > 0 && this.fairShareTracker) {
      const bucket = bucketKey(this.provider.id, modelKey);
      const check = this.fairShareTracker.checkFairShare(boundAccountId, auth.record.id, bucket);
      if (!check.allowed) {
        throw this.fail(429, check.reason || "公平限额已用完，请等待额度恢复");
      }
    }

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
    let account: TAccount | null = null;
    let accessToken = "";

    this.cleanupExpiredLeases();
    const leaseIndex = this.buildActiveLeaseIndex();

    const candidatePool = this.availableAccounts(payload, modelKey, boundAccountId);
    // A bound card has at most one candidate (its account), so there is nothing to
    // scan past — one attempt, then the busy error. No fallback to other accounts.
    const maxAttempts = boundAccountId
      ? 1
      : Math.min(
          MAX_TOKEN_CANDIDATE_SCAN_CAP,
          Math.max(MAX_TOKEN_REFRESH_CANDIDATES, candidatePool.length),
        );
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const extendedPayload = { ...payload };
      if (tokenFailedIds.length > 0) {
        const existing = Array.isArray(payload?.excludeAccountIds) ? payload.excludeAccountIds : [];
        extendedPayload.excludeAccountIds = [...existing, ...tokenFailedIds];
      }
      account = this.selectAccount(modelKey, clientId, extendedPayload, leaseIndex, boundAccountId);
      if (!account) break;

      try {
        accessToken = await this.provider.refreshToken(account);
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
      // Bound cards never borrow another account. Distinguish WHY the bound
      // account is unavailable so the user isn't told "额度恢复中" forever when
      // the account is actually gone / disabled / auth-broken.
      if (boundAccountId) throw this.fail(503, this.boundUnavailableMessage(boundAccountId));
      throw this.fail(503, lastError?.message || this.noAccountMessage);
    }

    this.mutateAccount(account.id, () => ({ ...(account as TAccount) }));
    const lease = this.createLease(account, accessKeySessionId, auth.record.id, clientId, modelKey, payload, boundAccountId, accessToken);
    this.leases.set(lease.leaseId, lease);
    this.rememberAffinity(clientId, modelKey, account.id);
    this.totalLeases++;
    this.ensureDaily();
    this.dailyLeases++;
    const accStats = this.ensureAccountStats(account.id);
    accStats.totalLeases++;
    accStats.lastUsedAt = this.now();
    return {
      ok: true,
      leaseId: lease.leaseId,
      accessKeySessionId,
      sessionId: accessKeySessionId,
      sessionExpiresAt: auth.record.sessionExpiresAt || "",
      accessKeyStatus: this.accessKeyStore.publicStatus(auth.record),
      accountId: account.id,
      emailHint: maskEmail(account.email),
      // 绑定账号的会员等级(antigravity: ultra/premium/...; codex: plus/pro; anthropic: max/pro),
      // 供客户端「绑定账号信息」面板展示。账号尚无快照时为空串。
      planType: (account as any).planType || "",
      accessToken,
      ...(this.provider.bloodBarFraction
        ? { boundAccount: { id: account.id, ...this.provider.bloodBarFraction(account, modelKey) } }
        : {}),
      // All known per-bucket quotas for the leased account, so the client can show
      // real blood bars for every model right after activation (not just the one
      // leased). Empty {} when the account has no quota snapshots yet.
      accountBuckets: this.accountBucketQuotas(account),
      ...this.provider.leaseResponseExtras(account),
      expiresAt: lease.expiresAt,
      accessTokenExpiresAt: lease.expiresAt,
      probation: false,
      candidateStats: { healthyForModel: candidatePool.length },
      retryPolicy: null,
      // Bound cards have no OTHER account to rotate to. The client proxy uses this
      // to skip the futile "exclude account + re-lease" rotation on 429/503, while
      // STILL allowing wait-and-retry on the SAME account for transient capacity.
      bound: boundAccountId > 0,
      // Per-card fair-share quota fractions for blood bar display.
      // Only populated for bound cards with co-tenants.
      fairShareQuota: (boundAccountId > 0 && this.fairShareTracker)
        ? this.fairShareTracker.getCardQuotaFractions(boundAccountId, auth.record.id)
        : undefined,
    };
  }

  /**
   * Why a bound card's account is unavailable — a clear, user-facing reason.
   * "繁忙/额度恢复中" is reserved for a real, recoverable quota/capacity cooldown;
   * a missing/disabled/auth-broken account gets a distinct message so the user
   * doesn't wait forever for a recovery that will never come.
   */
  private boundUnavailableMessage(boundAccountId: number): string {
    const acct = this.readAccounts().find((a) => a.id === boundAccountId);
    if (!acct || (acct as any).enabled === false) {
      return "此卡绑定的账号不可用（不存在或已禁用），请联系客服";
    }
    const runtime = this.accountRuntime.get(boundAccountId);
    if (runtime?.quotaStatus === "error") {
      return "此卡绑定的账号鉴权失效，请联系客服重新绑定/换号";
    }
    return this.busyMessage;
  }

  /**
   * The leased account's KNOWN remaining quota per display bucket (gemini/codex/
   * opus), computed from its per-model snapshots. Lets the client show real
   * quota for EVERY bar right after activation (it's a shared account — other
   * users' usage already populated the server's view), not just the leased model.
   * Min fraction per bucket (most restrictive). Unknown models are skipped.
   */
  private accountBucketQuotas(account: TAccount): Record<string, { fraction: number; resetAt: number }> {
    const fractions = (account as any).modelQuotaFractions;
    if (!fractions || typeof fractions !== "object") return {};
    const out: Record<string, { fraction: number; resetAt: number }> = {};
    for (const model of Object.keys(fractions)) {
      const f = getModelQuotaFraction(account, model);
      if (f === null || f < 0) continue;
      const bucket = bucketKey(this.provider.id, model);
      if (!(bucket in out) || f < out[bucket].fraction) {
        out[bucket] = { fraction: f, resetAt: getModelQuotaResetAt(account, model) };
      }
    }
    return out;
  }

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
    // Dedup key for exactly-once billing. Modern clients send a unique reportId.
    // Legacy clients (no reportId) still send a leaseId — use it as a stable key so
    // retried/late reports are deduped via the reportDedup ring even after the
    // in-memory lease is gone (the lease.successfulReportSeen guard below can only
    // fire while the lease object is still alive, so without this a no-reportId
    // retry past lease cleanup would re-bill the card).
    const dedupId = reportId || (leaseId ? `lease:${leaseId}` : "");
    const modelKey = String(payload?.modelKey || lease?.modelKey || "").trim();
    // Account-state mutations (quota snapshot, exhaustion/cooldown, success, stats)
    // MUST be bound to a lease this card owns — see the ownership guard above. Without
    // a verified lease we cannot trust a body-supplied accountId, so we refuse to mutate
    // any account's runtime state on its behalf; otherwise any valid card could omit
    // leaseId and cool/poison arbitrary accounts (pool-wide DoS / quota corruption).
    // (Shared by both the antigravity TokenServerService and the Codex RemoteCodexService.)
    const accountId = lease?.accountId ?? 0;
    const retryAfterMs = Number(payload?.retryAfterMs || 0);

    this.accessKeyStore.refreshSession(auth.record, { clientId: lease?.clientId }, this.now());
    let creditDelta: CreditDelta | null = null;
    if (accountId && payload?.accountQuota && typeof payload.accountQuota === "object") {
      creditDelta = this.applyAccountQuotaSnapshot(accountId, payload.accountQuota);
      // Fair-share: push updated quota fractions into the tracker.
      if (this.fairShareTracker) {
        const account = this.readAccounts().find((a) => a.id === accountId);
        const fractions = (account as any)?.modelQuotaFractions;
        if (fractions && typeof fractions === "object") {
          for (const [model, frac] of Object.entries(fractions)) {
            const f = Number(frac);
            if (Number.isFinite(f) && f >= 0 && f <= 1) {
              const bucket = bucketKey(this.provider.id, model);
              this.fairShareTracker.updateBudgetEstimate(accountId, bucket, f);
            }
          }
        }
      }
    }

    if (!reportId && success && lease?.successfulReportSeen) {
      return {
        ok: true, ignored: true, reason: "already_reported",
        accessKeyStatus: this.accessKeyStore.publicStatus(auth.record),
      };
    }
    const usage = this.usageForBilling(lease, status, payload);
    const wasNew = this.accessKeyStore.recordUsage(cardId, status, usage, modelKey, dedupId, this.provider.id);
    if (!wasNew) {
      return {
        ok: true, ignored: true, reason: "already_reported",
        accessKeyStatus: this.accessKeyStore.publicStatus(auth.record),
      };
    }

    // Fair-share: record weighted usage for bound cards.
    if (accountId && this.fairShareTracker && success) {
      const detail = this.accessKeyStore.computeUsageDetail(usage, modelKey, this.provider.id);
      if (detail.totalTokens > 0) {
        const bucket = bucketKey(this.provider.id, modelKey);
        this.fairShareTracker.recordUsage(
          accountId, cardId, bucket,
          detail.inputTokens, detail.outputTokens, detail.cachedInputTokens,
        );
      }
    }

    // Per-call token usage log (queryable, persisted to Prisma). Runs only for
    // counted (exactly-once) reports — recordUsage above already deduped. We log
    // the same canonical numbers the card counters persist; skip zero-token
    // reports (errors / capacity rejections carry no usage).
    if (this.tokenUsageTracker) {
      const detail = this.accessKeyStore.computeUsageDetail(usage, modelKey, this.provider.id);
      if (detail.totalTokens > 0) {
        this.tokenUsageTracker.record({
          accessKeyId: cardId,
          accessKeyName: auth.record?.name || undefined,
          accountId: accountId || undefined,
          modelKey: modelKey || "",
          bucket: detail.bucket,
          status,
          inputTokens: detail.inputTokens,
          outputTokens: detail.outputTokens,
          cachedInputTokens: detail.cachedInputTokens,
          rawTotalTokens: detail.rawTotalTokens,
          totalTokens: detail.totalTokens,
        });
      }
    }

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
          // Fair-share: confirm budget ceiling on upstream exhaustion.
          if (this.fairShareTracker && status === 429) {
            const bucket = bucketKey(this.provider.id, modelKey);
            this.fairShareTracker.confirmBudget(accountId, bucket);
          }
        } else if (status === 403) {
          const reason = String(payload?.reason || "http_403");
          // 403(验证挑战 / service_disabled / forbidden)是瞬时反滥用或配置类错误,不是
          // 配额窗口。上游对 403 给的 retry-after 不可信(实测常是离谱的 ~2h)——绑定卡没有
          // 备号,长冷却会把整张卡的该模型打死几小时。封顶到短冷却:小的提示照用,大的截断,
          // 瞬时挑战快速自愈;真·坏号则每 ~60s 被重试一次(而非沉默几小时)。
          const hinted = retryAfterMs > 0 ? retryAfterMs : FORBIDDEN_COOLDOWN_MS;
          const cooldownMs = Math.min(hinted, FORBIDDEN_COOLDOWN_MS);
          this.markAccountExhausted(accountId, modelKey, reason, cooldownMs);
        } else {
          const reason = String(payload?.reason || `http_${status}`);
          // 401: upstream invalidated the access token (e.g. code "token_invalidated")
          // even though it isn't expired by our clock. Clear the cached token so the
          // NEXT lease refreshes a fresh one via the refresh token (instead of looping
          // on the dead token). If the refresh token is also dead, the next lease's
          // refresh fails → account marked "error" → clean "鉴权失效" message.
          if (status === 401) {
            this.mutateAccount(accountId, (account) => {
              const a = account as any;
              a.accessToken = "";
              a.accessTokenExpiresAt = 0;
              return account;
            });
          }
          this.markAccountTransientError(accountId, modelKey, reason);
        }
      }
    }

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
   * Delegate to the provider's quota-snapshot logic, wrapped in mutateAccount so
   * the (possibly mutated) account is persisted with debounce. Latest-wins,
   * idempotent — safe on duplicate reports.
   */
  private applyAccountQuotaSnapshot(accountId: number, quota: any): CreditDelta | null {
    let delta: CreditDelta | null = null;
    this.mutateAccount(accountId, (account) => {
      const result = this.provider.applyQuotaSnapshot(account, quota);
      delta = result.creditDelta;
      return result.account;
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

  private readAccounts(): TAccount[] {
    try {
      const stat = fs.statSync(this.accountsFilePath);
      if (this._cachedAccounts && stat.mtimeMs === this._cachedMtimeMs) {
        return this._cachedAccounts;
      }
      this._cachedMtimeMs = stat.mtimeMs;
    } catch {
      return [];
    }

    const data = readJsonFile(this.accountsFilePath);
    const accounts = Array.isArray(data) ? data : Array.isArray(data.accounts) ? data.accounts : [];
    this._cachedAccounts = accounts.map((account: any) => this.provider.normalizeAccount(account));
    return this._cachedAccounts as TAccount[];
  }

  private markAccountsDirty(): void {
    this._accountsDirty = true;
    if (!this._accountsSaveTimer) {
      this._accountsSaveTimer = setTimeout(() => {
        this._accountsSaveTimer = null;
        this.flushAccounts();
      }, ACCOUNTS_FLUSH_MS);
    }
  }

  /** Modify a single account in-memory and schedule a debounced disk write. */
  mutateAccount(accountId: number, updater: (account: TAccount) => TAccount): void {
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

    try {
      const currentMtime = fs.statSync(this.accountsFilePath).mtimeMs;
      if (currentMtime !== this._cachedMtimeMs) {
        this._cachedAccounts = null;
        this._accountsDirty = false;
        this.readAccounts();
        return;
      }
    } catch { /* file deleted, proceed with write to recreate */ }

    this._accountsDirty = false;
    const previous = readJsonFile(this.accountsFilePath);
    const value = Array.isArray(previous) ? this._cachedAccounts : { ...previous, accounts: this._cachedAccounts };
    writeJsonFile(this.accountsFilePath, value);
    try { this._cachedMtimeMs = fs.statSync(this.accountsFilePath).mtimeMs; } catch { /* noop */ }
  }

  onModuleDestroy(): void {
    if (this._accountsSaveTimer) {
      clearTimeout(this._accountsSaveTimer);
      this._accountsSaveTimer = null;
    }
    try { this.flushAccounts(); } catch (err) { console.error("[lease-service] flushAccounts on shutdown failed:", err); }
    try { this.flushAccessKeys(); } catch (err) { console.error("[lease-service] accessKeyStore flush on shutdown failed:", err); }
  }

  /** Force the debounced access-key cache to persist now (shutdown / tests). */
  flushAccessKeys(): void {
    this.accessKeyStore.flush();
  }

  private availableAccounts(payload: any, modelKey?: string, boundAccountId = 0) {
    const excluded = new Set(
      (Array.isArray(payload?.excludeAccountIds) ? payload.excludeAccountIds : [])
        .map((value: unknown) => Number(value))
        .filter((value: number) => Number.isFinite(value) && value > 0),
    );
    const now = this.now();
    this.modelGates.cleanupExpiredGates(now);
    return this.readAccounts().filter((account) =>
      (boundAccountId ? account.id === boundAccountId : true) &&
      // 出池号(poolEnabled===false)只服务"绑定它的卡":绑定卡(boundAccountId>0)钉号
      // 不受限;池子卡(boundAccountId===0)的动态池则跳过出池号。与 UI「已出池(仅绑定卡
      // 可用)」一致。建卡自动分配另有 isAccountBindable 把关,这里补的是运行时这一层。
      (boundAccountId ? true : (account as any).poolEnabled !== false) &&
      (account as any).enabled !== false &&
      this.provider.isAccountEligible(account) &&
      Boolean(account.refreshToken || (account as any).accessToken) &&
      !excluded.has(account.id) &&
      !this.isAccountBlocked(account.id, modelKey || "", now),
    );
  }

  private selectAccount(
    modelKey: string,
    clientId: string,
    payload: any,
    leaseIndex?: ActiveLeaseIndex,
    boundAccountId = 0,
  ): TAccount | null {
    const candidates = this.availableAccounts(payload, modelKey, boundAccountId);
    if (!candidates.length) return null;
    const preferredAccountId = this.preferredAccountId(clientId, modelKey);
    const now = this.now();
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
          // Provider override (codex: account-level quota for all models).
          modelQuotaFraction: this.provider.quotaFractionFor
            ? this.provider.quotaFractionFor(account, modelKey)
            : undefined,
        }),
      }))
      .sort((a, b) => a.score - b.score || a.account.id - b.account.id)[0].account;
  }

  private createLease(
    account: TAccount,
    accessKeySessionId: string,
    accessKeyId: string,
    clientId: string,
    modelKey: string,
    payload: any,
    boundAccountId = 0,
    accessToken = "",
  ): LeaseRecord {
    let ttlMs = Math.max(60_000, Math.min(this.leaseTtlMs, MAX_REMOTE_LEASE_TTL_MS));
    // Bound card: the account is fixed, so there is no rebalancing reason to
    // re-lease every 10 min. Extend the lease toward the upstream token's real
    // expiry (60s buffer); fall back to BOUND_LEASE_TTL_MS when undecodable.
    if (boundAccountId) {
      const realExp = decodeJwtExpMs(accessToken);
      const byToken = realExp > 0 ? realExp - this.now() - 60_000 : 0;
      const longTtl = byToken > 0 ? Math.min(BOUND_LEASE_TTL_MS, byToken) : BOUND_LEASE_TTL_MS;
      ttlMs = Math.max(ttlMs, longTtl);
    }
    return {
      leaseId: this.randomId(),
      accountId: account.id,
      email: account.email,
      projectId: String((account as any).projectId || ""),
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

  private buildActiveLeaseIndex(): ActiveLeaseIndex {
    const now = this.now();
    const index: ActiveLeaseIndex = new Map();
    for (const lease of this.leases.values()) {
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
      // Account-wide cooldown (failure recorded without a model key) blocks everything.
      if (state.blockedModels.size === 0) return true;
      // Model-less probe (activation / warmup): the account is usable as long as at least
      // one model is still open, so a per-model cooldown (e.g. Claude 503) must not hide it.
      if (!modelKey) return false;
      const normalized = normalizeModelKey(modelKey);
      if (normalized && state.blockedModels.has(normalized)) return true;
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

    // A permanent token-refresh failure (invalid_grant) must NOT be revived by a
    // usage-success report. It recovers only when its cooldown expires
    // (cleanupExpiredBlocks). Otherwise a stale/duplicate/forged success report
    // would flip a permanently-broken account back to "ok", so it gets re-selected
    // and every subsequent lease fails the token refresh. (consecutive_errors has no
    // cooldown and is intentionally still cleared here.)
    const permanentTokenError =
      state.quotaStatus === "error" && state.quotaStatusReason === "invalid_grant";
    if (state.blockedModels.size === 0 && !permanentTokenError) {
      state.quotaStatus = "ok";
      state.quotaStatusReason = "";
      state.exhaustedAt = 0;
      state.exhaustedUntil = 0;
    } else if (state.blockedModels.size > 0) {
      state.exhaustedUntil = Math.max(
        ...Array.from(state.blockedModels.values()).map((b) => b.blockedUntil),
      );
    }
  }

  private cleanupExpiredLeases() {
    const now = this.now();
    for (const [id, lease] of this.leases) {
      if (Date.parse(lease.expiresAt) + REPORT_GRACE_MS <= now) this.leases.delete(id);
    }
    for (const [key, affinity] of this.clientAffinity.entries()) {
      if (affinity.expiresAt <= now) this.clientAffinity.delete(key);
    }
  }

  protected fail(statusCode: number, message: string, body?: unknown) {
    this.totalErrors++;
    this.lastError = message;
    return new this.errorClass(statusCode, message, body);
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
