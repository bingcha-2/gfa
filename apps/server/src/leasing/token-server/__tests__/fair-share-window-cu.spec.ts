import { afterEach, describe, expect, it } from "vitest";
import { FairShareTracker } from "../fair-share-tracker";

const T = 1_800_000_000_000;
const FIVE_HOURS = 5 * 60 * 60 * 1000;
const WEEK = 7 * 24 * 60 * 60 * 1000;
const BUCKET = "codex-gpt";

type Bound = Record<number, Array<{ cardId: string; weight: number }>>;

function tracker(bound: Bound, nowRef: { value: number }, exclusive = new Set<string>()) {
  return new FairShareTracker({
    algorithm: "window-cu-v1",
    provider: "codex",
    trackWeekly: true,
    now: () => nowRef.value,
    getCardWeight: (id) => Object.values(bound).flat().find((item) => item.cardId === id)?.weight || 1,
    getBoundCardWeights: (accountId) => bound[accountId] || [],
    getSeatCapacity: () => 2,
    isExclusive: (id) => exclusive.has(id),
  });
}

const trackers: FairShareTracker[] = [];
afterEach(() => {
  while (trackers.length) trackers.pop()?.destroy();
});

function tracked(value: FairShareTracker) {
  trackers.push(value);
  return value;
}

function applyBaseline(value: FairShareTracker) {
  value.applyAccountQuotaSnapshotAt(1, BUCKET, { fraction: 1, resetAt: T + FIVE_HOURS, observedAt: T, snapshotId: "p0" });
  value.applyWeeklyAccountQuotaSnapshotAt(1, BUCKET, { fraction: 1, resetAt: T + WEEK, observedAt: T, snapshotId: "w0" });
}

describe("FairShareTracker window-cu-v1 facade", () => {
  it("reconciles snapshot-before-report through the public tracker API", () => {
    const bound = { 1: [{ cardId: "A", weight: 1 }, { cardId: "B", weight: 1 }] };
    const now1 = { value: T };
    const reportFirst = tracked(tracker(bound, now1));
    applyBaseline(reportFirst);
    reportFirst.recordUsageEvent(1, BUCKET, {
      reportId: "rA", provider: "codex", accountId: 1, quotaSubjectId: "A", modelId: "gpt-5.6-luna",
      inputTokens: 1_000_000, cachedInputTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0,
      outputTokens: 0, serviceTier: "standard", requestStartedAt: T + 5,
      upstreamCompletedAt: T + 10, arrivedAt: T + 10,
    });
    reportFirst.applyAccountQuotaSnapshotAt(1, BUCKET, { fraction: 0.9, resetAt: T + FIVE_HOURS, observedAt: T + 20, snapshotId: "p1" });

    const now2 = { value: T };
    const snapshotFirst = tracked(tracker(bound, now2));
    applyBaseline(snapshotFirst);
    snapshotFirst.applyAccountQuotaSnapshotAt(1, BUCKET, { fraction: 0.9, resetAt: T + FIVE_HOURS, observedAt: T + 20, snapshotId: "p1" });
    snapshotFirst.recordUsageEvent(1, BUCKET, {
      reportId: "rA", provider: "codex", accountId: 1, quotaSubjectId: "A", modelId: "gpt-5.6-luna",
      inputTokens: 1_000_000, cachedInputTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0,
      outputTokens: 0, serviceTier: "standard", requestStartedAt: T + 5,
      upstreamCompletedAt: T + 10, arrivedAt: T + 30,
    });

    expect(snapshotFirst.getWindowStateForTesting(1, BUCKET)).toEqual(reportFirst.getWindowStateForTesting(1, BUCKET));
    expect(snapshotFirst.getCardQuotaFractions(1, "A")[BUCKET].fraction).toBeLessThan(1);
  });

  it("keeps primary and weekly display values separate", () => {
    const now = { value: T };
    const value = tracked(tracker({ 1: [{ cardId: "A", weight: 1 }, { cardId: "B", weight: 1 }] }, now));
    applyBaseline(value);
    value.recordUsage(1, "A", BUCKET, 1_000_000, 0, 0, "gpt-5.6-luna");
    value.applyAccountQuotaSnapshotAt(1, BUCKET, { fraction: 0.8, resetAt: T + FIVE_HOURS, observedAt: T + 20, snapshotId: "p1" });
    value.applyWeeklyAccountQuotaSnapshotAt(1, BUCKET, { fraction: 0.95, resetAt: T + WEEK, observedAt: T + 20, snapshotId: "w1" });

    expect(value.getCardQuotaFractions(1, "A")[BUCKET].fraction)
      .not.toBe(value.getCardWeeklyQuotaFractions(1, "A")[BUCKET].fraction);
  });

  it("never exposes more pooled absolute quota than the mother account", () => {
    const now = { value: T };
    const value = tracked(tracker({ 1: [{ cardId: "A", weight: 1 }, { cardId: "B", weight: 1 }] }, now));
    applyBaseline(value);
    value.applyAccountQuotaSnapshotAt(1, BUCKET, { fraction: 0.2, resetAt: T + FIVE_HOURS, observedAt: T + 20, snapshotId: "p1" });
    const a = value.getCardQuotaFractions(1, "A")[BUCKET];
    const b = value.getCardQuotaFractions(1, "B")[BUCKET];
    expect(a.fraction * a.share + b.fraction * b.share).toBeCloseTo(0.2, 12);
  });

  it("expires primary independently at resetAt and never keeps an exhausted card blocked", () => {
    const now = { value: T };
    const value = tracked(tracker({ 1: [{ cardId: "A", weight: 1 }, { cardId: "B", weight: 1 }] }, now));
    applyBaseline(value);
    value.applyAccountQuotaSnapshotAt(1, BUCKET, {
      fraction: 0, resetAt: T + FIVE_HOURS, observedAt: T + 20, snapshotId: "p-empty",
    });
    value.applyWeeklyAccountQuotaSnapshotAt(1, BUCKET, {
      fraction: 0.7, resetAt: T + WEEK, observedAt: T + 20, snapshotId: "w-live",
    });
    expect(value.checkFairShare(1, "A", BUCKET).allowed).toBe(false);

    now.value = T + FIVE_HOURS;
    expect(value.checkFairShare(1, "A", BUCKET)).toMatchObject({
      allowed: true,
      remainingFraction: 0.7,
    });
    const state = value.getWindowStateForTesting(1, BUCKET)!;
    expect(state.primary.primed).toBe(false);
    expect(value.getWindowReasons(1, BUCKET)?.primary).toBe("WINDOW_EXPIRED");
    expect(state.weekly.primed).toBe(true);
    expect(state.weekly.fraction).toBe(0.7);
  });

  it("falls back to pool scaling when an exclusive account has multiple active subjects", () => {
    const now = { value: T };
    const value = tracked(tracker(
      { 1: [{ cardId: "A", weight: 1 }, { cardId: "B", weight: 1 }] },
      now,
      new Set(["A", "B"]),
    ));
    applyBaseline(value);
    value.applyAccountQuotaSnapshotAt(1, BUCKET, { fraction: 0.1, resetAt: T + FIVE_HOURS, observedAt: T + 20, snapshotId: "p1" });
    const a = value.getCardQuotaFractions(1, "A")[BUCKET];
    const b = value.getCardQuotaFractions(1, "B")[BUCKET];
    expect(a.fraction * a.share + b.fraction * b.share).toBeCloseTo(0.1, 12);
  });

  it("still caps a sole exclusive card at the mother account remainder", () => {
    const now = { value: T };
    const value = tracked(tracker(
      { 1: [{ cardId: "A", weight: 2 }] },
      now,
      new Set(["A"]),
    ));
    value.applyAccountQuotaSnapshotAt(1, BUCKET, {
      fraction: 0.2, resetAt: T + FIVE_HOURS, observedAt: T, snapshotId: "exclusive-low",
    });
    const a = value.getCardQuotaFractions(1, "A")[BUCKET];
    expect(a.fraction * a.share).toBeCloseTo(0.2, 12);
  });

  it("refreshes membership without erasing stable subject accounting", () => {
    const now = { value: T };
    const bound: Bound = { 1: [{ cardId: "A", weight: 1 }] };
    const value = tracked(tracker(bound, now));
    applyBaseline(value);
    value.recordUsage(1, "A", BUCKET, 1_000_000, 0, 0, "gpt-5.6-luna");
    value.applyAccountQuotaSnapshotAt(1, BUCKET, { fraction: 0.9, resetAt: T + FIVE_HOURS, observedAt: T + 20, snapshotId: "p1" });
    const before = value.getWindowStateForTesting(1, BUCKET)!.primary.subjects.A;
    bound[1] = [{ cardId: "A", weight: 1 }, { cardId: "B", weight: 1 }];
    now.value = T + 21;
    value.refreshParticipants(1);
    const after = value.getWindowStateForTesting(1, BUCKET)!.primary.subjects.A;
    expect(after.cumulativeCu).toBe(before.cumulativeCu);
    expect(after.attributedShare).toBe(before.attributedShare);
  });
});
