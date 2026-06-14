/**
 * fair-share-tracker.ts — Dynamic fair-share quota for bound cards.
 *
 * When N cards are bound to the same upstream account, each card gets
 * 1/N of the account's estimated total budget (in weighted token units).
 *
 * Weighted tokens account for the different cost ratios of input/output/cache:
 *   weightedCost = input × W_input + output × W_output + cache × W_cache
 *
 * Budget estimation:
 *   - Starts with a conservative default per planType
 *   - Refined by quota fraction signals: estimated = totalUsed / (1 - fraction)
 *   - Confirmed by 429: estimatedBudget = totalUsed at trigger time
 */

import { QUOTA_WEIGHTS } from "@gfa/shared";

import { bucketFamily, claudeModelTier, quotaWeightFor } from "../lease-core/product-bucket";
import { DEFAULT_WEEKLY_RATIO, clampWeeklyRatio } from "../lease-core/quota-profile-tracker";

// quotaWeightFor 已迁至 product-bucket(供 token-billing 的静态封顶复用,避免
// token-billing ↔ fair-share 循环依赖)。此处 re-export 兼容既有引用点。
export { quotaWeightFor };

// ── Weight constants (derived from the shared pricing source) ───────────────

// 键 = 模型家族(与 product-bucket.ts 的 Family / modelFamily 对齐:gemini/claude/gpt)。
// 注意:真实桶名是「产品-家族」复合(如 anthropic-claude),查表前要先 bucketFamily() 取家族。
// 权重派生自 @gfa/shared 的单一定价源(pricing.json),改价只改那里。
export { QUOTA_WEIGHTS };

// ── Default budgets by planType (conservative, in weighted units) ────────────

// 外层键 = planType(没有统一命名,三条线各抄各上游,这里按线分组覆盖全部真实取值);
// 内层键 = 模型家族 gemini/claude/gpt(与桶的家族部分对齐,查表前先 bucketFamily() 取家族)。
// 命中失败回落 free,所以漏一个高配档会把企业号当免费号限流。各值只是「首个 5h 窗口」的初始
// 估计(加权 token),之后被上游 fraction 反推 + 429 实测覆盖,不必纠结精确。
//   antigravity(Google paidTier)    : ultra / premium / standard / free
//   codex(ChatGPT plan_type)        : pro / plus / team / enterprise / business / free
//   anthropic(Claude org_type 映射) : max / pro / team / enterprise / ""(未知→free)
const DEFAULT_BUDGETS: Record<string, Record<string, number>> = {
  // —— 顶配档 ——
  ultra:      { gemini: 5_000_000, claude: 2_000_000, gpt: 2_000_000 }, // antigravity
  max:        { gemini: 2_000_000, claude: 2_000_000, gpt: 2_000_000 }, // claude
  enterprise: { gemini: 2_000_000, claude: 2_000_000, gpt: 2_000_000 }, // codex / claude
  team:       { gemini:   500_000, claude:   300_000, gpt:   300_000 }, // codex / claude
  business:   { gemini:   500_000, claude:   300_000, gpt:   300_000 }, // codex
  // —— 中档 ——
  premium:    { gemini:   250_000, claude:   100_000, gpt:   100_000 }, // antigravity
  pro:        { gemini:   250_000, claude:   100_000, gpt:   100_000 }, // codex / claude
  plus:       { gemini:   250_000, claude:   100_000, gpt:   100_000 }, // codex
  standard:   { gemini:   100_000, claude:    50_000, gpt:    50_000 }, // antigravity
  // —— 兜底(含 claude 空串/未知) ——
  free:       { gemini:    50_000, claude:    20_000, gpt:    20_000 },
};

const WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours(短窗口/5h)
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days(长窗口/周)
/** 周默认预算 = 5h 默认预算 × 该系数(冷启动初值,之后被学到的 weekly 预算 / weeklyPercent
 *  反推 / 周 429 实测覆盖)。系数 = 全局默认 R(env BCAI_WEEKLY_RATIO_DEFAULT,默认 5)。 */
const WEEKLY_BUDGET_MULTIPLIER = DEFAULT_WEEKLY_RATIO;
/** 周窗口在内存/持久化里用「桶名 + 该后缀」作为独立 key,复用同一套 tracker 逻辑与 DB 列
 *  (无需加库表字段)。后缀编码 scope,load 时据此还原窗口长度。 */
const WEEKLY_SUFFIX = "::weekly";

/** 某桶对应的周窗口 key。 */
export function weeklyBucketKey(bucket: string): string {
  return `${bucket}${WEEKLY_SUFFIX}`;
}
/** 该 key 是否是周窗口(用于求和/血条时排除,避免与 5h 双算)。 */
export function isWeeklyBucketKey(bucket: string): boolean {
  return bucket.endsWith(WEEKLY_SUFFIX);
}
/** 去掉周后缀,取回基础桶名(用于 family/learned-budget 查表)。 */
function baseBucketOf(bucket: string): string {
  return isWeeklyBucketKey(bucket) ? bucket.slice(0, -WEEKLY_SUFFIX.length) : bucket;
}

/** Periodic batch-write interval for FairShareWindow persistence (ms). */
const FLUSH_INTERVAL_MS = 30_000;

// ── Types ───────────────────────────────────────────────────────────────────

interface BucketTracker {
  /** 本 tracker 的窗口长度(5h 或 7d)。由 key 是否带周后缀决定。 */
  windowMs: number;
  windowStart: number;
  estimatedBudget: number;
  confidence: 'default' | 'estimated' | 'confirmed';
  perCard: Map<string, number>; // cardId → weighted tokens used
  lastFraction: number;
}

export interface FairShareCheck {
  allowed: boolean;
  reason?: string;
  /** Per-card remaining fraction (0~1) for blood bar display. */
  remainingFraction?: number;
  window?: "5h" | "7d";
  bucket?: string;
  resetAt?: number;
  resetMs?: number;
  retryAfterMs?: number;
}

export interface FairShareTrackerOptions {
  /** Resolve planType for an account id. */
  getAccountPlanType: (accountId: number) => string;
  /** Resolve all active card ids bound to an account in a given provider pool. */
  getBoundCardIds: (accountId: number) => string[];
  /** Resolve a card's share weight (1..capacity). */
  getCardWeight: (cardId: string) => number;
  /** Total share capacity per upstream account (4 or 8). */
  accountShareCapacity: number;
  /** Optional: retrieve a learned budget from QuotaProfileTracker.
   *  Returns the learned 5h budget in weighted units, or 0 if unknown. */
  getLearnedBudget?: (planType: string, bucket: string) => number;
  /** Optional: learned **weekly** budget(加权单元),0 = 未知。仅有周窗口的线启用。 */
  getLearnedWeeklyBudget?: (planType: string, bucket: string) => number;
  getWeeklyRatio?: (planType: string, family: string) => number;
  /** 是否启用「周公平份额」第二层窗口。codex/anthropic 上游有 5h+周双限额 → true;
   *  antigravity 仅 5h(每模型)→ false(默认)。关闭时行为与历史完全一致。 */
  trackWeekly?: boolean;
  /** PrismaService for FairShareWindow persistence. Omit to disable persistence. */
  prisma?: any;
  /** Provider id (antigravity | codex | anthropic) — partitions persisted rows. */
  provider?: string;
  /** Injectable clock (defaults to Date.now). Keeps windows test-deterministic. */
  now?: () => number;
}

// ── Core class ──────────────────────────────────────────────────────────────

export class FairShareTracker {
  // accountId → bucket → tracker
  private readonly trackers = new Map<number, Map<string, BucketTracker>>();
  private readonly opts: FairShareTrackerOptions;
  private readonly prisma: any;
  private readonly providerId: string;
  private readonly nowFn: () => number;
  private readonly trackWeekly: boolean;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;

  constructor(opts: FairShareTrackerOptions) {
    this.opts = opts;
    this.prisma = opts.prisma ?? null;
    this.providerId = opts.provider || "";
    this.nowFn = opts.now || Date.now;
    this.trackWeekly = opts.trackWeekly === true;
    if (this.prisma && this.providerId) {
      this.flushTimer = setInterval(() => {
        void this.flush();
      }, FLUSH_INTERVAL_MS);
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Calculate weighted token cost for a single request. `modelOrBucket` 优先传真实
   *  modelKey(按 Claude 档位精确计价);兼容传 bucket(旧调用,gemini/gpt 不变、
   *  Claude 桶名落 Opus)。详见 quotaWeightFor。 */
  static weightedCost(
    modelOrBucket: string,
    inputTokens: number,
    outputTokens: number,
    cachedInputTokens: number,
  ): number {
    const w = quotaWeightFor(modelOrBucket);
    // inputTokens 为 gross(含 cached,经 normalizeUsageToGross 归一)。取 netInput 去掉
    // 缓存部分,避免缓存被 input 权重 + cache 权重双算(Gemini 之前 1.25x)。
    const netInput = Math.max(0, inputTokens - cachedInputTokens);
    return netInput * w.input + outputTokens * w.output + cachedInputTokens * w.cache;
  }

  /** Record usage from a completed request. Called from reportResult. */
  recordUsage(
    accountId: number,
    cardId: string,
    bucket: string,
    inputTokens: number,
    outputTokens: number,
    cachedInputTokens: number,
    modelKey?: string,
  ): void {
    // 自动补全(tab_* / flash_lite)不消耗额度:直接不计入任何窗口。
    if (modelKey && claudeModelTier(modelKey) === "autocomplete") return;
    // 桶名仍是 tracker 的 key(同账号 Claude 共享一个预算/窗口);权重则按真实 modelKey
    // 取档位单价。未传 modelKey 时退回 bucket(向后兼容,与历史行为一致)。
    const cost = FairShareTracker.weightedCost(modelKey || bucket, inputTokens, outputTokens, cachedInputTokens);
    if (cost <= 0) return;
    const now = this.nowFn();
    // 记入 5h 窗口;若启用周窗口,同一笔成本也累计到周窗口(独立 key、独立预算/reset)。
    const keys = this.trackWeekly ? [bucket, weeklyBucketKey(bucket)] : [bucket];
    for (const key of keys) {
      const tracker = this.getOrCreate(accountId, key);
      this.ensureWindow(tracker, now);
      tracker.perCard.set(cardId, (tracker.perCard.get(cardId) || 0) + cost);
    }
    this.dirty = true;
  }

  /**
   * Synchronize the internal window to the upstream resetTime.
   * Instead of self-timing a 5h window, we align to Google/Codex/Anthropic's
   * actual window boundary so totalUsed accurately reflects the real window.
   *
   * @param resetTimeMs  Epoch ms of the upstream window reset.
   */
  syncWindow(accountId: number, bucket: string, resetTimeMs: number): void {
    const tracker = this.getOrCreate(accountId, bucket);
    const windowStart = resetTimeMs - tracker.windowMs;
    // Only reset if the window start actually changed (> 60s drift tolerance)
    if (Math.abs(windowStart - tracker.windowStart) > 60_000) {
      tracker.windowStart = windowStart;
      tracker.perCard.clear();
      if (tracker.confidence === 'confirmed') {
        tracker.confidence = 'estimated';
      }
      this.dirty = true;
    }
  }

  /**
   * Expose internal tracker state for quota profile sampling.
   * Called by LeaseService on 429 to feed QuotaProfileTracker.
   */
  getTrackerState(accountId: number, bucket: string): {
    totalUsed: number;
    lastFraction: number;
    confidence: string;
  } | null {
    const tracker = this.trackers.get(accountId)?.get(bucket);
    if (!tracker) return null;
    return {
      totalUsed: this.totalWeighted(tracker),
      lastFraction: tracker.lastFraction,
      confidence: tracker.confidence,
    };
  }

  /** Update budget estimate from a quota fraction signal. Called from scheduler/report. */
  updateBudgetEstimate(accountId: number, bucket: string, fraction: number): void {
    const tracker = this.getOrCreate(accountId, bucket);
    this.ensureWindow(tracker, this.nowFn());
    const totalUsed = this.totalWeighted(tracker);
    const consumed = 1.0 - fraction;
    const floor = this.estimatedBudgetForKey(accountId, bucket, tracker);

    if (consumed > 0.05 && totalUsed > 0) {
      const estimated = totalUsed / consumed;
      const bounded = isWeeklyBucketKey(bucket) ? Math.max(estimated, floor) : estimated;
      // Only adjust upward (avoid fraction jitter shrinking the budget),
      // unless we're still on the default and first real estimate arrives.
      if (bounded > tracker.estimatedBudget || tracker.confidence === 'default') {
        tracker.estimatedBudget = bounded;
        tracker.confidence = 'estimated';
      }
    } else if (fraction >= 0.90 && totalUsed > 0) {
      // Upstream still reports "full" (e.g. Google's 20% granularity hasn't
      // budged). We don't know the real budget yet, but it's clearly larger
      // than our default — grow the floor conservatively (5× totalUsed).
      // Do NOT upgrade confidence: we have no real signal, so checkFairShare
      // should remain lenient.
      const widened = Math.max(totalUsed * 5, isWeeklyBucketKey(bucket) ? floor : 0);
      if (widened > tracker.estimatedBudget) {
        tracker.estimatedBudget = widened;
      }
    }
    tracker.lastFraction = fraction;
    this.dirty = true;
  }

  /** Confirm budget at 429 — the most accurate signal. */
  confirmBudget(accountId: number, bucket: string): void {
    const tracker = this.getOrCreate(accountId, bucket);
    const totalUsed = this.totalWeighted(tracker);
    if (totalUsed > 0) {
      tracker.estimatedBudget = isWeeklyBucketKey(bucket)
        ? Math.max(totalUsed, this.estimatedBudgetForKey(accountId, bucket, tracker))
        : totalUsed;
      tracker.confidence = 'confirmed';
      this.dirty = true;
    }
  }

  /** Check if a card is within its fair share. Called before granting a lease.
   *  同时校验 5h 与周(若启用)两个窗口,任一超额即拦;remainingFraction 取两者较小。 */
  checkFairShare(accountId: number, cardId: string, bucket: string): FairShareCheck {
    const short = this.checkWindow(accountId, cardId, bucket);
    if (!this.trackWeekly) return short;
    const weekly = this.checkWindow(accountId, cardId, weeklyBucketKey(bucket));
    const blocking = !short.allowed ? short : !weekly.allowed ? weekly : null;
    if (blocking) {
      return {
        allowed: false,
        reason: blocking.reason,
        remainingFraction: 0,
        window: blocking.window,
        bucket: blocking.bucket,
        resetAt: blocking.resetAt,
        resetMs: blocking.resetMs,
        retryAfterMs: blocking.retryAfterMs,
      };
    }
    const chosen = (short.remainingFraction ?? 1) <= (weekly.remainingFraction ?? 1) ? short : weekly;
    return {
      allowed: true,
      remainingFraction: Math.min(short.remainingFraction ?? 1, weekly.remainingFraction ?? 1),
      window: chosen.window,
      bucket: chosen.bucket,
      resetAt: chosen.resetAt,
      resetMs: chosen.resetMs,
    };
  }

  /** 单个窗口(5h 或周)的公平份额判定。 */
  private checkWindow(accountId: number, cardId: string, key: string): FairShareCheck {
    const tracker = this.trackers.get(accountId)?.get(key);
    const window = isWeeklyBucketKey(key) ? "7d" : "5h";
    const bucket = baseBucketOf(key);
    if (!tracker) {
      return { allowed: true, remainingFraction: 1.0, window, bucket };
    }
    this.ensureWindow(tracker, this.nowFn());
    const now = this.nowFn();
    const resetAt = tracker.windowStart + tracker.windowMs;
    const resetMs = Math.max(0, resetAt - now);

    // When upstream reports ≥90% remaining, we have no reliable budget estimate.
    // Allow the lease unconditionally — real protection comes from the upstream
    // 429 response. Blocking based on a guess would prematurely cut off cards
    // while Google's coarse 20% granularity hasn't even budged.
    if (tracker.lastFraction >= 0.90) {
      return {
        allowed: true,
        remainingFraction: tracker.lastFraction,
        window,
        bucket,
        resetAt,
        resetMs,
        retryAfterMs: resetMs,
      };
    }

    const weight = this.opts.getCardWeight(cardId);
    const capacity = this.opts.accountShareCapacity;
    const perCardBudget = this.estimatedBudgetForKey(accountId, key, tracker) * (weight / capacity);
    const myUsage = tracker.perCard.get(cardId) || 0;
    const remaining = Math.max(0, perCardBudget - myUsage);
    const remainingFraction = perCardBudget > 0 ? remaining / perCardBudget : 1;

    if (myUsage >= perCardBudget) {
      const label = isWeeklyBucketKey(key) ? "本周公平限额" : "公平限额";
      return {
        allowed: false,
        reason: `${label}已用完 (已用 ${formatTokens(myUsage)}/${formatTokens(perCardBudget)} 加权单元)`,
        remainingFraction: 0,
        window,
        bucket,
        resetAt,
        resetMs,
        retryAfterMs: resetMs,
      };
    }
    return { allowed: true, remainingFraction, window, bucket, resetAt, resetMs, retryAfterMs: resetMs };
  }

  // ── 周窗口的喂数据 / 确认(仅 trackWeekly 时生效;内部复用同名 5h 方法 + 周 key)──
  /** 用上游 weeklyPercent(剩余 fraction)反推周预算。 */
  updateWeeklyBudgetEstimate(accountId: number, bucket: string, fraction: number): void {
    if (!this.trackWeekly) return;
    this.updateBudgetEstimate(accountId, weeklyBucketKey(bucket), fraction);
  }
  /** 对齐上游周 reset 边界。 */
  syncWeeklyWindow(accountId: number, bucket: string, resetTimeMs: number): void {
    if (!this.trackWeekly) return;
    this.syncWindow(accountId, weeklyBucketKey(bucket), resetTimeMs);
  }
  /** 撞到「周」429 时,把周预算钉到当前周已用(最准信号)。 */
  confirmWeeklyBudget(accountId: number, bucket: string): void {
    if (!this.trackWeekly) return;
    this.confirmBudget(accountId, weeklyBucketKey(bucket));
  }

  /**
   * Get per-card remaining fractions for all buckets on a given account+card.
   * Used to populate the lease response so the client can show accurate blood bars.
   * Returns: { gemini: 0.75, opus: 0.3, codex: 1.0 } or {} if no tracking.
   */
  getCardQuotaFractions(accountId: number, cardId: string): Record<string, { fraction: number; resetAt: number }> {
    const bucketTrackers = this.trackers.get(accountId);
    if (!bucketTrackers) return {};

    const now = this.nowFn();
    const weight = this.opts.getCardWeight(cardId);
    const capacity = this.opts.accountShareCapacity;
    const out: Record<string, { fraction: number; resetAt: number }> = {};

    for (const [bucket, tracker] of bucketTrackers) {
      if (isWeeklyBucketKey(bucket)) continue; // 血条只展示 5h 窗口(周窗口内部计,不混入)
      this.ensureWindow(tracker, now);
      const resetAt = tracker.windowStart + tracker.windowMs;

      // When upstream reports ≥90% remaining, we don't know the real budget.
      // Show the upstream fraction directly so the blood bar stays full
      // instead of draining based on a guess.
      if (tracker.lastFraction >= 0.90) {
        out[bucket] = { fraction: tracker.lastFraction, resetAt };
        continue;
      }

      // Real signal available — calculate per-card fair share fraction.
      const perCardBudget = tracker.estimatedBudget * (weight / capacity);
      const myUsage = tracker.perCard.get(cardId) || 0;
      const remaining = Math.max(0, perCardBudget - myUsage);
      const fraction = perCardBudget > 0 ? remaining / perCardBudget : 1;
      out[bucket] = { fraction, resetAt };
    }

    return out;
  }

  /**
   * 周窗口的每卡剩余 fraction(供「周血条」)。键用去掉 `::weekly` 后缀的基础桶名,与 5h 对齐,
   * 客户端按同一 bucket 同时拿到 5h 与周两条。仅 trackWeekly(codex/anthropic)时有数据。
   */
  getCardWeeklyQuotaFractions(accountId: number, cardId: string): Record<string, { fraction: number; resetAt: number }> {
    if (!this.trackWeekly) return {};
    const bucketTrackers = this.trackers.get(accountId);
    if (!bucketTrackers) return {};

    const now = this.nowFn();
    const weight = this.opts.getCardWeight(cardId);
    const capacity = this.opts.accountShareCapacity;
    const out: Record<string, { fraction: number; resetAt: number }> = {};

    for (const [key, tracker] of bucketTrackers) {
      if (!isWeeklyBucketKey(key)) continue; // 只取周窗口
      this.ensureWindow(tracker, now);
      const baseBucket = baseBucketOf(key);
      const resetAt = tracker.windowStart + tracker.windowMs;
      if (tracker.lastFraction >= 0.90) {
        out[baseBucket] = { fraction: tracker.lastFraction, resetAt };
        continue;
      }
      const perCardBudget = tracker.estimatedBudget * (weight / capacity);
      const myUsage = tracker.perCard.get(cardId) || 0;
      const remaining = Math.max(0, perCardBudget - myUsage);
      const fraction = perCardBudget > 0 ? remaining / perCardBudget : 1;
      out[baseBucket] = { fraction, resetAt };
    }

    return out;
  }

  /** 是否启用周窗口(codex/anthropic=true)。供 lease 响应决定是否下发「周血条」。 */
  isWeeklyTracked(): boolean {
    return this.trackWeekly;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private estimatedBudgetForKey(accountId: number, bucket: string, tracker?: BucketTracker): number {
    if (!isWeeklyBucketKey(bucket)) {
      return tracker?.estimatedBudget ?? 0;
    }
    const baseBucket = baseBucketOf(bucket);
    const planType = (this.opts.getAccountPlanType(accountId) || "free").toLowerCase();
    const floor = this.estimatedWeeklyFloor(accountId, baseBucket, planType);
    return Math.max(tracker?.estimatedBudget || 0, floor);
  }

  private estimatedWeeklyFloor(accountId: number, baseBucket: string, planType: string): number {
    const defaults = DEFAULT_BUDGETS[planType] || DEFAULT_BUDGETS.free;
    const family = bucketFamily(baseBucket);
    const default5h = defaults[family] || defaults.gemini || 50_000;
    const learned5h = this.opts.getLearnedBudget?.(planType, baseBucket) || 0;
    const current5h = this.trackers.get(accountId)?.get(baseBucket)?.estimatedBudget || 0;
    const ratio = clampWeeklyRatio(this.opts.getWeeklyRatio?.(planType, family) ?? WEEKLY_BUDGET_MULTIPLIER);
    const floor5h = Math.max(default5h, learned5h, current5h);
    return floor5h * ratio;
  }

  private getOrCreate(accountId: number, bucket: string): BucketTracker {
    let bucketMap = this.trackers.get(accountId);
    if (!bucketMap) {
      bucketMap = new Map();
      this.trackers.set(accountId, bucketMap);
    }
    let tracker = bucketMap.get(bucket);
    if (!tracker) {
      const isWeekly = isWeeklyBucketKey(bucket);
      const baseBucket = baseBucketOf(bucket);
      const planType = (this.opts.getAccountPlanType(accountId) || 'free').toLowerCase();
      const family = bucketFamily(baseBucket);
      const defaults = DEFAULT_BUDGETS[planType] || DEFAULT_BUDGETS.free;
      const base5h = defaults[family] || defaults.gemini || 50_000;
      // Prefer learned budget from QuotaProfileTracker over hardcoded defaults.
      const learned = isWeekly
        ? this.opts.getLearnedWeeklyBudget?.(planType, baseBucket) || 0
        : this.opts.getLearnedBudget?.(planType, baseBucket) || 0;
      const defaultBudget = isWeekly ? this.estimatedWeeklyFloor(accountId, baseBucket, planType) : base5h;
      tracker = {
        windowMs: isWeekly ? WEEKLY_WINDOW_MS : WINDOW_MS,
        windowStart: this.nowFn(),
        estimatedBudget: isWeekly ? Math.max(learned, defaultBudget) : (learned > 0 ? learned : defaultBudget),
        confidence: learned > 0 ? 'estimated' : 'default',
        perCard: new Map(),
        lastFraction: 1.0,
      };
      bucketMap.set(bucket, tracker);
    }
    return tracker;
  }

  private ensureWindow(tracker: BucketTracker, now: number): void {
    if (now - tracker.windowStart >= tracker.windowMs) {
      tracker.windowStart = now;
      tracker.perCard.clear();
      // Retain estimated budget across windows, but downgrade confidence
      if (tracker.confidence === 'confirmed') {
        tracker.confidence = 'estimated';
      }
      this.dirty = true;
    }
  }

  private totalWeighted(tracker: BucketTracker): number {
    let total = 0;
    for (const v of tracker.perCard.values()) total += v;
    return total;
  }

  // ── Persistence (FairShareWindow) ─────────────────────────────────────────

  /**
   * Restore persisted per-card usage into memory. Call once at startup.
   * Windows whose 5h boundary has already passed keep their learned budget
   * (downgraded confirmed→estimated) but drop stale per-card usage — the
   * upstream window has reset, so "remaining" starts fresh.
   */
  async load(): Promise<void> {
    if (!this.prisma || !this.providerId) return;
    let rows: any[];
    try {
      rows = await this.prisma.fairShareWindow.findMany({ where: { provider: this.providerId } });
    } catch (err) {
      console.error("[fair-share-tracker] load failed:", err);
      return;
    }
    const now = this.nowFn();
    const groups = new Map<string, any[]>();
    for (const r of rows) {
      const key = `${r.accountId} ${r.bucket}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(r);
    }
    for (const groupRows of groups.values()) {
      const first = groupRows[0];
      const accountId = Number(first.accountId);
      const bucket = String(first.bucket);
      // 窗口长度由 key 的周后缀决定(持久化不存 windowMs,用后缀编码 scope)。
      const windowMs = isWeeklyBucketKey(bucket) ? WEEKLY_WINDOW_MS : WINDOW_MS;
      const windowStart = Number(first.windowStart);
      const expired = now - windowStart >= windowMs;
      let confidence = (String(first.confidence) as BucketTracker["confidence"]) || "default";
      if (expired && confidence === "confirmed") confidence = "estimated";
      const perCard = new Map<string, number>();
      if (!expired) {
        for (const r of groupRows) perCard.set(String(r.cardId), Number(r.weightedUsed) || 0);
      }
      let bucketMap = this.trackers.get(accountId);
      if (!bucketMap) this.trackers.set(accountId, (bucketMap = new Map()));
      bucketMap.set(bucket, {
        windowMs,
        windowStart: expired ? now : windowStart,
        estimatedBudget: Number(first.estimatedBudget) || 0,
        confidence,
        perCard,
        lastFraction: expired ? 1.0 : (Number(first.lastFraction) || 0),
      });
    }
  }

  /**
   * Persist current in-memory state. Replaces all of this provider's rows in
   * one transaction (no stale rows survive a window rollover). Dirty-gated so
   * idle accounts don't churn the DB. Runs on a timer and on shutdown.
   */
  async flush(): Promise<void> {
    if (!this.prisma || !this.providerId || !this.dirty) return;
    this.dirty = false;
    const rows = this.serializeRows();
    try {
      await this.prisma.$transaction([
        this.prisma.fairShareWindow.deleteMany({ where: { provider: this.providerId } }),
        ...(rows.length ? [this.prisma.fairShareWindow.createMany({ data: rows })] : []),
      ]);
    } catch (err) {
      console.error("[fair-share-tracker] flush failed:", err);
      this.dirty = true; // retry on the next tick
    }
  }

  /** Stop the periodic flush timer. */
  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** 一张卡本 5h 窗口的加权已用(跨该账号所有 bucket 求和,实测)。 */
  getCardWindowUsed(accountId: number, cardId: string): number {
    const bucketMap = this.trackers.get(accountId);
    if (!bucketMap) return 0;
    const now = this.nowFn();
    let total = 0;
    for (const [key, tracker] of bucketMap) {
      if (isWeeklyBucketKey(key)) continue; // 仅 5h 窗口求和,避免与周窗口双算
      this.ensureWindow(tracker, now);
      total += tracker.perCard.get(cardId) || 0;
    }
    return total;
  }

  /** Snapshot one bucket's tracker state. Test-only. */
  getBucketStateForTesting(accountId: number, bucket: string): {
    windowStart: number;
    estimatedBudget: number;
    confidence: string;
    lastFraction: number;
    totalUsed: number;
    perCard: Record<string, number>;
  } | null {
    const tracker = this.trackers.get(accountId)?.get(bucket);
    if (!tracker) return null;
    return {
      windowStart: tracker.windowStart,
      estimatedBudget: tracker.estimatedBudget,
      confidence: tracker.confidence,
      lastFraction: tracker.lastFraction,
      totalUsed: this.totalWeighted(tracker),
      perCard: Object.fromEntries(tracker.perCard),
    };
  }

  private serializeRows(): Array<{
    provider: string;
    accountId: number;
    bucket: string;
    cardId: string;
    windowStart: bigint;
    weightedUsed: number;
    estimatedBudget: number;
    confidence: string;
    lastFraction: number;
  }> {
    const rows: ReturnType<FairShareTracker["serializeRows"]> = [];
    for (const [accountId, bucketMap] of this.trackers) {
      for (const [bucket, tracker] of bucketMap) {
        for (const [cardId, weightedUsed] of tracker.perCard) {
          rows.push({
            provider: this.providerId,
            accountId,
            bucket,
            cardId,
            windowStart: BigInt(Math.trunc(tracker.windowStart)),
            weightedUsed,
            estimatedBudget: tracker.estimatedBudget,
            confidence: tracker.confidence,
            lastFraction: tracker.lastFraction,
          });
        }
      }
    }
    return rows;
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(Math.round(n));
}
