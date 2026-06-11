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
 *
 * Dual window (5h + 周):御三家(Anthropic/Codex)是「5h + 周」双限。每个 bucket 同时
 * 跟踪 fast(5h)与 slow(7d)两个窗口,同一笔成本同时计入两者,但各自按上游 reset
 * 独立重置。判定/份额取两窗更紧的一个(后续循环接入)。
 */

import { QUOTA_WEIGHTS, type Family } from "@gfa/shared";

import { bucketFamily } from "../lease-core/product-bucket";

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

type WindowKind = "fast" | "slow";

// 各窗口长度。fast = 5h(御三家共有),slow = 7d(Anthropic/Codex 的周限)。
const WINDOW_MS: Record<WindowKind, number> = {
  fast: 5 * 60 * 60 * 1000,
  slow: 7 * 24 * 60 * 60 * 1000,
};

// 拦截/血条文案用的窗口名。
const WINDOW_LABEL: Record<WindowKind, string> = { fast: "5h", slow: "周" };

/** Periodic batch-write interval for FairShareWindow persistence (ms). */
const FLUSH_INTERVAL_MS = 30_000;

// ── Types ───────────────────────────────────────────────────────────────────

/** 单个窗口(fast 或 slow)的状态。两窗结构对称,各自独立累计与重置。 */
interface WindowState {
  windowStart: number;
  estimatedBudget: number;
  confidence: 'default' | 'estimated' | 'confirmed';
  perCard: Map<string, number>; // cardId → weighted tokens used
  lastFraction: number;
}

interface BucketTracker {
  windows: Record<WindowKind, WindowState>;
}

export interface FairShareCheck {
  allowed: boolean;
  reason?: string;
  /** Per-card remaining fraction (0~1) for blood bar display. */
  remainingFraction?: number;
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
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;

  constructor(opts: FairShareTrackerOptions) {
    this.opts = opts;
    this.prisma = opts.prisma ?? null;
    this.providerId = opts.provider || "";
    this.nowFn = opts.now || Date.now;
    if (this.prisma && this.providerId) {
      this.flushTimer = setInterval(() => {
        void this.flush();
      }, FLUSH_INTERVAL_MS);
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Calculate weighted token cost for a single request. */
  static weightedCost(
    bucket: string,
    inputTokens: number,
    outputTokens: number,
    cachedInputTokens: number,
  ): number {
    const w = QUOTA_WEIGHTS[bucketFamily(bucket) as Family] || QUOTA_WEIGHTS.gemini;
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
  ): void {
    const tracker = this.getOrCreate(accountId, bucket);
    const now = this.nowFn();
    const cost = FairShareTracker.weightedCost(bucket, inputTokens, outputTokens, cachedInputTokens);
    // 同一笔成本同时计入 5h 与周两个窗口(消耗 5h 额度也消耗周额度)。
    for (const kind of ["fast", "slow"] as WindowKind[]) {
      const w = tracker.windows[kind];
      this.ensureWindow(w, now, kind);
      w.perCard.set(cardId, (w.perCard.get(cardId) || 0) + cost);
    }
    this.dirty = true;
  }

  /**
   * Synchronize a window to the upstream resetTime.
   * Instead of self-timing the window, we align to Google/Codex/Anthropic's
   * actual window boundary so totalUsed accurately reflects the real window.
   *
   * @param resetTimeMs  Epoch ms of the upstream window reset.
   * @param kind         Which window to align (defaults to fast/5h).
   */
  syncWindow(accountId: number, bucket: string, resetTimeMs: number, kind: WindowKind = "fast"): void {
    const tracker = this.getOrCreate(accountId, bucket);
    const w = tracker.windows[kind];
    const windowStart = resetTimeMs - WINDOW_MS[kind];
    // Only reset if the window start actually changed (> 60s drift tolerance)
    if (Math.abs(windowStart - w.windowStart) > 60_000) {
      w.windowStart = windowStart;
      w.perCard.clear();
      if (w.confidence === 'confirmed') {
        w.confidence = 'estimated';
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
    const w = tracker.windows.fast;
    return {
      totalUsed: this.totalWeighted(w),
      lastFraction: w.lastFraction,
      confidence: w.confidence,
    };
  }

  /** Update budget estimate from a quota fraction signal. Called from scheduler/report. */
  updateBudgetEstimate(accountId: number, bucket: string, fraction: number, kind: WindowKind = "fast"): void {
    const tracker = this.getOrCreate(accountId, bucket);
    const w = tracker.windows[kind];
    this.ensureWindow(w, this.nowFn(), kind);
    const totalUsed = this.totalWeighted(w);
    const consumed = 1.0 - fraction;

    if (consumed > 0.05 && totalUsed > 0) {
      const estimated = totalUsed / consumed;
      // Only adjust upward (avoid fraction jitter shrinking the budget),
      // unless we're still on the default and first real estimate arrives.
      if (estimated > w.estimatedBudget || w.confidence === 'default') {
        w.estimatedBudget = estimated;
        w.confidence = 'estimated';
      }
    } else if (fraction >= 0.90 && totalUsed > 0) {
      // Upstream still reports "full" (e.g. Google's 20% granularity hasn't
      // budged). We don't know the real budget yet, but it's clearly larger
      // than our default — grow the floor conservatively (5× totalUsed).
      // Do NOT upgrade confidence: we have no real signal, so checkFairShare
      // should remain lenient.
      const floor = totalUsed * 5;
      if (floor > w.estimatedBudget) {
        w.estimatedBudget = floor;
      }
    }
    w.lastFraction = fraction;
    this.dirty = true;
  }

  /** Confirm budget at 429 — the most accurate signal. */
  confirmBudget(accountId: number, bucket: string): void {
    const tracker = this.getOrCreate(accountId, bucket);
    const w = tracker.windows.fast;
    const totalUsed = this.totalWeighted(w);
    if (totalUsed > 0) {
      w.estimatedBudget = totalUsed;
      w.confidence = 'confirmed';
      this.dirty = true;
    }
  }

  /**
   * Check if a card is within its fair share. Called before granting a lease.
   * Evaluates every present window (5h + 周) and takes the tightest one (min):
   * a card may sit inside its 5h share yet have exhausted the account's weekly
   * cap — then the weekly window must block.
   */
  checkFairShare(accountId: number, cardId: string, bucket: string): FairShareCheck {
    const tracker = this.trackers.get(accountId)?.get(bucket);
    if (!tracker) {
      return { allowed: true, remainingFraction: 1.0 };
    }
    const now = this.nowFn();
    const weight = this.opts.getCardWeight(cardId);
    const capacity = this.opts.accountShareCapacity;

    let remainingFraction = 1;
    for (const kind of ["fast", "slow"] as WindowKind[]) {
      const w = tracker.windows[kind];
      this.ensureWindow(w, now, kind);
      const f = this.windowRemainingFraction(w, cardId, weight, capacity);
      if (f <= 0) {
        return { allowed: false, reason: `公平限额(${WINDOW_LABEL[kind]})用完`, remainingFraction: 0 };
      }
      if (f < remainingFraction) remainingFraction = f;
    }
    return { allowed: true, remainingFraction };
  }

  /**
   * One window's per-card remaining fraction (0~1).
   * ≥90% upstream remaining → no reliable budget yet, hand back the upstream
   * fraction (lenient; real protection is the upstream 429). Below that, use the
   * weighted-token budget subtraction.
   */
  private windowRemainingFraction(w: WindowState, cardId: string, weight: number, capacity: number): number {
    if (w.lastFraction >= 0.90) return w.lastFraction;
    const perCardBudget = w.estimatedBudget * (weight / capacity);
    if (perCardBudget <= 0) return 1;
    const myUsage = w.perCard.get(cardId) || 0;
    if (myUsage >= perCardBudget) return 0;
    return (perCardBudget - myUsage) / perCardBudget;
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
      // Each present window contributes a fraction; the blood bar shows the
      // tightest one (min) and its resetAt — so the user sees the real binding
      // constraint (5h vs 周) and when it recovers.
      let minFraction = Infinity;
      let resetAt = now;
      for (const kind of ["fast", "slow"] as WindowKind[]) {
        const w = tracker.windows[kind];
        this.ensureWindow(w, now, kind);
        const f = this.windowRemainingFraction(w, cardId, weight, capacity);
        if (f < minFraction) {
          minFraction = f;
          resetAt = w.windowStart + WINDOW_MS[kind];
        }
      }
      out[bucket] = { fraction: minFraction === Infinity ? 1 : minFraction, resetAt };
    }

    return out;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private getOrCreate(accountId: number, bucket: string): BucketTracker {
    let bucketMap = this.trackers.get(accountId);
    if (!bucketMap) {
      bucketMap = new Map();
      this.trackers.set(accountId, bucketMap);
    }
    let tracker = bucketMap.get(bucket);
    if (!tracker) {
      const planType = (this.opts.getAccountPlanType(accountId) || 'free').toLowerCase();
      const family = bucketFamily(bucket);
      // Prefer learned budget from QuotaProfileTracker over hardcoded defaults
      const learned = this.opts.getLearnedBudget?.(planType, bucket) || 0;
      const defaults = DEFAULT_BUDGETS[planType] || DEFAULT_BUDGETS.free;
      const defaultBudget = defaults[family] || defaults.gemini || 50_000;
      const makeWindow = (): WindowState => ({
        windowStart: this.nowFn(),
        estimatedBudget: learned > 0 ? learned : defaultBudget,
        confidence: learned > 0 ? 'estimated' : 'default',
        perCard: new Map(),
        lastFraction: 1.0,
      });
      tracker = { windows: { fast: makeWindow(), slow: makeWindow() } };
      bucketMap.set(bucket, tracker);
    }
    return tracker;
  }

  /** Roll a window forward if its boundary has passed: clear usage, downgrade confidence. */
  private ensureWindow(w: WindowState, now: number, kind: WindowKind): void {
    if (now - w.windowStart >= WINDOW_MS[kind]) {
      w.windowStart = now;
      w.perCard.clear();
      // Retain estimated budget across windows, but downgrade confidence
      if (w.confidence === 'confirmed') {
        w.confidence = 'estimated';
      }
      this.dirty = true;
    }
  }

  private totalWeighted(w: WindowState): number {
    let total = 0;
    for (const v of w.perCard.values()) total += v;
    return total;
  }

  // ── Persistence (FairShareWindow) ─────────────────────────────────────────

  /**
   * Restore persisted per-card usage into memory. Call once at startup.
   * Windows whose 5h boundary has already passed keep their learned budget
   * (downgraded confirmed→estimated) but drop stale per-card usage — the
   * upstream window has reset, so "remaining" starts fresh.
   *
   * NOTE: only the fast(5h) window is persisted today; slow(周) is rebuilt
   * from live reports until its persistence lands in a later step.
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
      const key = `${r.accountId} ${r.bucket}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(r);
    }
    for (const groupRows of groups.values()) {
      const first = groupRows[0];
      const accountId = Number(first.accountId);
      const bucket = String(first.bucket);
      const windowStart = Number(first.windowStart);
      const expired = now - windowStart >= WINDOW_MS.fast;
      let confidence = (String(first.confidence) as WindowState["confidence"]) || "default";
      if (expired && confidence === "confirmed") confidence = "estimated";
      const perCard = new Map<string, number>();
      if (!expired) {
        for (const r of groupRows) perCard.set(String(r.cardId), Number(r.weightedUsed) || 0);
      }
      const estimatedBudget = Number(first.estimatedBudget) || 0;
      const fast: WindowState = {
        windowStart: expired ? now : windowStart,
        estimatedBudget,
        confidence,
        perCard,
        lastFraction: expired ? 1.0 : (Number(first.lastFraction) || 0),
      };
      // 周窗口持久化在后续循环补;当前从空累计起步。
      const slow: WindowState = {
        windowStart: now,
        estimatedBudget,
        confidence: 'default',
        perCard: new Map(),
        lastFraction: 1.0,
      };
      let bucketMap = this.trackers.get(accountId);
      if (!bucketMap) this.trackers.set(accountId, (bucketMap = new Map()));
      bucketMap.set(bucket, { windows: { fast, slow } });
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
    for (const tracker of bucketMap.values()) {
      const w = tracker.windows.fast;
      this.ensureWindow(w, now, "fast");
      total += w.perCard.get(cardId) || 0;
    }
    return total;
  }

  /** Snapshot one bucket's window state. Test-only. */
  getBucketStateForTesting(accountId: number, bucket: string, windowKind: WindowKind = "fast"): {
    windowStart: number;
    estimatedBudget: number;
    confidence: string;
    lastFraction: number;
    totalUsed: number;
    perCard: Record<string, number>;
  } | null {
    const tracker = this.trackers.get(accountId)?.get(bucket);
    if (!tracker) return null;
    const w = tracker.windows[windowKind];
    return {
      windowStart: w.windowStart,
      estimatedBudget: w.estimatedBudget,
      confidence: w.confidence,
      lastFraction: w.lastFraction,
      totalUsed: this.totalWeighted(w),
      perCard: Object.fromEntries(w.perCard),
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
        const w = tracker.windows.fast;
        for (const [cardId, weightedUsed] of w.perCard) {
          rows.push({
            provider: this.providerId,
            accountId,
            bucket,
            cardId,
            windowStart: BigInt(Math.trunc(w.windowStart)),
            weightedUsed,
            estimatedBudget: w.estimatedBudget,
            confidence: w.confidence,
            lastFraction: w.lastFraction,
          });
        }
      }
    }
    return rows;
  }
}
