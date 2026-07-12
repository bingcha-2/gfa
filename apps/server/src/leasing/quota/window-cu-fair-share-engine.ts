import { calculateFairShareCu, type FairShareUsageEvent } from "./fair-share-cu";
import {
  collapseWindowReorderTail,
  createQuotaWindows,
  createWindowState,
  getSubjectQuota,
  reduceQuotaWindows,
  type FairShareWindowState,
  type QuotaWindowsState,
  type SnapshotEvent,
  type WindowSubjectConfig,
} from "./fair-share-window";

const FIVE_HOURS = 5 * 60 * 60 * 1000;
const WEEK = 7 * 24 * 60 * 60 * 1000;
export const REORDER_GLOBAL_MAX_BYTES = 128 * 1024 * 1024;

export interface WindowCuEngineOptions {
  provider: "codex" | "anthropic";
  trackWeekly: boolean;
  now: () => number;
  getBoundCardWeights: (accountId: number) => Array<{ cardId: string; weight: number }>;
  getSeatCapacity: (accountId: number) => number;
  isExclusive: (cardId: string) => boolean;
  maxReorderBytes?: number;
}

type AccountingView = Pick<FairShareWindowState,
  "scope" | "windowMs" | "primed" | "windowStart" | "resetAt" | "fraction" | "lastSnapshotAt"
  | "assignedBurn" | "unattributedShare" | "subjects" | "revision"
>;

function view(state: FairShareWindowState): AccountingView {
  const {
    scope, windowMs, primed, windowStart, resetAt, fraction, lastSnapshotAt,
    assignedBurn, unattributedShare, subjects, revision,
  } = state;
  return {
    scope, windowMs, primed, windowStart, resetAt, fraction, lastSnapshotAt,
    assignedBurn, unattributedShare, subjects, revision,
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

  getCardFractions(accountId: number, quotaSubjectId: string, weekly: boolean): Record<string, { fraction: number; personalFraction: number; resetAt: number; share: number }> {
    const buckets = this.states.get(accountId);
    if (!buckets) return {};
    const result: Record<string, { fraction: number; personalFraction: number; resetAt: number; share: number }> = {};
    for (const bucket of buckets.keys()) {
      const windows = this.ensure(accountId, bucket);
      const state = weekly ? windows.weekly : windows.primary;
      if (!state.primed) continue;
      const quota = getSubjectQuota(state, quotaSubjectId);
      result[bucket] = {
        fraction: quota.fraction,
        personalFraction: quota.personalFraction,
        resetAt: state.resetAt,
        share: quota.share,
      };
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
    const weeklyLimitsAllowedRequest = this.options.trackWeekly
      && windows.weekly.primed
      && (!windows.primary.primed || weekly.fraction < primary.fraction);
    const selected = primaryBlocked
      ? windows.primary
      : weeklyBlocked || weeklyLimitsAllowedRequest ? windows.weekly : windows.primary;
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
    const state = this.states.get(accountId)?.has(bucket) ? this.ensure(accountId, bucket) : null;
    return state ? { primary: view(state.primary), weekly: view(state.weekly) } : null;
  }

  getReasons(accountId: number, bucket: string): { primary: string; weekly: string } | null {
    const state = this.states.get(accountId)?.get(bucket);
    return state ? { primary: state.primary.lastReason || "", weekly: state.weekly.lastReason || "" } : null;
  }

  entries(): Array<{ accountId: number; bucket: string; windows: QuotaWindowsState }> {
    const result: Array<{ accountId: number; bucket: string; windows: QuotaWindowsState }> = [];
    for (const [accountId, buckets] of this.states) {
      for (const bucket of buckets.keys()) result.push({ accountId, bucket, windows: this.ensure(accountId, bucket) });
    }
    return result;
  }

  entry(accountId: number, bucket: string): { accountId: number; bucket: string; windows: QuotaWindowsState } | null {
    const windows = this.states.get(accountId)?.has(bucket) ? this.ensure(accountId, bucket) : null;
    return windows ? { accountId, bucket, windows } : null;
  }

  accountIds(): number[] { return [...this.states.keys()]; }

  restore(accountId: number, bucket: string, windows: QuotaWindowsState): void {
    let buckets = this.states.get(accountId);
    if (!buckets) this.states.set(accountId, (buckets = new Map()));
    buckets.set(bucket, windows);
    this.ensure(accountId, bucket);
    this.enforceGlobalReorderBudget();
  }

  getReorderDiagnosticsForTesting(): {
    totalBytes: number;
    windows: Array<{ accountId: number; bucket: string; scope: "primary" | "weekly"; bytes: number; reason: string }>;
  } {
    const windows = this.reorderWindows();
    return {
      totalBytes: windows.reduce((sum, item) => sum + Math.max(0, item.window.reorderTailBytes - 2), 0),
      windows: windows.map((item) => ({
        accountId: item.accountId,
        bucket: item.bucket,
        scope: item.scope,
        bytes: Math.max(0, item.window.reorderTailBytes - 2),
        reason: item.window.lastReason || "",
      })),
    };
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
    state = this.expireElapsedWindows(accountId, state);
    buckets.set(bucket, state);
    return state;
  }

  /**
   * resetAt is the upstream authority for a window boundary. Once it is reached,
   * the old exhausted state must stop enforcing immediately, even if the first
   * post-reset snapshot has not arrived yet (including after process restart).
   * The two scopes are reset independently; the fresh scope remains unprimed so
   * its next real snapshot establishes the new baseline without inventing burn.
   */
  private expireElapsedWindows(accountId: number, state: QuotaWindowsState): QuotaWindowsState {
    const now = this.options.now();
    const subjects = this.subjects(accountId);
    const expire = (window: FairShareWindowState): FairShareWindowState => {
      if (!window.primed || window.resetAt <= 0 || now < window.resetAt) return window;
      return {
        ...createWindowState({ scope: window.scope, windowMs: window.windowMs, subjects }),
        revision: window.revision + 1,
        lastReason: "WINDOW_EXPIRED",
      };
    };
    const primary = expire(state.primary);
    const weekly = expire(state.weekly);
    return primary === state.primary && weekly === state.weekly ? state : { primary, weekly };
  }

  private set(accountId: number, bucket: string, state: QuotaWindowsState): void {
    this.states.get(accountId)?.set(bucket, state);
    this.enforceGlobalReorderBudget();
  }

  private reorderWindows(): Array<{
    accountId: number;
    bucket: string;
    scope: "primary" | "weekly";
    window: FairShareWindowState;
  }> {
    const result: Array<{
      accountId: number;
      bucket: string;
      scope: "primary" | "weekly";
      window: FairShareWindowState;
    }> = [];
    for (const [accountId, buckets] of this.states) {
      for (const [bucket, windows] of buckets) {
        result.push({ accountId, bucket, scope: "primary", window: windows.primary });
        result.push({ accountId, bucket, scope: "weekly", window: windows.weekly });
      }
    }
    return result;
  }

  private enforceGlobalReorderBudget(): void {
    const limit = Math.max(0, this.options.maxReorderBytes ?? REORDER_GLOBAL_MAX_BYTES);
    const candidates = this.reorderWindows();
    let total = candidates.reduce((sum, item) => sum + Math.max(0, item.window.reorderTailBytes - 2), 0);
    if (total <= limit) return;
    candidates.sort((a, b) => {
      const aAt = a.window.reorderTail[0]?.arrivedAt ?? Number.POSITIVE_INFINITY;
      const bAt = b.window.reorderTail[0]?.arrivedAt ?? Number.POSITIVE_INFINITY;
      return aAt - bAt;
    });
    for (const candidate of candidates) {
      if (total <= limit) break;
      if (candidate.window.reorderTail.length === 0) continue;
      const collapsed = collapseWindowReorderTail(candidate.window);
      const windows = this.states.get(candidate.accountId)?.get(candidate.bucket);
      if (!windows) continue;
      this.states.get(candidate.accountId)?.set(candidate.bucket, {
        ...windows,
        [candidate.scope]: collapsed,
      });
      total -= Math.max(0, candidate.window.reorderTailBytes - 2);
    }
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
