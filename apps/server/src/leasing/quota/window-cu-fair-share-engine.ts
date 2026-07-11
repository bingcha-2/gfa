import { calculateFairShareCu, type FairShareUsageEvent } from "./fair-share-cu";
import {
  createQuotaWindows,
  getSubjectQuota,
  reduceQuotaWindows,
  type FairShareWindowState,
  type QuotaWindowsState,
  type SnapshotEvent,
  type WindowSubjectConfig,
} from "./fair-share-window";

const FIVE_HOURS = 5 * 60 * 60 * 1000;
const WEEK = 7 * 24 * 60 * 60 * 1000;

export interface WindowCuEngineOptions {
  provider: "codex" | "anthropic";
  trackWeekly: boolean;
  now: () => number;
  getBoundCardWeights: (accountId: number) => Array<{ cardId: string; weight: number }>;
  getSeatCapacity: (accountId: number) => number;
  isExclusive: (cardId: string) => boolean;
}

type AccountingView = Pick<FairShareWindowState,
  "scope" | "windowMs" | "primed" | "windowStart" | "resetAt" | "fraction" | "lastSnapshotAt"
  | "assignedBurn" | "unattributedShare" | "subjects" | "lastReason"
>;

function view(state: FairShareWindowState): AccountingView {
  const {
    scope, windowMs, primed, windowStart, resetAt, fraction, lastSnapshotAt,
    assignedBurn, unattributedShare, subjects, lastReason,
  } = state;
  return {
    scope, windowMs, primed, windowStart, resetAt, fraction, lastSnapshotAt,
    assignedBurn, unattributedShare, subjects, lastReason,
  };
}

export class WindowCuFairShareEngine {
  private readonly states = new Map<number, Map<string, QuotaWindowsState>>();
  private sequence = 0;

  constructor(private readonly options: WindowCuEngineOptions) {}

  recordUsage(accountId: number, bucket: string, event: FairShareUsageEvent): void {
    const calculated = calculateFairShareCu(event);
    if (calculated.cu <= 0) return;
    const state = this.ensure(accountId, bucket);
    this.set(accountId, bucket, reduceQuotaWindows(state, {
      scope: "both",
      event: {
        kind: "usage",
        reportId: event.reportId,
        quotaSubjectId: event.quotaSubjectId,
        cu: calculated.cu,
        upstreamCompletedAt: event.upstreamCompletedAt,
        arrivedAt: event.arrivedAt,
      },
    }));
  }

  recordLegacyUsage(
    accountId: number,
    quotaSubjectId: string,
    bucket: string,
    inputTokens: number,
    outputTokens: number,
    cachedInputTokens: number,
    modelId: string,
    fast: boolean,
  ): void {
    const now = this.options.now();
    this.recordUsage(accountId, bucket, {
      reportId: `legacy-${accountId}-${quotaSubjectId}-${now}-${++this.sequence}`,
      provider: this.options.provider,
      accountId,
      quotaSubjectId,
      modelId,
      inputTokens: Math.max(0, inputTokens - cachedInputTokens),
      cachedInputTokens,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens,
      serviceTier: fast ? "fast" : "standard",
      requestStartedAt: now,
      upstreamCompletedAt: now,
      arrivedAt: now,
    });
  }

  applySnapshot(accountId: number, bucket: string, scope: "primary" | "weekly", event: Omit<SnapshotEvent, "kind" | "arrivedAt"> & { arrivedAt?: number }): void {
    if (scope === "weekly" && !this.options.trackWeekly) return;
    const state = this.ensure(accountId, bucket);
    this.set(accountId, bucket, reduceQuotaWindows(state, {
      scope,
      event: { kind: "snapshot", arrivedAt: event.arrivedAt ?? this.options.now(), ...event },
    }));
  }

  refreshMembership(accountId: number): void {
    const buckets = this.states.get(accountId);
    if (!buckets) return;
    const now = this.options.now();
    const subjects = this.subjects(accountId);
    for (const [bucket, state] of buckets) {
      this.set(accountId, bucket, reduceQuotaWindows(state, {
        scope: "both",
        event: {
          kind: "membership",
          membershipId: `membership-${accountId}-${now}-${++this.sequence}`,
          subjects,
          occurredAt: now,
          arrivedAt: now,
        },
      }));
    }
  }

  getCardFractions(accountId: number, quotaSubjectId: string, weekly: boolean): Record<string, { fraction: number; resetAt: number; share: number }> {
    const buckets = this.states.get(accountId);
    if (!buckets) return {};
    const result: Record<string, { fraction: number; resetAt: number; share: number }> = {};
    for (const [bucket, windows] of buckets) {
      const state = weekly ? windows.weekly : windows.primary;
      if (!state.primed) continue;
      const quota = getSubjectQuota(state, quotaSubjectId);
      result[bucket] = { fraction: quota.fraction, resetAt: state.resetAt, share: quota.share };
    }
    return result;
  }

  check(accountId: number, quotaSubjectId: string, bucket: string): {
    allowed: boolean;
    reason?: string;
    remainingFraction: number;
    window: "5h" | "7d";
    bucket: string;
    resetAt: number;
    resetMs: number;
    retryAfterMs?: number;
  } {
    const windows = this.ensure(accountId, bucket);
    const now = this.options.now();
    const primary = getSubjectQuota(windows.primary, quotaSubjectId);
    const weekly = getSubjectQuota(windows.weekly, quotaSubjectId);
    const primaryBlocked = windows.primary.primed && primary.fraction <= 0;
    const weeklyBlocked = this.options.trackWeekly && windows.weekly.primed && weekly.fraction <= 0;
    const selected = primaryBlocked || !weeklyBlocked ? windows.primary : windows.weekly;
    const window = selected.scope === "primary" ? "5h" : "7d";
    const fraction = primaryBlocked || weeklyBlocked
      ? 0
      : this.options.trackWeekly ? Math.min(primary.fraction, weekly.fraction) : primary.fraction;
    return {
      allowed: !primaryBlocked && !weeklyBlocked,
      reason: primaryBlocked ? "primary_exhausted" : weeklyBlocked ? "weekly_exhausted" : undefined,
      remainingFraction: fraction,
      window,
      bucket,
      resetAt: selected.resetAt,
      resetMs: Math.max(0, selected.resetAt - now),
      retryAfterMs: primaryBlocked || weeklyBlocked ? Math.max(0, selected.resetAt - now) : undefined,
    };
  }

  getStateForTesting(accountId: number, bucket: string): { primary: AccountingView; weekly: AccountingView } | null {
    const state = this.states.get(accountId)?.get(bucket);
    return state ? { primary: view(state.primary), weekly: view(state.weekly) } : null;
  }

  entries(): Array<{ accountId: number; bucket: string; windows: QuotaWindowsState }> {
    const result: Array<{ accountId: number; bucket: string; windows: QuotaWindowsState }> = [];
    for (const [accountId, buckets] of this.states) {
      for (const [bucket, windows] of buckets) result.push({ accountId, bucket, windows });
    }
    return result;
  }

  entry(accountId: number, bucket: string): { accountId: number; bucket: string; windows: QuotaWindowsState } | null {
    const windows = this.states.get(accountId)?.get(bucket);
    return windows ? { accountId, bucket, windows } : null;
  }

  restore(accountId: number, bucket: string, windows: QuotaWindowsState): void {
    let buckets = this.states.get(accountId);
    if (!buckets) this.states.set(accountId, (buckets = new Map()));
    buckets.set(bucket, windows);
  }

  private ensure(accountId: number, bucket: string): QuotaWindowsState {
    let buckets = this.states.get(accountId);
    if (!buckets) this.states.set(accountId, (buckets = new Map()));
    let state = buckets.get(bucket);
    if (!state) {
      state = createQuotaWindows({
        subjects: this.subjects(accountId),
        primaryWindowMs: FIVE_HOURS,
        weeklyWindowMs: WEEK,
      });
      buckets.set(bucket, state);
    }
    return state;
  }

  private set(accountId: number, bucket: string, state: QuotaWindowsState): void {
    this.states.get(accountId)?.set(bucket, state);
  }

  private subjects(accountId: number): WindowSubjectConfig[] {
    const bound = this.options.getBoundCardWeights(accountId);
    const sum = bound.reduce((total, subject) => total + Math.max(0, subject.weight), 0);
    const denominator = Math.max(1, this.options.getSeatCapacity(accountId), sum);
    return bound.map((subject) => ({
      quotaSubjectId: subject.cardId,
      share: Math.max(0, subject.weight) / denominator,
      exclusive: this.options.isExclusive(subject.cardId),
    }));
  }
}
