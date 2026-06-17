import * as crypto from "crypto";
import * as fs from "fs";

import { defaultRemoteAccessDataDir } from "../remote-access/data-dir";
import { AccessKeyStore } from "../token-server/access-key-store";
import { isPermanentTokenRefreshError, maskEmail, readJsonFile, writeJsonFile } from "../token-server/data-store";
import { FairShareTracker, weeklyBucketKey } from "../token-server/fair-share-tracker";
import { accountWeight, EnterpriseProbeManager, getModelQuotaFraction, getModelQuotaResetAt, scoreAccount } from "../token-server/lease-scheduler";
import { QuotaProfileTracker, DEFAULT_WEEKLY_RATIO, clampWeeklyRatio, SAMPLE_DROP_STEP } from "./quota-profile-tracker";
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
  TOKEN_DEATH_STRIKE_THRESHOLD,
  TOKEN_DEATH_FIRST_COOLDOWN_MS,
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
import { SubscriptionScheduler } from "./subscription-scheduler";

export type TokenUsageTracker = {
  record: (event: {
    accessKeyId: string;
    customerId?: string;
    accessKeyName?: string;
    accountId?: number;
    accountEmail?: string;
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
  // invalid_grant「N 击确认」计数:每次 token 刷新撞 invalid_grant +1,刷成功清零。
  // 攒满 TOKEN_DEATH_STRIKE_THRESHOLD 才升级为持久化死号,前几次只软冷却。
  tokenDeathStrikes: number;
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
// reason 模糊时区分瞬时限速 / 配额耗尽的 retry-after 分界线:瞬时限速恢复以秒~分钟计,
// 配额窗口(5h/周)恢复以小时~天计。上游给的 retry-after 远超此值 = 配额耗尽,绝非瞬时限速
// —— 此时信上游明说的 retry-after,胜过信本地可能过时的额度余量快照。
const RATE_LIMIT_MAX_RETRY_AFTER_MS = 5 * 60 * 1000;
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
  /** Continuous quota-profile sampling cursors, per (accountId, scope-key).
   *  Holds the per-account fraction stream state for the "sample every ~10% drop"
   *  trigger + cross-window-reset detection. Per-account (NOT in the cross-account
   *  QuotaProfile, which would cross-contaminate). Rebuilt after restart. */
  private readonly profileSampleCursors = new Map<string, { lastFraction: number; windowStart: number; lastTotalUsed: number }>();
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
  private subscriptionScheduler: SubscriptionScheduler | null = null;

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
    this.minClientVersion = options.minClientVersion ?? "10.0.1";
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

  private ensureScheduler(): SubscriptionScheduler {
    if (!this.subscriptionScheduler) {
      this.subscriptionScheduler = new SubscriptionScheduler(this.accessKeyStore, this.fairShareTracker);
    }
    return this.subscriptionScheduler;
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
    /** 看板展示「客户 + 套餐 + 到期」替掉裸 id。 */
    customerId?: string;
    products?: string[];
    expiresAt?: string | null;
  }> {
    // account-system:号下绑定的就是订阅(subscriptionById,DB 唯一真相源);文件卡已退役,不再取
    // (不混合)。订阅行带 客户/套餐/到期,供前端展示「邮箱 + 套餐」而非裸 id。纯展示口径;公平份额
    // 限流另按 weight/capacity 计。
    return this.accessKeyStore.subscriptionsBoundToAccount(accountId, this.provider.id).map((id) => {
      const record = this.accessKeyStore.findById(id);
      const pub = record ? this.accessKeyStore.publicStatus(record) : null;
      const r = record as any;
      const w = Math.floor(Number(r?.weight ?? 1));
      const weight = Number.isFinite(w) && w >= 1 ? w : 1;
      return {
        id,
        name: pub?.name || record?.name || "",
        weight,
        totalTokensUsed: Number(pub?.totalTokensUsed || 0),
        totalRequests: Number(pub?.totalRequests || 0),
        fairShare: this.fairShareTracker?.getCardQuotaFractions(accountId, id) || {},
        windowWeightedUsed: this.fairShareTracker?.getCardWindowUsed(accountId, id) || 0,
        customerId: r?.customerId,
        products: Array.isArray(r?.products) ? r.products : [],
        expiresAt: r?.keyExpiresAt ?? null,
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
    // 订阅卡(customerId)可能触发账户级接力:先不 enforce,拿到 record 后再决策路径。
    // 文件卡(无 customerId)不接力,在拿到 record 后手动做 precheckRecord 兜底。
    const auth = await this.accessKeyStore.resolveFromRequest(req, payload, {
      activate: true,
      enforceLimit: false,
      modelKey,
      // product 必传:用量事件按复合桶 `<product>-<family>` 记录(recordUsage 用 provider.id),
      // bucketLimits 也按复合桶配置;不传则 enforce 退化成 bare family,与两者都对不上。
      product: this.provider.id,
      // 绑定卡:限额窗口对齐绑定账号的上游刷新窗口(每桶);号池卡返回 0 → 走固定周期。
      alignedResetAt: (record: any) => this.boundAccountResetAt(record, modelKey),
      // 派生周上限(anthropic/codex)用的 5h/周 换算比 R。回调解 record→R 的鸡生蛋。
      weeklyRatio: (record: any) => this.resolveWeeklyRatio(record, modelKey),
    });
    // Session-JWT auth failure → machine code in `error` (SESSION_INVALID /
    // DEVICE_REVOKED / SUBSCRIPTION_EXPIRED). The desktop client treats these as
    // fatal (re-login / renew) instead of retrying, so the code MUST ride in the
    // body's error field verbatim.
    if (auth.sessionError) {
      throw this.fail(auth.sessionError.statusCode, auth.error || "Unauthorized", {
        ok: false,
        error: auth.sessionError.code,
      });
    }
    if (!auth.record) throw this.fail(401, auth.error || "Unauthorized");
    // `let`: 账户级接力可能把 auth.record 换成「绑到别的号」的订阅,换后必须重算 boundAccountId,
    // 否则后续公平份额 / 取号会落在认证卡的旧号上,而非接力真正选中的那个号。
    let boundAccountId = this.accessKeyStore.boundAccountIdFor(auth.record, this.provider.id);

    // ── 账户级订阅优先级接力 ──────────────────────────────────────────────
    // 订阅卡(有 customerId):按 priority 在该账户的订阅间选第一个该 bucket 有额度的,
    // 替换 auth.record。优先订阅用完会自动切到下一个;全部用尽则 429。
    // 文件卡(无 customerId)不接力,对原 record 做 precheckRecord 服务端兜底 enforce。
    if (auth.record.customerId) {
      const bucket = bucketKey(this.provider.id, modelKey);
      const relay = this.ensureScheduler().selectForFailover({
        customerId: auth.record.customerId,
        providerId: this.provider.id,
        modelKey,
        bucket,
        precheckOptions: {
          modelKey,
          product: this.provider.id,
          alignedResetAt: (rec: any) => this.boundAccountResetAt(rec, modelKey),
          weeklyRatio: (rec: any) => this.weeklyRatioForFamily(rec, familyOfBucket(bucket)),
        },
      });
      if (relay.picked) {
        auth.record = relay.picked;
        // 接力可能选中绑到不同上游号的订阅 → 用选中 record 重算,后续闸门/取号都对齐它的号。
        boundAccountId = this.accessKeyStore.boundAccountIdFor(auth.record, this.provider.id);
      } else {
        const resetMs = Number(relay.resetMs || 0);
        throw this.fail(429, "账户所有订阅额度已用尽，请稍后再试", {
          ok: false,
          error: "账户所有订阅额度已用尽",
          ...(resetMs > 0 ? { retryAfterMs: resetMs } : {}),
        });
      }
    } else {
      // 超额(模型/周配额用尽)→ 429(带恢复时间),区别于无效/过期/禁用的 401。
      const limitCheck = this.accessKeyStore.precheckRecord(auth.record, {
        modelKey,
        product: this.provider.id,
        alignedResetAt: (record: any) => this.boundAccountResetAt(record, modelKey),
        weeklyRatio: (record: any) => this.resolveWeeklyRatio(record, modelKey),
        enforceLimit: true,
      });
      if (!limitCheck.allowed) {
        const resetMs = Number(limitCheck.resetMs || 0);
        const quota = this.buildLeaseQuotaPayload(auth.record, boundAccountId, modelKey);
        throw this.fail(429, limitCheck.reason || "配额已用尽，请稍后再试", {
          ok: false,
          error: limitCheck.reason || "配额已用尽",
          ...(resetMs > 0 ? { retryAfterMs: resetMs } : {}),
          accountBuckets: quota.accountBucketsData,
          accessKeyStatus: quota.accessKeyStatus,
          ...(quota.fairShareQuota ? { fairShareQuota: quota.fairShareQuota } : {}),
          ...(quota.weeklyFairShareQuota ? { weeklyFairShareQuota: quota.weeklyFairShareQuota } : {}),
        });
      }
    }

    // Two card modes:
    //  • Bound  (boundAccountId > 0): pinned to one account in this pool — lease
    //    only from it, no dynamic-pool fallback.
    //  • Pool   (no binding at all): legacy dynamic pool with failover.
    // A card bound for a DIFFERENT pool only is not sold for this one → rejected.
    const displayBoundAccountId = this.displayBoundAccountIdFor(auth.record);
    const isPreferredDynamic = this.isPreferredDynamic(auth.record);
    const hardPinnedAccountId = isPreferredDynamic ? 0 : displayBoundAccountId;

    if (displayBoundAccountId === 0 && this.accessKeyStore.hasAnyBinding(auth.record)) {
      throw this.fail(409, "此卡未开通该服务，请联系客服");
    }
    // M13b: plan-backed shadow records (requiresBinding, set by entitlement-sync)
    // must HOLD a seat in this pool to lease. Seat exhaustion at activation
    // leaves them with NO bindings at all — without this guard they'd fall
    // through to the broad dynamic POOL below, granting access the plan never
    // sold. Distinct wording from the wrong-product 409 above so ops can tell
    // seat-exhaustion from not-sold-for-this-pool. Cards and legacy pool
    // records never carry the flag → their paths are byte-identical.
    if (displayBoundAccountId === 0 && auth.record.requiresBinding) {
      throw this.fail(409, "服务开通中，请稍后重试或联系客服");
    }

    // Fair-share check: bound cards with multiple co-tenants get dynamic quotas.
    if (hardPinnedAccountId > 0 && this.fairShareTracker) {
      const bucket = bucketKey(this.provider.id, modelKey);
      const check = this.fairShareTracker.checkFairShare(hardPinnedAccountId, auth.record.id, bucket);
      if (!check.allowed) {
        const quota = this.buildLeaseQuotaPayload(auth.record, hardPinnedAccountId, modelKey);
        throw this.fail(429, check.reason || "公平限额已用完，请等待额度恢复", {
          ok: false,
          error: check.reason || "公平限额已用完，请等待额度恢复",
          ...(check.retryAfterMs ? { retryAfterMs: check.retryAfterMs } : {}),
          accountBuckets: quota.accountBucketsData,
          accessKeyStatus: quota.accessKeyStatus,
          ...(quota.fairShareQuota ? { fairShareQuota: quota.fairShareQuota } : {}),
          ...(quota.weeklyFairShareQuota ? { weeklyFairShareQuota: quota.weeklyFairShareQuota } : {}),
        });
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

    const clientId = String(payload?.clientId || payload?.client || "").trim();
    // Session lease (the only runtime credential): multi-device is governed by
    // Device rows + Subscription.deviceLimit (enforced at login), NOT a
    // per-card single-session lock — concurrent clients may lease the same
    // shadow record. The lease still needs a stable non-empty session id for
    // its bookkeeping.
    const accessKeySessionId = `sess:${clientId || "session"}`;

    const tokenFailedIds: number[] = [];
    let lastError: Error | null = null;
    let account: TAccount | null = null;
    let accessToken = "";
    let rotated = false;

    this.cleanupExpiredLeases();
    const leaseIndex = this.buildActiveLeaseIndex();

    const candidatePool = isPreferredDynamic
      ? this.preferredDynamicAccounts(payload, modelKey, displayBoundAccountId, leaseIndex, clientId)
      : this.availableAccounts(payload, modelKey, hardPinnedAccountId);
    // A bound card has at most one candidate (its account), so there is nothing to
    // scan past — one attempt, then the busy error. No fallback to other accounts.
    const maxAttempts = hardPinnedAccountId
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
      account = isPreferredDynamic
        ? this.preferredDynamicAccounts(extendedPayload, modelKey, displayBoundAccountId, leaseIndex, clientId)[0] || null
        : this.selectAccount(modelKey, clientId, extendedPayload, leaseIndex, hardPinnedAccountId);
      if (!account) break;

      try {
        const refreshBefore = (account as any).refreshToken;
        accessToken = await this.provider.refreshToken(account);
        rotated = refreshBefore !== (account as any).refreshToken;
        const runtime = this.ensureRuntime(account.id);
        runtime.consecutiveErrors = 0;
        runtime.tokenDeathStrikes = 0; // 刷 token 成功 → 清掉 invalid_grant 软冷却计数
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
      if (hardPinnedAccountId) throw this.fail(503, this.boundUnavailableMessage(hardPinnedAccountId));
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
    const lease = this.createLease(account, accessKeySessionId, auth.record.id, clientId, modelKey, payload, hardPinnedAccountId, accessToken);
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
    const rawFairShare = (hardPinnedAccountId > 0 && this.fairShareTracker)
      ? this.fairShareTracker.getCardQuotaFractions(hardPinnedAccountId, auth.record.id)
      : undefined;
    // When fair-share tracker has no data for this card yet (first activation /
    // server restart), default to 100% for all known buckets so the card doesn't
    // inherit the shared account-level fraction from accountBuckets. Once the card
    // has real usage, getCardQuotaFractions() returns actual data and this fallback
    // is bypassed.
    const fairShareQuota = (rawFairShare && Object.keys(rawFairShare).length === 0 && hardPinnedAccountId > 0)
      ? Object.fromEntries(
          Object.keys(accountBucketsData).map(k => [k, { fraction: 1, resetAt: Date.now() + 5 * 60 * 60 * 1000 }]),
        )
      : rawFairShare;

    // 周血条:仅启用周窗口的线(codex/anthropic)下发,结构与 fairShareQuota 平行(同 bucket 键)。
    // 旧客户端忽略该字段、不受影响。空数据(首次激活/重启)同样回落 100% 满条。
    const weeklyTracked = hardPinnedAccountId > 0 && this.fairShareTracker?.isWeeklyTracked() === true;
    const rawWeeklyFairShare = weeklyTracked
      ? this.fairShareTracker!.getCardWeeklyQuotaFractions(hardPinnedAccountId, auth.record.id)
      : undefined;
    const weeklyFairShareQuota = !weeklyTracked
      ? undefined
      : (rawWeeklyFairShare && Object.keys(rawWeeklyFairShare).length === 0)
        ? Object.fromEntries(
            Object.keys(accountBucketsData).map(k => [k, { fraction: 1, resetAt: Date.now() + 7 * 24 * 60 * 60 * 1000 }]),
          )
        : rawWeeklyFairShare;

    return {
      ok: true,
      leaseId: lease.leaseId,
      activeSubscriptionId: auth.record.id,
      accessKeySessionId,
      sessionId: accessKeySessionId,
      sessionExpiresAt: auth.record.sessionExpiresAt || "",
      // 绑定卡:把账号对齐的窗口 reset 下发,客户端本地额度窗口据此与服务端对齐(号池卡为 0,不改)。
      accessKeyStatus: this.publicAccessKeyStatus(auth.record, modelKey),
      accountId: account.id,
      emailHint: maskEmail(account.email),
      serviceAccount: {
        accountId: account.id,
        emailHint: maskEmail(account.email),
        planType: (account as any).planType || "",
      },
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
      bound: hardPinnedAccountId > 0,
      displayBound: isPreferredDynamic || displayBoundAccountId > 0,
      // Per-card fair-share quota fractions for blood bar display.
      // Only populated for bound cards with co-tenants.
      fairShareQuota,
      // 周窗口的每卡 fraction(「周血条」),仅 codex/anthropic 绑卡;undefined → JSON 中省略。
      ...(weeklyFairShareQuota ? { weeklyFairShareQuota } : {}),
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
    const hourlyResetAt = this.boundAccountHourlyResetAt(account as any);
    if (hourlyResetAt > 0) return hourlyResetAt;
    if (this.provider.id === "anthropic" || this.provider.id === "codex") return 0;
    return getModelQuotaResetAt(account as any, modelKey);
  }

  private boundAccountHourlyResetAt(account: any): number {
    const raw = this.provider.id === "anthropic"
      ? account?.claudeHourlyResetTime
      : this.provider.id === "codex"
        ? account?.codexHourlyResetTime
        : "";
    const parsed = Date.parse(String(raw || ""));
    return Number.isFinite(parsed) && parsed > this.now() ? parsed : 0;
  }

  private publicAccessKeyStatus(record: any, modelKey: string): any {
    return this.accessKeyStore.publicStatus(
      record,
      this.boundAccountResetAt(record, modelKey),
      (bucket: string) => this.weeklyRatioForFamily(record, familyOfBucket(bucket)),
    );
  }

  private buildLeaseQuotaPayload(record: any, boundAccountId: number, modelKey: string, account?: TAccount | null): {
    accountBucketsData: Record<string, { fraction: number; resetAt: number }>;
    fairShareQuota?: Record<string, { fraction: number; resetAt: number }>;
    weeklyFairShareQuota?: Record<string, { fraction: number; resetAt: number }>;
    accessKeyStatus: any;
  } {
    const resolvedAccount = account || (boundAccountId > 0
      ? this.readAccounts().find((a) => a.id === boundAccountId) || null
      : null);
    const accountBucketsData = resolvedAccount ? this.accountBucketQuotas(resolvedAccount) : {};
    const accessKeyStatus = this.publicAccessKeyStatus(record, modelKey);
    const rawFairShare = (boundAccountId > 0 && this.fairShareTracker)
      ? this.fairShareTracker.getCardQuotaFractions(boundAccountId, record.id)
      : undefined;
    const fairShareQuota = (rawFairShare && Object.keys(rawFairShare).length === 0 && boundAccountId > 0)
      ? Object.fromEntries(
          Object.keys(accountBucketsData).map((k) => [k, { fraction: 1, resetAt: this.now() + 5 * 60 * 60 * 1000 }]),
        )
      : rawFairShare;
    const weeklyTracked = boundAccountId > 0 && this.fairShareTracker?.isWeeklyTracked() === true;
    const rawWeeklyFairShare = weeklyTracked
      ? this.fairShareTracker!.getCardWeeklyQuotaFractions(boundAccountId, record.id)
      : undefined;
    const weeklyFairShareQuota = !weeklyTracked
      ? undefined
      : (rawWeeklyFairShare && Object.keys(rawWeeklyFairShare).length === 0)
        ? Object.fromEntries(
            Object.keys(accountBucketsData).map((k) => [k, { fraction: 1, resetAt: this.now() + 7 * 24 * 60 * 60 * 1000 }]),
          )
        : rawWeeklyFairShare;

    return {
      accountBucketsData,
      fairShareQuota,
      weeklyFairShareQuota,
      accessKeyStatus,
    };
  }

  /**
   * 派生周上限用的 5h/周 换算比 R:卡设置框(weeklyRatio>0) > 后台学习(weekly/5h) > 全局默认。
   * 池子卡无固定账号 → 按最高档假定(claude=max / gpt=pro);绑卡用绑定账号的真实 plan。
   */
  private resolveWeeklyRatio(record: any, modelKey: string): number {
    return this.weeklyRatioForFamily(record, familyOfBucket(bucketKey(this.provider.id, modelKey)));
}

  /** 按家族解析 R(供 enforce 与 publicStatus 共用)。family = claude|gpt|gemini。 */
  private weeklyRatioForFamily(record: any, family: string): number {
    const cardR = Number(record?.weeklyRatio || 0);
    if (cardR > 0) return clampWeeklyRatio(cardR);
    const topPlan = family === "gpt" ? "pro" : "max";
    let plan = topPlan;
    const boundId = this.accessKeyStore.boundAccountIdFor(record, this.provider.id);
    if (boundId > 0) {
      const acct = this.readAccounts().find((a) => a.id === boundId) as any;
      plan = String(acct?.planType || "").trim() || topPlan;
    }
    return clampWeeklyRatio(this.quotaProfileTracker?.getWeeklyToShortRatio(this.provider.id, plan, family) ?? DEFAULT_WEEKLY_RATIO);
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

  private syncFairShareQuotaSnapshot(accountId: number, account: TAccount): void {
    if (!this.fairShareTracker) return;

    const inputs = this.provider.quotaSnapshotInputs?.(account) || [];
    if (inputs.length > 0) {
      for (const inp of inputs) {
        const bucket = bucketKey(this.provider.id, inp.modelKey);
        const hourlyFraction = this.quotaPercentToFraction(inp.hourlyPercent);
        if (hourlyFraction !== null) {
          this.fairShareTracker.updateBudgetEstimate(accountId, bucket, hourlyFraction);
        }

        const hourlyReset = inp.hourlyResetAt ? inp.hourlyResetAt.getTime() : 0;
        if (Number.isFinite(hourlyReset) && hourlyReset > 0) {
          this.fairShareTracker.syncWindow(accountId, bucket, hourlyReset);
        }

        const weeklyFraction = this.quotaPercentToFraction(inp.weeklyPercent);
        if (weeklyFraction !== null) {
          this.fairShareTracker.updateWeeklyBudgetEstimate(accountId, bucket, weeklyFraction);
        }

        const weeklyReset = inp.weeklyResetAt ? inp.weeklyResetAt.getTime() : 0;
        if (Number.isFinite(weeklyReset) && weeklyReset > 0) {
          this.fairShareTracker.syncWeeklyWindow(accountId, bucket, weeklyReset);
        }
      }
      return;
    }

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

  private quotaPercentToFraction(value: unknown): number | null {
    if (value == null) return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return n > 1 ? Math.min(1, n / 100) : Math.min(1, n);
  }

  /**
   * Continuous quota-profile sampling. Called AFTER recordUsage so the sampled
   * totalUsed already includes this request and is aligned with the (post-report)
   * upstream fraction. Samples once per ~10% drop in the remaining fraction.
   * Cross-window reset is detected from the SAME windowStart that clears perCard.
   */
  private maybeSampleQuotaProfile(accountId: number, account: TAccount, record: any): void {
    if (!this.fairShareTracker || !this.quotaProfileTracker) return;
    const inputs = this.provider.quotaSnapshotInputs?.(account) || [];
    if (inputs.length === 0) return; // structured snapshot only (codex/anthropic); others learn via 429
    const planType = String((account as any)?.planType || "free").toLowerCase();
    // 决策④:绑卡(1 号≈GFA 独占)跳过门6;池卡/万能卡启用一致性门6。
    const isBound = this.accessKeyStore.boundAccountIdFor(record, this.provider.id) > 0;
    for (const inp of inputs) {
      const bucket = bucketKey(this.provider.id, inp.modelKey);
      const family = familyOfBucket(bucket);
      this.sampleQuotaScope(accountId, planType, family, bucket, false, this.quotaPercentToFraction(inp.hourlyPercent), isBound);
      if (this.fairShareTracker.isWeeklyTracked()) {
        this.sampleQuotaScope(accountId, planType, family, bucket, true, this.quotaPercentToFraction(inp.weeklyPercent), isBound);
      }
    }
  }

  /** One scope (5h or weekly) of the continuous sampler. */
  private sampleQuotaScope(
    accountId: number,
    planType: string,
    family: string,
    bucket: string,
    isWeekly: boolean,
    fraction: number | null,
    isBound: boolean,
  ): void {
    if (fraction === null) return; // gate A.1: no real reading → never sample
    const scopeKey = isWeekly ? weeklyBucketKey(bucket) : bucket;
    const state = this.fairShareTracker!.getTrackerState(accountId, scopeKey);
    if (!state) return;
    const totalUsed = state.totalUsed;
    const cursorKey = `${accountId}${scopeKey}`;
    const cursor = this.profileSampleCursors.get(cursorKey);

    // Gate A.2: window reset (windowStart changed = perCard was cleared) → reset
    // baseline, never sample across the boundary (avoids phantom negative consumption).
    if (!cursor || cursor.windowStart !== state.windowStart) {
      this.profileSampleCursors.set(cursorKey, { lastFraction: fraction, windowStart: state.windowStart, lastTotalUsed: totalUsed });
      return;
    }
    // Fraction rose within the same window (coarse-granularity jitter) → re-baseline, don't sample.
    if (fraction > cursor.lastFraction) {
      cursor.lastFraction = fraction;
      cursor.lastTotalUsed = totalUsed;
      return;
    }
    // Trigger: only sample once per ~10% drop in remaining fraction.
    if (cursor.lastFraction - fraction < SAMPLE_DROP_STEP) return;

    // Gate A.6 (pool/universal cards only): this step's usage increment must
    // plausibly explain this step's fraction drop, else an external consumer of
    // the shared account is polluting the estimate → skip.
    if (!isBound) {
      const usedDelta = totalUsed - cursor.lastTotalUsed;
      const fracDrop = cursor.lastFraction - fraction;
      if (!(usedDelta > 0) || fracDrop <= 0) {
        cursor.lastFraction = fraction;
        cursor.lastTotalUsed = totalUsed;
        return;
      }
      const stepEst = usedDelta / fracDrop;
      const totalEst = fraction < 1 ? totalUsed / (1 - fraction) : stepEst;
      if (stepEst > totalEst * 3 || stepEst < totalEst / 3) {
        cursor.lastFraction = fraction;
        cursor.lastTotalUsed = totalUsed;
        return; // inconsistent → likely external consumption, drop
      }
    }

    this.quotaProfileTracker!.recordSample(this.provider.id, planType, family, totalUsed, fraction, isWeekly);
    cursor.lastFraction = fraction;
    cursor.lastTotalUsed = totalUsed;
  }

  async reportResult(req: any, payload: any) {
    // 多订阅修复:report 也按本线固定 product 解析订阅(与 leaseToken 同口径)。否则 product-less
    // 解析会在「同一账户持多产品订阅」时选成全局最长寿订阅 → 与 lease 记录的订阅 mismatch、
    // 用量记到错订阅甚至 403 上报失败(部分产品白嫖 + 统计错乱)。
    const auth = await this.accessKeyStore.resolveFromRequest(req, payload, { product: this.provider.id });
    // Same machine-code contract as leaseToken for session-JWT failures.
    if (auth.sessionError) {
      throw this.fail(auth.sessionError.statusCode, auth.error || "Unauthorized", {
        ok: false,
        error: auth.sessionError.code,
      });
    }
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

    // Session leases have no per-card session machinery (see leaseToken);
    // usage attribution below works because record.id == lease.accessKeyId
    // == Subscription.id.
    if (accountId && payload?.accountQuota && typeof payload.accountQuota === "object") {
      this.applyAccountQuotaSnapshot(accountId, payload.accountQuota);
      // Fair-share: push updated quota fractions into the tracker.
      if (this.fairShareTracker) {
        const account = this.readAccounts().find((a) => a.id === accountId);
        if (account) this.syncFairShareQuotaSnapshot(accountId, account);
      }
    }

    if (!reportId && success && lease?.successfulReportSeen) {
      return {
        ok: true, ignored: true, reason: "already_reported",
        accessKeyStatus: this.publicAccessKeyStatus(auth.record, modelKey),
      };
    }
    const usage = this.usageForBilling(payload);
    const wasNew = this.accessKeyStore.recordUsage(cardId, status, usage, modelKey, dedupId, this.provider.id);
    if (!wasNew) {
      return {
        ok: true, ignored: true, reason: "already_reported",
        accessKeyStatus: this.publicAccessKeyStatus(auth.record, modelKey),
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
          modelKey, // 真实模型 → 按 Claude 档位单价(Opus/Sonnet/Haiku/Fable)计权
        );
      }
      // Continuous quota-profile sampling — MUST run after recordUsage above so
      // the sampled totalUsed includes this request (aligned with the upstream
      // fraction from applyAccountQuotaSnapshot earlier in this report).
      if (this.quotaProfileTracker) {
        const account = this.readAccounts().find((a) => a.id === accountId);
        if (account) this.maybeSampleQuotaProfile(accountId, account, auth.record);
      }
    }

    // Per-call token usage log (queryable, persisted to Prisma). Runs only for
    // counted (exactly-once) reports — recordUsage above already deduped. We log
    // the same canonical numbers the card counters persist; skip zero-token
    // reports (errors / capacity rejections carry no usage).
    if (this.tokenUsageTracker) {
      const detail = this.accessKeyStore.computeUsageDetail(usage, modelKey, this.provider.id);
      if (detail.totalTokens > 0) {
        // Stamp the STABLE account identity (email) alongside the volatile positional
        // accountId, so per-account usage survives pool reloads / cross-machine moves.
        const servingAccount = accountId ? this.readAccounts().find((a) => a.id === accountId) : undefined;
        const accountEmail = (servingAccount as { email?: string } | undefined)?.email || undefined;
        this.tokenUsageTracker.record({
          accessKeyId: cardId,
          customerId: (auth.record?.customerId as string | undefined),
          accessKeyName: auth.record?.name || undefined,
          accountId: accountId || undefined,
          accountEmail,
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
          // 瞬时限速 429(账号额度未耗尽)与额度耗尽 429 必须分开处理:前者账号是健康的,
          // 几秒即恢复 —— 一点不冷却、不踢出轮换,下个请求立刻还能用它(本次由客户端轮换到别的号)。
          // 也不拿它当 quota-profile 样本(账号仍有额度,会污染学到的预算)。
          // 只有真·额度耗尽 / 503 容量才进入下面的「冷却到配额窗口 + 采样」路径。
          // 零冷却仅限 opt-in 的 provider(anthropic/codex);antigravity 不 opt-in → 其 429
          // 一律走下面的冷却路径(this.provider.rateLimitZeroCooldown falsy)。
          if (
            status === 429
            && this.provider.rateLimitZeroCooldown
            && this.isRateLimit429(reason, accountId, modelKey, retryAfterMs)
          ) {
            // no-op:健康号不动它(零冷却)。
          } else {
            const cooldownMs = this.cooldownForExhaustion(status, reason, retryAfterMs, accountId, modelKey);
            this.markAccountExhausted(accountId, modelKey, reason, cooldownMs);
            // Fair-share: 429 backstop quota-profile sample (density safety net for
            // sparse windows). NOT a special per-account SET — just one more sample
            // into the same decayed-median pool.
            if (this.fairShareTracker && status === 429 && this.quotaProfileTracker) {
              const bucket = bucketKey(this.provider.id, modelKey);
              const account = this.readAccounts().find((a) => a.id === accountId);
              const resetAt = account ? getModelQuotaResetAt(account as any, modelKey) : 0;
              const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
              const isWeekly = this.fairShareTracker.isWeeklyTracked()
                && (retryAfterMs > FIVE_HOURS_MS || resetAt > this.now() + FIVE_HOURS_MS);

              const state = this.fairShareTracker.getTrackerState(accountId, isWeekly ? weeklyBucketKey(bucket) : bucket);
              if (state && state.totalUsed > 0) {
                const planType = String((account as any)?.planType || "free");
                const family = familyOfBucket(bucket);
                this.quotaProfileTracker.recordSample(
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
      accessKeyStatus: this.publicAccessKeyStatus(auth.record, modelKey),
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

  async shadowReport(req: any, payload: any) {
    await this.accessKeyStore.resolveFromRequest(req, payload);
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

  private availableAccounts(
    payload: any,
    modelKey?: string,
    boundAccountId = 0,
    options: { includePoolDisabled?: boolean } = {},
  ) {
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
      (boundAccountId || options.includePoolDisabled ? true : (account as any).poolEnabled !== false) &&
      (account as any).enabled !== false &&
      this.provider.isAccountEligible(account) &&
      Boolean(account.refreshToken || (account as any).accessToken) &&
      !excluded.has(account.id) &&
      // 绑定卡(boundAccountId>0):忽略可恢复冷却,无号可换时冷却只会害卡不可用。
      !this.isAccountBlocked(account.id, modelKey || "", now, boundAccountId > 0),
    );
  }

  private isPreferredDynamic(record: any): boolean {
    return String(record?.assignmentPolicy || "").toLowerCase() === "preferred-dynamic";
  }

  private displayBoundAccountIdFor(record: any): number {
    const display = record?.displayBindings;
    if (display && typeof display === "object") {
      const id = Number(display[this.provider.id] || 0);
      if (Number.isFinite(id) && id > 0) return id;
    }
    return this.accessKeyStore.boundAccountIdFor(record, this.provider.id);
  }

  private preferredDynamicAccounts(
    payload: any,
    modelKey: string,
    displayBoundAccountId: number,
    leaseIndex: ActiveLeaseIndex,
    clientId: string,
  ): TAccount[] {
    const candidates = this.availableAccounts(payload, modelKey, 0, { includePoolDisabled: true });
    if (!candidates.length) return [];

    const displayAccount = displayBoundAccountId > 0
      ? candidates.find((account) => account.id === displayBoundAccountId) || null
      : null;
    const displayPlanType = String((displayAccount as any)?.planType || "").toLowerCase();
    const preferredAccountId = this.preferredAccountId(clientId, modelKey);
    const now = this.now();

    const ranked = candidates
      .filter((account) => account.id !== displayBoundAccountId)
      .map((account) => ({
        account,
        sameLevel: displayPlanType
          ? String((account as any).planType || "").toLowerCase() === displayPlanType
          : false,
        remaining: this.tighterRemainingFraction(account, modelKey),
        score: scoreAccount(account, {
          now,
          preferredAccountId,
          modelKey,
          activeLeaseCount: (accountId, targetModel) => this.activeLeaseCountFrom(leaseIndex, accountId, targetModel),
          accountStats: { lastUsedAt: 0 },
          accountWeight: accountWeight(account, this.enterpriseProbe),
          modelQuotaFraction: this.provider.quotaFractionFor
            ? this.provider.quotaFractionFor(account, modelKey)
            : undefined,
        }),
      }))
      .sort((a, b) => {
        if (a.sameLevel !== b.sameLevel) return a.sameLevel ? -1 : 1;
        return b.remaining - a.remaining || a.score - b.score || a.account.id - b.account.id;
      })
      .map((entry) => entry.account);

    return displayAccount ? [displayAccount, ...ranked] : ranked;
  }

  private tighterRemainingFraction(account: TAccount, modelKey: string): number {
    const hourly = this.accountHourlyFraction(account, modelKey);
    const weekly = this.accountWeeklyFraction(account);
    const known = [hourly, weekly].filter((value): value is number => value !== null);
    if (!known.length) return 1;
    return Math.max(0, Math.min(1, Math.min(...known)));
  }

  private accountHourlyFraction(account: TAccount, modelKey: string): number | null {
    const providerValue = this.provider.quotaFractionFor
      ? this.provider.quotaFractionFor(account, modelKey)
      : undefined;
    const fraction = providerValue !== undefined
      ? providerValue
      : getModelQuotaFraction(account, modelKey, this.now());
    if (fraction === null || fraction < 0) return null;
    return Math.max(0, Math.min(1, fraction));
  }

  private accountWeeklyFraction(account: TAccount): number | null {
    const field = this.provider.id === "codex"
      ? "codexWeeklyPercent"
      : this.provider.id === "anthropic"
        ? "claudeWeeklyPercent"
        : "";
    if (!field) return null;
    const raw = Number((account as any)[field]);
    if (!Number.isFinite(raw) || raw < 0) return null;
    return Math.max(0, Math.min(1, raw > 1 ? raw / 100 : raw));
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
        exhaustedUntil: 0, consecutiveErrors: 0, transientErrors: 0, deathStrikes: 0,
        tokenDeathStrikes: 0, lastUsedAt: 0,
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
      // N 击确认:单次 invalid_grant 极可能瞬时(出口代理抖动 / OAuth 反滥用误判 /
      // family-reuse 误报)。前 N-1 次只软冷却(quotaStatus=exhausted、不落盘、可自动
      // 复检),给一次独立重试自愈的机会;攒满第 N 次(两击之间无刷新成功)才升级为
      // 持久化「已失效·鉴权失效」。任一次刷 token 成功即把 tokenDeathStrikes 清零。
      state.tokenDeathStrikes++;
      const now = this.now();
      if (state.tokenDeathStrikes >= TOKEN_DEATH_STRIKE_THRESHOLD) {
        state.quotaStatus = "error";
        state.quotaStatusReason = "invalid_grant";
        state.exhaustedUntil = now + TOKEN_REFRESH_FAILURE_COOLDOWN_MS;
        this.persistQuotaStatus(accountId, state);
      } else {
        state.quotaStatus = "exhausted";          // 黄、出池、可自动复检
        state.quotaStatusReason = "invalid_grant"; // 保留真因供遥测/复现
        state.exhaustedAt = now;
        state.exhaustedUntil = now + TOKEN_DEATH_FIRST_COOLDOWN_MS;
        // 故意不 persistQuotaStatus:软冷却态不跨重启,瞬时误判不留痕。
      }
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
    state.tokenDeathStrikes = 0;
    state.blockedModels.clear();
    this.clearPersistedAccountError(accountId);
    return { ok: true };
  }

  /**
   * After a manual token refresh proves the account's auth is alive again, clear
   * ONLY a persisted dead verdict (quotaStatus==="error": invalid_grant /
   * consecutive_errors / verification_required) and put it back in the pool —
   * sparing the operator a second "恢复" click after a successful "刷新".
   *
   * Also clears a PENDING invalid_grant soft strike (tokenDeathStrikes>0, still
   * quotaStatus=exhausted, not yet the persisted verdict): the refresh just proved
   * auth is alive, so the account shouldn't sit out its remaining soft cooldown.
   *
   * Deliberately a no-op for healthy accounts AND for merely quota-exhausted ones
   * (exhausted/cooling = "额度恢复中") with no auth strike pending: a fresh access_token
   * does not replenish the 5h/weekly quota, so reactivating would yank a still-throttled
   * account back into rotation and instantly re-rate-limit it. Only the auth-dead /
   * auth-strike state is something a token refresh can actually cure.
   */
  reactivateIfAuthDead(accountId: number): { ok: boolean; reactivated: boolean } {
    if (!Number.isFinite(accountId) || accountId <= 0) return { ok: false, reactivated: false };
    const runtime = this.accountRuntime.get(accountId);
    const runtimeDead = runtime?.quotaStatus === "error";
    const strikePending = (runtime?.tokenDeathStrikes ?? 0) > 0;
    const persistedDead =
      (this.readAccounts().find((a) => a.id === accountId) as any)?.quotaStatus === "error";
    if (!runtimeDead && !persistedDead && !strikePending) return { ok: true, reactivated: false };
    this.reactivateAccount(accountId);
    return { ok: true, reactivated: true };
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

  /**
   * 区分「上游瞬时限速 429」与「额度/信用耗尽 429」。前者(rate_limit_error /
   * too_many_requests)账号额度并未耗尽,几秒~一分钟即恢复,绝不能按额度耗尽冷却到
   * 配额窗口 reset(可达数小时)——否则绑定卡(无备号)会因一次瞬时限速被打死数小时。
   * 判据按可信度:reason 的明确限速/耗尽标志 > 账号 5h 额度余量(仍有明确余量 = 必是限速)。
   */
  private isRateLimit429(reason: string, accountId: number, modelKey: string, retryAfterMs = 0): boolean {
    const r = (reason || "").toLowerCase();
    if (/rate.?limit|too_many_requests/.test(r)) return true;
    if (/credit|exhaust|token limit|insufficient/.test(r)) return false;
    // reason 模糊:先信上游给的 retry-after 时长 —— 远超瞬时量级(>5min)= 配额窗口耗尽,
    // 绝非瞬时限速(瞬时限速以秒~分钟计)。比下面那份可能过时的额度快照可信得多。
    if (retryAfterMs > RATE_LIMIT_MAX_RETRY_AFTER_MS) return false;
    // 仍无强信号 → 退用账号 5h 额度余量快照兜底:仍有明确余量(fraction>0)= 瞬时限速。
    const account = this.readAccounts().find((a) => a.id === accountId);
    const fraction = account ? getModelQuotaFraction(account, modelKey, this.now()) : null;
    return fraction !== null && fraction > 0;
  }

  private markAccountExhausted(accountId: number, modelKey: string, reason: string, cooldownMs: number) {
    const state = this.ensureRuntime(accountId);
    const now = this.now();
    const normalized = normalizeModelKey(modelKey);
    // capacity(503)与瞬时限速(rate_limit)都是【可恢复的瞬时冷却】→ 标 cooling 而非 exhausted。
    const transient = reason.includes("capacity") || reason.includes("503") || reason.includes("rate_limit");
    const blockedUntil = now + cooldownMs;

    state.quotaStatus = transient ? "cooling" : "exhausted";
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

  /** 外部(cliproxy)上报某上游号的失败 → 套用与内部一致的标号逻辑(死号/限额/容量/瞬时)。
   *  移植自 main b998931「accept cliproxy account failure reports」。 */
  applyExternalAccountFailure(payload: {
    accountId: number;
    modelKey?: string;
    status: number;
    reason?: string;
    retryAfterMs?: number;
  }) {
    const accountId = Number(payload.accountId);
    const modelKey = String(payload.modelKey || "");
    const status = Number(payload.status || 0);
    const reason = String(payload.reason || "");
    const retryAfterMs = Number(payload.retryAfterMs || 0);
    if (!Number.isFinite(accountId) || accountId <= 0) {
      return { ok: false, error: "invalid accountId" };
    }

    if ((status === 400 || status === 401) && reason.includes("invalid_grant")) {
      const state = this.ensureRuntime(accountId);
      state.tokenDeathStrikes = Math.max(state.tokenDeathStrikes, TOKEN_DEATH_STRIKE_THRESHOLD - 1);
      this.markAccountTokenError(accountId, reason);
      this.flushAccounts();
      return { ok: true, action: "auth_dead" };
    }

    if (status === 429 || status === 503) {
      const classifiedReason = reason || (status === 429 ? "quota" : "capacity");
      const cooldownMs = this.cooldownForExhaustion(status, classifiedReason, retryAfterMs, accountId, modelKey);
      this.markAccountExhausted(accountId, modelKey, classifiedReason, cooldownMs);
      return { ok: true, action: status === 429 ? "model_quota" : "model_capacity" };
    }

    if (status === 401) {
      this.mutateAccount(accountId, (account) => ({
        ...(account as any),
        accessToken: "",
        accessTokenExpiresAt: 0,
      }) as TAccount);
      this.flushAccounts();
      return { ok: true, action: "token_cache_cleared" };
    }

    this.markAccountTransientError(accountId, modelKey, reason || `http_${status}`);
    return { ok: true, action: "transient_error" };
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
    state.tokenDeathStrikes = 0;
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
}
