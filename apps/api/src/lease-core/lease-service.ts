import * as crypto from "crypto";
import * as fs from "fs";

import { defaultRemoteAccessDataDir } from "../remote-access/data-dir";
import { AccessKeyStore } from "../token-server/access-key-store";
import { isPermanentTokenRefreshError, maskEmail, readJsonFile, writeJsonFile } from "../token-server/data-store";
import { FairShareTracker } from "../token-server/fair-share-tracker";
import { accountWeight, EnterpriseProbeManager, getModelQuotaFraction, getModelQuotaResetAt, scoreAccount } from "../token-server/lease-scheduler";
import { QuotaProfileTracker } from "./quota-profile-tracker";
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
  PERMANENT_DEATH_STRIKE_THRESHOLD,
  PERMANENT_DEATH_FIRST_COOLDOWN_MS,
  PERMANENT_DEATH_COOLDOWN_MS,
  isPermanentDeathReason,
  accessKeySessionTtlMs,
  affinityKey,
  normalizeModelKey,
  validateClientVersion,
} from "../token-server/token-billing";
import { bucketKey, familyOfBucket } from "./product-bucket";
import type { Provider } from "./provider";

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

/** 账号 5h/周水位时序写入器(AccountQuotaSnapshotTracker 的最小接口)。 */
export type AccountQuotaSnapshotRecorder = {
  record: (input: {
    provider: string;
    accountId: number;
    modelKey: string;
    email?: string | null;
    hourlyPercent?: number | null;
    weeklyPercent?: number | null;
    hourlyResetAt?: Date | null;
    weeklyResetAt?: Date | null;
  }) => void;
};

export type LeaseHttpErrorClass = new (statusCode: number, message: string, body?: unknown) => Error;

export type LeaseServiceOptions = {
  accessKeysFilePath?: string;
  /** Shared AccessKeyStore injected so all product pools share one usage cache. */
  accessKeyStore?: AccessKeyStore;
  now?: () => number;
  randomId?: () => string;
  minClientVersion?: string;
  leaseTtlMs?: number;
  affinityTtlMs?: number;
  tokenUsageTracker?: TokenUsageTracker;
  accountQuotaSnapshotTracker?: AccountQuotaSnapshotRecorder;
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
  /** Quota profile tracker for learning real upstream budgets from 429 events. */
  quotaProfileTracker?: QuotaProfileTracker;
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
  deathStrikes: number;
  lastUsedAt: number;
  blockedModels: Map<string, { modelKey: string; reason: string; blockedAt: number; blockedUntil: number }>;
};

/** Per-account active-lease counts, built once per request from this.leases. */
type ActiveLeaseIndex = Map<number, { total: number; perModel: Map<string, number> }>;

const MAX_TOKEN_REFRESH_CANDIDATES = 5;
const MAX_TOKEN_CANDIDATE_SCAN_CAP = 30;
// 429 配额耗尽:reset 时间【未知】时的保守默认冷却(谷歌主窗 5h)。
const QUOTA_EXHAUSTION_COOLDOWN_DEFAULT_MS = 5 * 60 * 60 * 1000;
// 已知 reset 时冷却到 reset 为止,但以谷歌最长的【周窗】为上限,防快照脏数据把号冷死几周/几月。
const QUOTA_RESET_MAX_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
// 403 冷却的封顶(也是无 retry-after 时的默认)。短 —— 403 多为瞬时验证挑战/反滥用,
// 绑定卡无备号,长冷却=该模型几小时不可用。瞬时挑战 ~60s 内自愈。
const FORBIDDEN_COOLDOWN_MS = 60 * 1000;
// 验证挑战(需人工去验证)自动复检间隔:300 分钟。号主/管理员验证好后,一次成功即提前解封;
// 否则到点自动复检一次。也可由后台手动恢复立即清除(reactivateAccount)。
const VERIFICATION_RECHECK_COOLDOWN_MS = 300 * 60 * 1000;
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
  private readonly tokenUsageTracker: TokenUsageTracker | null;
  private readonly accountQuotaSnapshotTracker: AccountQuotaSnapshotRecorder | null;
  readonly fairShareTracker: FairShareTracker | null;
  readonly quotaProfileTracker: QuotaProfileTracker | null;
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
    // A single shared AccessKeyStore can be injected so all product pools record
    // a universal card's usage into one cache/file — separate per-pool stores
    // blind-overwrite each other's usage events, so per-card limits never trip.
    this.accessKeyStore = options.accessKeyStore || new AccessKeyStore(
      options.accessKeysFilePath || `${dataDir}/access-keys.json`,
      provider.billing,
    );
    this.now = options.now || Date.now;
    this.randomId = options.randomId || (() => crypto.randomUUID());
    this.minClientVersion = options.minClientVersion ?? "9.2.4";
    this.leaseTtlMs = Number(options.leaseTtlMs || DEFAULT_LEASE_TTL_MS);
    this.affinityTtlMs = Number(options.affinityTtlMs || DEFAULT_AFFINITY_TTL_MS);
    this.tokenUsageTracker = options.tokenUsageTracker || null;
    this.accountQuotaSnapshotTracker = options.accountQuotaSnapshotTracker || null;
    this.fairShareTracker = options.fairShareTracker || null;
    this.errorClass = options.errorClass || LeaseServiceHttpError;
    this.mode = options.mode || "remote-token-server";
    this.noAccountMessage = options.noAccountMessage || "No account with projectId is available.";
    this.busyMessage = options.busyMessage || "当前账号繁忙，额度恢复中，请稍后重试";
    this.quotaProfileTracker = options.quotaProfileTracker || null;
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
      quotaProfiles: this.quotaProfileTracker?.getAllProfiles() || {},
    };
  }

  /**
   * Digest of the cards bound to one upstream account, for the usage dashboard.
   * Encapsulates the (protected) accessKeyStore + fairShareTracker so external
   * callers (RemoteStatsService) don't reach into internals. Per card: share
   * weight, lifetime usage counters, and per-bucket fair-share remaining.
   */
  getBoundCardsForAccount(accountId: number): Array<{
    id: string;
    name: string;
    weight: number;
    totalTokensUsed: number;
    totalRequests: number;
    fairShare: Record<string, { fraction: number; resetAt: number }>;
    windowWeightedUsed: number;
  }> {
    const ids = this.accessKeyStore.cardsBoundToAccount(accountId, this.provider.id);
    return ids.map((id) => {
      const record = this.accessKeyStore.findById(id);
      const pub = record ? this.accessKeyStore.publicStatus(record) : null;
      const w = Math.floor(Number((record as any)?.weight ?? 1));
      const weight = Number.isFinite(w) && w >= 1 ? w : 1;
      const fairShare = this.fairShareTracker?.getCardQuotaFractions(accountId, id) || {};
      return {
        id,
        name: pub?.name || record?.name || "",
        weight,
        totalTokensUsed: Number(pub?.totalTokensUsed || 0),
        totalRequests: Number(pub?.totalRequests || 0),
        fairShare,
        windowWeightedUsed: this.fairShareTracker?.getCardWindowUsed(accountId, id) || 0,
      };
    });
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
      if (!account) return { token: "" };
      try {
        // Carry the account's exit proxy so the catalog fetch pins the same
        // egress IP as inference (fail-closed for anthropic).
        const token = await this.provider.refreshToken(account);
        return { token, proxyUrl: (account as any).proxyUrl };
      } catch {
        return { token: "" };
      }
    });
  }

  async leaseToken(req: any, payload: any) {
    const modelKey = String(payload?.modelKey || payload?.model || "").trim();
    // 每卡 token 配额(bucketLimits,按复合桶设的每模型上限)在此作为服务端兜底 enforce:
    // 客户端 localQuota 是主拦截(租号前回 429),服务端按复合桶精确再拦一道,防客户端被绕过。
    // 绑定卡另有 fair-share(下方)+ 账号原生配额;两层谁先到谁拦。
    const auth = this.accessKeyStore.resolveFromRequest(req, payload, {
      activate: true,
      enforceLimit: true,
      modelKey,
      // product 必传:用量事件按复合桶 `<product>-<family>` 记录(recordUsage 用 provider.id),
      // bucketLimits 也按复合桶配置;不传则 enforce 退化成 bare family,与两者都对不上。
      product: this.provider.id,
      // 绑定卡:限额窗口对齐绑定账号的上游刷新窗口(每桶);号池卡返回 0 → 走固定周期。
      alignedResetAt: (record: any) => this.boundAccountResetAt(record, modelKey),
    });
    // 超额(模型/周配额用尽)→ 429(带恢复时间),区别于无效/过期/禁用的 401。
    if (auth.limitExceeded) {
      const resetMs = Number(auth.resetMs || 0);
      throw this.fail(429, auth.error || "配额已用尽，请稍后再试", {
        ok: false,
        error: auth.error || "配额已用尽",
        ...(resetMs > 0 ? { retryAfterMs: resetMs } : {}),
      });
    }
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
    let rotated = false;

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
        const refreshBefore = (account as any).refreshToken;
        accessToken = await this.provider.refreshToken(account);
        rotated = refreshBefore !== (account as any).refreshToken;
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
      // 没有候选号(整池都被冷却/耗尽)→ 若主因是 503 容量冷却,明说官方上游抽风,
      // 而不是笼统的"额度恢复中"。lastError(token 刷新真错误)优先透出。
      throw this.fail(503, lastError?.message || this.poolUnavailableMessage(modelKey));
    }

    this.mutateAccount(account.id, () => ({ ...(account as TAccount) }));
    // A rotated refresh_token is the one field we can't afford to lose to the
    // debounce window — persist it now so a crash can't strand it in memory.
    if (rotated) this.flushAccounts();
    // A successful lease means the account is alive again — clear any persisted
    // dead verdict so it doesn't get re-marked on the next restart.
    this.clearPersistedAccountError(account.id);
    const lease = this.createLease(account, accessKeySessionId, auth.record.id, clientId, modelKey, payload, boundAccountId, accessToken);
    this.leases.set(lease.leaseId, lease);
    this.rememberAffinity(clientId, modelKey, account.id);
    this.totalLeases++;
    this.ensureDaily();
    this.dailyLeases++;
    const accStats = this.ensureAccountStats(account.id);
    accStats.totalLeases++;
    accStats.lastUsedAt = this.now();

    // Pre-compute account-level and per-card fair-share quota fractions.
    const accountBucketsData = this.accountBucketQuotas(account);
    const rawFairShare = (boundAccountId > 0 && this.fairShareTracker)
      ? this.fairShareTracker.getCardQuotaFractions(boundAccountId, auth.record.id)
      : undefined;
    // When fair-share tracker has no data for this card yet (first activation /
    // server restart), default to 100% for all known buckets so the card doesn't
    // inherit the shared account-level fraction from accountBuckets. Once the card
    // has real usage, getCardQuotaFractions() returns actual data and this fallback
    // is bypassed.
    const fairShareQuota = (rawFairShare && Object.keys(rawFairShare).length === 0 && boundAccountId > 0)
      ? Object.fromEntries(
          Object.keys(accountBucketsData).map(k => [k, { fraction: 1, resetAt: Date.now() + 5 * 60 * 60 * 1000 }]),
        )
      : rawFairShare;

    return {
      ok: true,
      leaseId: lease.leaseId,
      accessKeySessionId,
      sessionId: accessKeySessionId,
      sessionExpiresAt: auth.record.sessionExpiresAt || "",
      // 绑定卡:把账号对齐的窗口 reset 下发,客户端本地额度窗口据此与服务端对齐(号池卡为 0,不改)。
      accessKeyStatus: this.accessKeyStore.publicStatus(auth.record, this.boundAccountResetAt(auth.record, modelKey)),
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
      accountBuckets: accountBucketsData,
      ...this.provider.leaseResponseExtras(account),
      // 通用出口代理:该号绑定的粘性住宅出口(空=未绑定)。客户端据此固定出口 IP。
      accountProxyUrl: String((account as any).proxyUrl || "").trim(),
      // 出口策略下发为布尔,客户端无需写死 provider 名:
      // required(anthropic)=无代理则拒连;optional(codex/antigravity)=无代理走本地直连。
      egressRequired: this.provider.egressPolicy === "required",
      expiresAt: lease.expiresAt,
      accessTokenExpiresAt: lease.expiresAt,
      probation: false,
      candidateStats: { healthyForModel: candidatePool.length },
      // Bound cards have no OTHER account to rotate to. The client proxy uses this
      // to skip the futile "exclude account + re-lease" rotation on 429/503, while
      // STILL allowing wait-and-retry on the SAME account for transient capacity.
      bound: boundAccountId > 0,
      // Per-card fair-share quota fractions for blood bar display.
      // Only populated for bound cards with co-tenants.
      fairShareQuota,
    };
  }

  /**
   * Why a bound card's account is unavailable — a clear, user-facing reason.
   * "繁忙/额度恢复中" is reserved for a real, recoverable quota/capacity cooldown;
   * a missing/disabled/auth-broken account gets a distinct message so the user
   * doesn't wait forever for a recovery that will never come.
   */
  /**
   * For a BOUND card, the upstream reset time of its bound account for this
   * model — the boundary the card's limit window aligns to. Pool cards (no
   * binding) return 0 so the store falls back to a fixed-period window; a bound
   * account with no learned reset yet also returns 0 (fixed-period until known).
   */
  private boundAccountResetAt(record: any, modelKey: string): number {
    const boundId = this.accessKeyStore.boundAccountIdFor(record, this.provider.id);
    if (!boundId) return 0;
    const account = this.readAccounts().find((a) => a.id === boundId);
    if (!account) return 0;
    return getModelQuotaResetAt(account as any, modelKey);
  }

  private boundUnavailableMessage(boundAccountId: number): string {
    const acct = this.readAccounts().find((a) => a.id === boundAccountId);
    if (!acct || (acct as any).enabled === false) {
      return "此卡绑定的账号不可用（不存在或已禁用），请联系客服";
    }
    const runtime = this.accountRuntime.get(boundAccountId);
    // 永久死亡(项目删/禁、封号、地区不支持):首次命中时 quotaStatus 还是 "exhausted"
    // (尚未升级到 "error"),但它绝不会自愈 —— 别再显示"额度恢复中"误导用户白等首档
    // 冷却,直接给可操作的 block 文案(含"联系客服" → 客户端红 banner)。
    if (isPermanentDeathReason(runtime?.quotaStatusReason)) {
      return "此卡绑定的账号不可用（账号或项目异常），请联系客服重新绑定/换号";
    }
    // 验证挑战:号需人工验证,绑定卡无法自助 → 提示联系管理员去验证。
    if (runtime?.quotaStatusReason === "verification_required") {
      return "此卡绑定的账号需要验证，请联系管理员完成账号验证后再用";
    }
    if (runtime?.quotaStatus === "error") {
      return "此卡绑定的账号鉴权失效，请联系客服重新绑定/换号";
    }
    return this.busyMessage;
  }

  /** 用户可读的产品名(用于号池不可用文案)。 */
  private productLabel(): string {
    switch (this.provider.id) {
      case "antigravity":
        return "Gemini";
      case "anthropic":
        return "Claude";
      case "codex":
        return "Codex";
      default:
        return this.provider.id;
    }
  }

  /**
   * 整个号池都租不到时的文案(已被客户端的重试循环扫过一遍仍无可用号)。
   * 若池子空主要是因为账号处于【容量/503 冷却(cooling)】,就直说是【官方上游抽风】、
   * 不是用户额度问题 —— 而不是误导性的"额度恢复中"。antigravity(Gemini)单独加重语气,
   * 因为谷歌官方 503 抽风是家常便饭。
   */
  private poolUnavailableMessage(modelKey: string): string {
    const now = this.now();
    const normalized = normalizeModelKey(modelKey);
    let cooling = 0;
    let exhausted = 0;
    for (const account of this.readAccounts()) {
      const a = account as any;
      if (a.enabled === false || a.poolEnabled === false) continue;
      if (!this.provider.isAccountEligible(account)) continue;
      if (!(account.refreshToken || a.accessToken)) continue;
      const state = this.accountRuntime.get(account.id);
      if (!state) continue;
      // 只数"对【当前 modelKey】仍在封禁窗口内"的号,按其真实封禁 reason 分类。
      const cls = this.modelBlockClass(state, normalized, now);
      if (cls === "cooling") cooling++;
      else if (cls === "exhausted") exhausted++;
    }
    // 主因是容量/503(cooling)→ 明说官方上游抽风,别误导成"额度恢复中"。
    if (cooling > 0 && cooling >= exhausted) {
      const label = `${this.productLabel()}${modelKey ? `（${modelKey}）` : ""}`;
      if (this.provider.id === "antigravity") {
        return `antigravity 又抽风了：号池所有账号都试过了，全被挡了 503（服务过载），请跟我一起说：sb谷歌`;
      }
      return `${label} 官方上游暂不稳定（503 容量不足）：号池已全部重试仍失败，请稍后再试。`;
    }
    // 非 503 主因(额度耗尽/其它)→ 沿用原"无可用号"文案(各产品可定制),行为不变。
    return this.noAccountMessage;
  }

  /**
   * 判定某账号针对【指定 model】当前的封禁类别(只看仍生效的冷却,过期 stale 不算):
   *   "cooling"   → 503/容量(谷歌官方抽风)
   *   "exhausted" → 429/配额(号自身额度用尽)
   *   ""          → 对该 model 未被封 / 已过期 / 死号(error)等,不计入 503-vs-429 票数
   * 与 isAccountBlocked 的封禁判定同构:优先看 per-model 封禁,无 per-model 时看账号级冷却。
   */
  private modelBlockClass(
    state: AccountRuntimeState,
    normalizedModel: string,
    now: number,
  ): "cooling" | "exhausted" | "" {
    const isCapacity = (reason: string) => reason.includes("capacity") || reason.includes("503");
    if (normalizedModel) {
      const b = state.blockedModels.get(normalizedModel);
      if (b && b.blockedUntil > now) {
        return isCapacity(String(b.reason)) ? "cooling" : "exhausted";
      }
    }
    // 账号级冷却(无 per-model 封禁,如不带 modelKey 的冷却)且仍生效。
    if (
      state.blockedModels.size === 0 &&
      state.exhaustedUntil > now &&
      (state.quotaStatus === "cooling" || state.quotaStatus === "exhausted")
    ) {
      return state.quotaStatus;
    }
    return "";
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
    if (accountId && payload?.accountQuota && typeof payload.accountQuota === "object") {
      this.applyAccountQuotaSnapshot(accountId, payload.accountQuota);
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
        // Sync fair-share window to upstream resetTime
        const resetTimes = (account as any)?.modelQuotaResetTimes;
        if (resetTimes && typeof resetTimes === "object") {
          for (const [model, resetStr] of Object.entries(resetTimes)) {
            const resetMs = Date.parse(String(resetStr));
            if (Number.isFinite(resetMs) && resetMs > 0) {
              const bucket = bucketKey(this.provider.id, model);
              this.fairShareTracker.syncWindow(accountId, bucket, resetMs);
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
    const usage = this.usageForBilling(payload);
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
        const reportedReason = String(payload?.reason || "");
        if ((status === 403 || status === 400) && isPermanentDeathReason(reportedReason)) {
          // 账号/项目级永久死亡(service_disabled / 封号 / 地区不支持):reason 细分 +
          // 计数升级,别再当 60s/30s 瞬时(详见 markAccountPermanentDeath)。
          this.markAccountPermanentDeath(accountId, reportedReason);
        } else if (status === 403 && reportedReason.includes("verification")) {
          // 验证挑战:号被 Google 风控,【要人去验证】才能用,不是 60s 能自愈的瞬时错误。
          // 标成"需验证/不可用"状态(控制台红点 + "需验证"标签)+ 持久化,30min 后自动复检;
          // 验证通过后一次成功(markAccountSuccess,verification 不在不复活名单)即解封。
          this.markAccountVerificationRequired(accountId);
        } else if (status === 429 || status === 503) {
          const reason = String(payload?.reason || (status === 429 ? "quota" : "capacity"));
          const cooldownMs = this.cooldownForExhaustion(status, reason, retryAfterMs, accountId, modelKey);
          this.markAccountExhausted(accountId, modelKey, reason, cooldownMs);
          // Fair-share: confirm budget ceiling on upstream exhaustion.
          if (this.fairShareTracker && status === 429) {
            const bucket = bucketKey(this.provider.id, modelKey);
            this.fairShareTracker.confirmBudget(accountId, bucket);
            // Record exhaustion sample for quota profile learning
            if (this.quotaProfileTracker) {
              const state = this.fairShareTracker.getTrackerState(accountId, bucket);
              if (state && state.totalUsed > 0) {
                const account = this.readAccounts().find((a) => a.id === accountId);
                const planType = String((account as any)?.planType || "free");
                const resetAt = getModelQuotaResetAt(account as any, modelKey);
                const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
                const isWeekly = resetAt > this.now() + FIVE_HOURS_MS;
                const family = familyOfBucket(bucket);
                this.quotaProfileTracker.recordExhaustion(
                  this.provider.id, planType, family,
                  state.totalUsed, state.lastFraction, isWeekly,
                );
              }
            }
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
  private applyAccountQuotaSnapshot(accountId: number, quota: any): void {
    let snapshotAccount: TAccount | null = null;
    this.mutateAccount(accountId, (account) => {
      const result = this.provider.applyQuotaSnapshot(account, quota);
      snapshotAccount = result.account;
      return result.account;
    });
    // 御三家归一:统一提取该账号每个 fractions key 的 5h/周水位,写入水位时序。
    if (snapshotAccount && this.accountQuotaSnapshotTracker && this.provider.quotaSnapshotInputs) {
      const acc = snapshotAccount as { email?: string };
      const email = acc.email ?? null;
      for (const inp of this.provider.quotaSnapshotInputs(snapshotAccount)) {
        this.accountQuotaSnapshotTracker.record({ provider: this.provider.id, accountId, email, ...inp });
      }
    }
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

  /**
   * Flush dirty accounts to disk. If an external writer (e.g. the admin panel)
   * modified the file after we cached it, MERGE rather than discard: the disk
   * version is the base (keeps the panel's edits), and our authoritative volatile
   * token fields are layered back on top. Discarding would drop a freshly-rotated
   * refresh_token and kill the account a few days later (invalid_grant).
   */
  flushAccounts(): void {
    if (this._accountsSaveTimer) {
      clearTimeout(this._accountsSaveTimer);
      this._accountsSaveTimer = null;
    }
    if (!this._accountsDirty || !this._cachedAccounts) return;
    this._accountsDirty = false;

    const previous = readJsonFile(this.accountsFilePath);
    let externallyChanged = false;
    try {
      externallyChanged = fs.statSync(this.accountsFilePath).mtimeMs !== this._cachedMtimeMs;
    } catch { /* file deleted → recreate from our buffer */ }

    let accounts: unknown[] = this._cachedAccounts;
    if (externallyChanged) {
      const diskAccounts = Array.isArray(previous)
        ? previous
        : Array.isArray(previous.accounts) ? previous.accounts : [];
      accounts = this.mergeAccountTokenFields(diskAccounts, this._cachedAccounts);
    }

    const value = Array.isArray(previous) ? accounts : { ...previous, accounts };
    writeJsonFile(this.accountsFilePath, value);

    // Re-sync the cache from what we just wrote (normalized) and record its mtime,
    // so cache == disk and the next external-change check is accurate.
    this._cachedAccounts = null;
    this.readAccounts();
  }

  /**
   * Overlay each in-memory account's volatile token fields onto the external
   * (disk) version. Disk is the base so the panel's non-token edits survive;
   * token fields come from memory so a just-rotated refresh_token is never lost.
   * Accounts present only in memory (added in-process) are appended.
   */
  private mergeAccountTokenFields(diskAccounts: unknown[], memAccounts: TAccount[]): unknown[] {
    const TOKEN_FIELDS = ["accessToken", "accessTokenExpiresAt", "refreshToken"];
    const memById = new Map<number, any>();
    for (const a of memAccounts as any[]) memById.set(Number(a.id), a);
    const seen = new Set<number>();
    const merged: unknown[] = [];
    for (const disk of diskAccounts as any[]) {
      const id = Number(disk?.id);
      seen.add(id);
      const mem = memById.get(id);
      if (!mem) { merged.push(disk); continue; }
      const out: any = { ...disk };
      for (const f of TOKEN_FIELDS) {
        if (mem[f] !== undefined) out[f] = mem[f];
      }
      merged.push(out);
    }
    for (const mem of memAccounts as any[]) {
      if (!seen.has(Number(mem.id))) merged.push(mem);
    }
    return merged;
  }

  /** Restore persisted tracker state (quota profiles, fair-share windows) before
   * the app starts serving. Nest awaits this, so first requests see real budgets
   * and cross-restart "remaining" instead of defaults. */
  async onModuleInit(): Promise<void> {
    this.rehydrateAccountStatus();
    try { await this.quotaProfileTracker?.load(); } catch (err) { console.error("[lease-service] quotaProfileTracker load failed:", err); }
    try { await this.fairShareTracker?.load(); } catch (err) { console.error("[lease-service] fairShareTracker load failed:", err); }
  }

  /**
   * Restore persisted dead-account verdicts (quotaStatus=error) into runtime on
   * boot. Without this, a restart wipes the in-memory Map and silently revives
   * invalid_grant / repeatedly-failing accounts back into the pool — and the
   * bound-card user is told "额度恢复中" forever instead of "鉴权失效".
   */
  private rehydrateAccountStatus(): void {
    for (const account of this.readAccounts()) {
      const a = account as any;
      if (a.quotaStatus !== "error") continue;
      const state = this.ensureRuntime(account.id);
      state.quotaStatus = "error";
      state.quotaStatusReason = String(a.quotaStatusReason || "");
      state.exhaustedUntil = Number(a.blockedUntil || 0);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this._accountsSaveTimer) {
      clearTimeout(this._accountsSaveTimer);
      this._accountsSaveTimer = null;
    }
    try { this.flushAccounts(); } catch (err) { console.error("[lease-service] flushAccounts on shutdown failed:", err); }
    try { this.flushAccessKeys(); } catch (err) { console.error("[lease-service] accessKeyStore flush on shutdown failed:", err); }
    // Persist learned budgets + fair-share windows, then stop their flush timers.
    try { await this.quotaProfileTracker?.flush(); } catch (err) { console.error("[lease-service] quotaProfileTracker flush on shutdown failed:", err); }
    this.quotaProfileTracker?.destroy();
    try { await this.fairShareTracker?.flush(); } catch (err) { console.error("[lease-service] fairShareTracker flush on shutdown failed:", err); }
    this.fairShareTracker?.destroy();
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
      // 绑定卡(boundAccountId>0):忽略可恢复冷却,无号可换时冷却只会害卡不可用。
      !this.isAccountBlocked(account.id, modelKey || "", now, boundAccountId > 0),
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

  private usageForBilling(payload: any) {
    // usage 未解析到(0 token)时**不再**按 requestBodyBytes/4 凭空估算 ——
    // Codex 等请求体=整段本地上下文(且绝大部分是缓存),估出来等于"把全部上下文
    // 当一次全额用量"。宁可记 0(下游 `detail.totalTokens > 0` 才落库/计份额),也不乱计。
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
        exhaustedUntil: 0, consecutiveErrors: 0, transientErrors: 0, deathStrikes: 0, lastUsedAt: 0,
        blockedModels: new Map(),
      };
      this.accountRuntime.set(accountId, state);
    }
    return state;
  }

  private isAccountBlocked(accountId: number, modelKey: string, now: number, ignoreCooldown = false): boolean {
    const state = this.accountRuntime.get(accountId);
    if (!state) return false;

    this.cleanupExpiredBlocks(accountId, now);

    // 鉴权失效 / 封号 / 需验证(quotaStatus==="error"):号根本拿不到 token,绑定卡也救不了,
    // 必须拦(并由 boundUnavailableMessage 给"联系客服"文案)。这不属于"冷却",不受 ignoreCooldown 影响。
    if (state.quotaStatus === "error") return true;

    // 绑定卡(ignoreCooldown):只有这一个号、无号可换,429/503 这类【可恢复冷却】对它毫无意义 ——
    // 预先拦只会让卡白白不可用。一律忽略冷却,直接放行去试真上游;真不行就由上游回错,
    // 客户端自己重试/退避。冷却只对【池子卡】(有备用号可轮换)才有价值。
    if (ignoreCooldown) return false;

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
      this.persistQuotaStatus(accountId, state);
    } else if (state.consecutiveErrors >= REMOTE_ACCOUNT_ERROR_THRESHOLD) {
      state.quotaStatus = "error";
      state.quotaStatusReason = "consecutive_errors";
      this.persistQuotaStatus(accountId, state);
    }
  }

  /**
   * Clear a persisted dead verdict after the account leases successfully again
   * (e.g. a cooled-down account re-auth'd, or the panel re-imported credentials).
   * Without this, the stale quotaStatus=error on disk would re-mark the (now
   * healthy) account dead on the next restart. No-op on the common healthy path.
   */
  private clearPersistedAccountError(accountId: number) {
    const acct = this.readAccounts().find((a) => a.id === accountId) as any;
    if (!acct || acct.quotaStatus !== "error") return;
    const state = this.ensureRuntime(accountId);
    state.quotaStatus = "ok";
    state.quotaStatusReason = "";
    state.exhaustedUntil = 0;
    this.mutateAccount(accountId, (a) => {
      const next: any = { ...a };
      delete next.quotaStatus;
      delete next.quotaStatusReason;
      delete next.blockedUntil;
      return next as TAccount;
    });
    this.flushAccounts();
  }

  /**
   * 后台「手动启用/恢复」:把该号的【运行时】封禁状态彻底清掉(quotaStatus/冷却/计数/
   * per-model 封禁),并清除磁盘上的持久化死号标记 —— 立即放回候选池。
   * 必须走这里而不是只改文件 enabled:运行时封禁存在内存 accountRuntime,只在进程启动时
   * 从磁盘 rehydrate 一次,光改文件不会实时解封(尤其"需验证"是 quotaStatus=error)。
   */
  reactivateAccount(accountId: number): { ok: boolean; error?: string } {
    if (!Number.isFinite(accountId) || accountId <= 0) return { ok: false, error: "无效 accountId" };
    const state = this.ensureRuntime(accountId);
    state.quotaStatus = "ok";
    state.quotaStatusReason = "";
    state.exhaustedAt = 0;
    state.exhaustedUntil = 0;
    state.consecutiveErrors = 0;
    state.transientErrors = 0;
    state.deathStrikes = 0;
    state.blockedModels.clear();
    this.clearPersistedAccountError(accountId);
    return { ok: true };
  }

  /**
   * Persist a dead-account verdict (quotaStatus/reason/blockedUntil) to the
   * accounts file. Runtime state alone is wiped on restart, which silently
   * revives dead accounts into the pool and leaves the console showing them as
   * healthy. The status fields ride along on the account record (normalizeAccount
   * preserves them) and are re-hydrated into runtime on the next boot.
   */
  private persistQuotaStatus(accountId: number, state: AccountRuntimeState) {
    this.mutateAccount(accountId, (a) => ({
      ...a,
      quotaStatus: state.quotaStatus,
      quotaStatusReason: state.quotaStatusReason,
      blockedUntil: state.exhaustedUntil || 0,
    } as TAccount));
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
    // 已知配额 reset 时间 → 冷却到 reset 为止(信任快照),但以谷歌最长的【周窗】封顶防脏数据。
    // 不在 reset 前提前重试(否则必然又 429、再冷却,白烧一个换号位)。
    if (resetAt > this.now()) return Math.min(resetAt - this.now(), QUOTA_RESET_MAX_COOLDOWN_MS);
    // 未知 reset → 回落到保守默认(谷歌主窗 5h)。
    return QUOTA_EXHAUSTION_COOLDOWN_DEFAULT_MS;
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

  /**
   * Account/project-level PERMANENT death (service_disabled, suspended/restricted,
   * location_unsupported) — distinguished from transient 403/400 by reason. These
   * never self-heal on their own, so a flat ≤60s cooldown just recycles the dead
   * account every minute and re-burns a rotation slot. Strike-escalate instead:
   *   1st strike → medium account-wide cooldown (tolerate a one-off misclassification
   *                or a transient anti-abuse 403 that happens to match a marker);
   *   ≥ threshold → persisted dead verdict (quotaStatus=error), like invalid_grant:
   *                survives restart, not revived by a success report, re-probed only
   *                after the long cooldown expires.
   */
  private markAccountPermanentDeath(accountId: number, reason: string) {
    const state = this.ensureRuntime(accountId);
    const now = this.now();
    state.deathStrikes++;
    // Account-wide: clear per-model blocks so isAccountBlocked sees an empty map and
    // blocks every model (a dead project/account is not model-scoped).
    state.blockedModels.clear();
    state.exhaustedAt = now;
    state.quotaStatusReason = reason;
    if (state.deathStrikes >= PERMANENT_DEATH_STRIKE_THRESHOLD) {
      state.quotaStatus = "error";
      state.exhaustedUntil = now + PERMANENT_DEATH_COOLDOWN_MS;
      this.persistQuotaStatus(accountId, state);
    } else {
      state.quotaStatus = "exhausted";
      state.exhaustedUntil = now + PERMANENT_DEATH_FIRST_COOLDOWN_MS;
    }
  }

  /**
   * 验证挑战(403 account_verification_required):号被 Google 风控,需人工去验证才能用。
   * 标成"需验证/不可用":quotaStatus=error(控制台红点、出池)+ quotaStatusReason=
   * "verification_required"(控制台显示"需验证"标签)+ 持久化(跨重启)。30min 后自动复检;
   * 验证通过后一次成功即由 markAccountSuccess 解封(verification 不在不复活名单)。
   */
  private markAccountVerificationRequired(accountId: number) {
    const state = this.ensureRuntime(accountId);
    const now = this.now();
    state.blockedModels.clear(); // 账号级:整号不可用,非按 model
    state.quotaStatus = "error";
    state.quotaStatusReason = "verification_required";
    state.exhaustedAt = now;
    state.exhaustedUntil = now + VERIFICATION_RECHECK_COOLDOWN_MS; // 300min 自动复检
    this.persistQuotaStatus(accountId, state);
  }

  private markAccountSuccess(accountId: number, modelKey: string) {
    const state = this.accountRuntime.get(accountId);
    if (!state) return;

    state.consecutiveErrors = 0;
    state.transientErrors = 0;
    state.deathStrikes = 0;
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
      state.quotaStatus === "error" &&
      (state.quotaStatusReason === "invalid_grant" || isPermanentDeathReason(state.quotaStatusReason));
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
