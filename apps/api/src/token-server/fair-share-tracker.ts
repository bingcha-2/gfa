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

// ── Weight constants (based on pricing ratios) ──────────────────────────────

export const QUOTA_WEIGHTS: Record<string, { input: number; output: number; cache: number }> = {
  gemini: { input: 1.0, output: 4.0, cache: 0.25 },
  opus:   { input: 1.0, output: 5.0, cache: 0.10 },
  codex:  { input: 1.0, output: 3.0, cache: 0.0 },
};

// ── Default budgets by planType (conservative, in weighted units) ────────────

const DEFAULT_BUDGETS: Record<string, Record<string, number>> = {
  ultra:    { gemini: 5_000_000, opus: 2_000_000, codex: 2_000_000 },
  premium:  { gemini: 250_000,   opus: 100_000,   codex: 100_000 },
  plus:     { gemini: 250_000,   opus: 100_000,   codex: 100_000 },
  pro:      { gemini: 250_000,   opus: 100_000,   codex: 100_000 },
  standard: { gemini: 100_000,   opus: 50_000,    codex: 50_000 },
  free:     { gemini: 50_000,    opus: 20_000,    codex: 20_000 },
};

const WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours

// ── Types ───────────────────────────────────────────────────────────────────

interface BucketTracker {
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
}

// ── Core class ──────────────────────────────────────────────────────────────

export class FairShareTracker {
  // accountId → bucket → tracker
  private readonly trackers = new Map<number, Map<string, BucketTracker>>();
  private readonly opts: FairShareTrackerOptions;

  constructor(opts: FairShareTrackerOptions) {
    this.opts = opts;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Calculate weighted token cost for a single request. */
  static weightedCost(
    bucket: string,
    inputTokens: number,
    outputTokens: number,
    cachedInputTokens: number,
  ): number {
    const w = QUOTA_WEIGHTS[bucket] || QUOTA_WEIGHTS.gemini;
    return inputTokens * w.input + outputTokens * w.output + cachedInputTokens * w.cache;
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
    this.ensureWindow(tracker, Date.now());
    const cost = FairShareTracker.weightedCost(bucket, inputTokens, outputTokens, cachedInputTokens);
    tracker.perCard.set(cardId, (tracker.perCard.get(cardId) || 0) + cost);
  }

  /** Update budget estimate from a quota fraction signal. Called from scheduler/report. */
  updateBudgetEstimate(accountId: number, bucket: string, fraction: number): void {
    const tracker = this.getOrCreate(accountId, bucket);
    this.ensureWindow(tracker, Date.now());
    const totalUsed = this.totalWeighted(tracker);
    const consumed = 1.0 - fraction;

    if (consumed > 0.05 && totalUsed > 0) {
      const estimated = totalUsed / consumed;
      // Only adjust upward (avoid fraction jitter shrinking the budget),
      // unless we're still on the default and first real estimate arrives.
      if (estimated > tracker.estimatedBudget || tracker.confidence === 'default') {
        tracker.estimatedBudget = estimated;
        tracker.confidence = 'estimated';
      }
    }
    tracker.lastFraction = fraction;
  }

  /** Confirm budget at 429 — the most accurate signal. */
  confirmBudget(accountId: number, bucket: string): void {
    const tracker = this.getOrCreate(accountId, bucket);
    const totalUsed = this.totalWeighted(tracker);
    if (totalUsed > 0) {
      tracker.estimatedBudget = totalUsed;
      tracker.confidence = 'confirmed';
    }
  }

  /** Check if a card is within its fair share. Called before granting a lease. */
  checkFairShare(accountId: number, cardId: string, bucket: string): FairShareCheck {
    const tracker = this.trackers.get(accountId)?.get(bucket);
    if (!tracker) {
      return { allowed: true, remainingFraction: 1.0 };
    }
    this.ensureWindow(tracker, Date.now());

    const weight = this.opts.getCardWeight(cardId);
    const capacity = this.opts.accountShareCapacity;
    const perCardBudget = tracker.estimatedBudget * (weight / capacity);
    const myUsage = tracker.perCard.get(cardId) || 0;
    const remaining = Math.max(0, perCardBudget - myUsage);
    const remainingFraction = perCardBudget > 0 ? remaining / perCardBudget : 1;

    if (myUsage >= perCardBudget) {
      return {
        allowed: false,
        reason: `公平限额已用完 (已用 ${formatTokens(myUsage)}/${formatTokens(perCardBudget)} 加权单元)`,
        remainingFraction: 0,
      };
    }
    return { allowed: true, remainingFraction };
  }

  /**
   * Get per-card remaining fractions for all buckets on a given account+card.
   * Used to populate the lease response so the client can show accurate blood bars.
   * Returns: { gemini: 0.75, opus: 0.3, codex: 1.0 } or {} if no tracking.
   */
  getCardQuotaFractions(accountId: number, cardId: string): Record<string, { fraction: number; resetAt: number }> {
    const bucketTrackers = this.trackers.get(accountId);
    if (!bucketTrackers) return {};

    const now = Date.now();
    const weight = this.opts.getCardWeight(cardId);
    const capacity = this.opts.accountShareCapacity;
    const out: Record<string, { fraction: number; resetAt: number }> = {};

    for (const [bucket, tracker] of bucketTrackers) {
      this.ensureWindow(tracker, now);
      const perCardBudget = tracker.estimatedBudget * (weight / capacity);
      const myUsage = tracker.perCard.get(cardId) || 0;
      const remaining = Math.max(0, perCardBudget - myUsage);
      const fraction = perCardBudget > 0 ? remaining / perCardBudget : 1;
      // Reset at = window start + 5h
      const resetAt = tracker.windowStart + WINDOW_MS;
      out[bucket] = { fraction, resetAt };
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
      const defaults = DEFAULT_BUDGETS[planType] || DEFAULT_BUDGETS.free;
      tracker = {
        windowStart: Date.now(),
        estimatedBudget: defaults[bucket] || defaults.gemini || 50_000,
        confidence: 'default',
        perCard: new Map(),
        lastFraction: 1.0,
      };
      bucketMap.set(bucket, tracker);
    }
    return tracker;
  }

  private ensureWindow(tracker: BucketTracker, now: number): void {
    if (now - tracker.windowStart >= WINDOW_MS) {
      tracker.windowStart = now;
      tracker.perCard.clear();
      // Retain estimated budget across windows, but downgrade confidence
      if (tracker.confidence === 'confirmed') {
        tracker.confidence = 'estimated';
      }
    }
  }

  private totalWeighted(tracker: BucketTracker): number {
    let total = 0;
    for (const v of tracker.perCard.values()) total += v;
    return total;
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(Math.round(n));
}
