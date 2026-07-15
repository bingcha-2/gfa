import { describe, expect, it } from "vitest";
import {
  createCarriedWindowState,
  createQuotaWindows,
  createWindowState,
  getSubjectQuota,
  REORDER_MAX_BYTES,
  REORDER_MAX_EVENTS,
  reduceQuotaWindows,
  reduceWindow,
  type MembershipEvent,
  type SnapshotEvent,
  type UsageCuEvent,
} from "./fair-share-window";

const T = 1_800_000_000_000;
const FIVE_HOURS = 5 * 60 * 60 * 1000;
const WEEK = 7 * 24 * 60 * 60 * 1000;
const subjects = [
  { quotaSubjectId: "A", share: 0.5 },
  { quotaSubjectId: "B", share: 0.5 },
];

function snapshot(observedAt: number, fraction: number, fields: Partial<SnapshotEvent> = {}): SnapshotEvent {
  return {
    kind: "snapshot",
    snapshotId: `s-${observedAt}-${fraction}`,
    fraction,
    observedAt,
    arrivedAt: observedAt,
    resetAt: T + FIVE_HOURS,
    ...fields,
  };
}

function usage(subject: string, completedAt: number, arrivedAt = completedAt, cu = 100): UsageCuEvent {
  return {
    kind: "usage",
    reportId: `r-${subject}-${completedAt}`,
    quotaSubjectId: subject,
    cu,
    upstreamCompletedAt: completedAt,
    arrivedAt,
  };
}

function primed() {
  return reduceWindow(
    createWindowState({ scope: "primary", windowMs: FIVE_HOURS, subjects }),
    snapshot(T, 1),
  );
}

describe("causal current-window reducer", () => {
  it("keeps the agreed 10,000-event / 1 MiB in-memory reorder budget", () => {
    expect(REORDER_MAX_EVENTS).toBe(10_000);
    expect(REORDER_MAX_BYTES).toBe(1024 * 1024);
  });

  it("preserves legacy attribution at cutover without inventing CU", () => {
    const state = createCarriedWindowState({
      scope: "primary",
      windowMs: FIVE_HOURS,
      windowStart: T,
      fraction: 0.6,
      subjects: [
        { ...subjects[0], active: true, carriedAttributedShare: 0.3 },
        { ...subjects[1], active: true, carriedAttributedShare: 0.1 },
      ],
    });

    expect(state.subjects.A.cumulativeCu).toBe(0);
    expect(state.subjects.A.carriedAttributedShare).toBeCloseTo(0.3, 12);
    expect(state.subjects.A.attributedShare).toBe(0);
    expect(state.unattributedShare).toBe(0);
    expect(getSubjectQuota(state, "A").fraction).toBeCloseTo(0.4, 12);
    expect(getSubjectQuota(state, "B").fraction).toBeCloseTo(0.8, 12);
  });

  it("normalizes corrupt legacy attribution to the confirmed mother burn", () => {
    const state = createCarriedWindowState({
      scope: "primary",
      windowMs: FIVE_HOURS,
      windowStart: T,
      fraction: 0.8,
      subjects: [
        { ...subjects[0], active: true, carriedAttributedShare: 0.3 },
        { ...subjects[1], active: true, carriedAttributedShare: 0.1 },
      ],
    });

    expect(state.subjects.A.carriedAttributedShare).toBeCloseTo(0.15, 12);
    expect(state.subjects.B.carriedAttributedShare).toBeCloseTo(0.05, 12);
    expect(state.unattributedShare).toBe(0);
  });

  it("does not make a newcomer inherit carried attribution", () => {
    let state = createCarriedWindowState({
      scope: "primary",
      windowMs: FIVE_HOURS,
      windowStart: T,
      fraction: 0.6,
      subjects: [{ ...subjects[0], active: true, carriedAttributedShare: 0.4 }],
    });
    state = reduceWindow(state, {
      kind: "membership",
      membershipId: "join-B-after-cutover",
      subjects,
      occurredAt: T + 1,
      arrivedAt: T + 1,
    });
    state = reduceWindow(state, usage("B", T + 10));
    state = reduceWindow(state, snapshot(T + 20, 0.5));

    expect(state.subjects.A.carriedAttributedShare).toBeCloseTo(0.4, 12);
    expect(state.subjects.A.attributedShare).toBe(0);
    expect(state.subjects.B.carriedAttributedShare).toBe(0);
    expect(state.subjects.B.attributedShare).toBeCloseTo(0.1, 12);
  });

  it("refunds carry, post-cutover attribution, and unknown burn proportionally then clears all on reset", () => {
    let state = createCarriedWindowState({
      scope: "primary",
      windowMs: FIVE_HOURS,
      windowStart: T,
      fraction: 0.5,
      subjects: [
        { ...subjects[0], active: true, carriedAttributedShare: 0.3 },
        { ...subjects[1], active: true, carriedAttributedShare: 0.1 },
      ],
    });
    expect(state.unattributedShare).toBeCloseTo(0.1, 12);
    state = reduceWindow(state, usage("B", T + 10));
    state = reduceWindow(state, snapshot(T + 20, 0.4));
    state = reduceWindow(state, snapshot(T + 30, 0.7));

    expect(state.subjects.A.carriedAttributedShare).toBeCloseTo(0.15, 12);
    expect(state.subjects.B.carriedAttributedShare).toBeCloseTo(0.05, 12);
    expect(state.assignedBurn).toBeCloseTo(0.05, 12);
    expect(state.subjects.B.attributedShare).toBeCloseTo(0.05, 12);
    expect(state.unattributedShare).toBeCloseTo(0.05, 12);
    const accounted = Object.values(state.subjects).reduce(
      (sum, value) => sum + value.carriedAttributedShare + value.attributedShare,
      state.unattributedShare,
    );
    expect(accounted).toBeCloseTo(1 - state.fraction, 12);

    state = reduceWindow(state, snapshot(T + FIVE_HOURS, 1, { resetAt: T + 2 * FIVE_HOURS }));
    expect(state.subjects.A.carriedAttributedShare).toBe(0);
    expect(state.subjects.B.carriedAttributedShare).toBe(0);
    expect(state.assignedBurn).toBe(0);
    expect(state.unattributedShare).toBe(0);
  });

  it("resets an early official weekly rollover when resetAt advances and the mother fraction rebounds", () => {
    const previousObservedAt = Date.parse("2026-07-13T04:37:10.522Z");
    const rolloverObservedAt = Date.parse("2026-07-13T04:38:27.708Z");
    const previousResetAt = Date.parse("2026-07-18T06:02:35.000Z");
    const rolloverResetAt = Date.parse("2026-07-20T00:06:05.000Z");
    let state = createCarriedWindowState({
      scope: "weekly",
      windowMs: WEEK,
      windowStart: previousResetAt - WEEK,
      fraction: 0.72,
      lastSnapshotAt: previousObservedAt,
      subjects: [
        { ...subjects[0], active: true, carriedAttributedShare: 0.2 },
        { ...subjects[1], active: true, carriedAttributedShare: 0.08 },
      ],
    });
    state = reduceWindow(state, usage("A", previousObservedAt + 1_000));

    state = reduceWindow(state, snapshot(rolloverObservedAt, 0.86, {
      snapshotId: "official-early-weekly-rollover",
      resetAt: rolloverResetAt,
    }));

    expect(rolloverObservedAt).toBeLessThan(previousResetAt);
    expect(state.resetAt).toBe(rolloverResetAt);
    expect(state.fraction).toBe(0.86);
    expect(state.subjects.A.cumulativeCu).toBe(0);
    expect(state.subjects.A.carriedAttributedShare).toBe(0);
    expect(state.subjects.B.carriedAttributedShare).toBe(0);
    expect(state.subjects.A.attributedShare).toBe(0);
    expect(state.subjects.B.attributedShare).toBe(0);
    expect(state.assignedBurn).toBe(0);
    expect(state.unattributedShare).toBe(0);
  });

  it.each([-1, 1.01, Number.NaN, Number.POSITIVE_INFINITY])("ignores an invalid snapshot fraction %s", (fraction) => {
    const before = primed();
    const state = reduceWindow(before, snapshot(T + 10, fraction, { snapshotId: `invalid-${String(fraction)}` }));

    expect(state.fraction).toBe(1);
    expect(state.assignedBurn).toBe(0);
    expect(state.unattributedShare).toBe(0);
    expect(state.revision).toBe(before.revision);
    expect(state.reorderTail).toEqual(before.reorderTail);
    expect(state.lastReason).toBe("SNAPSHOT_INVALID_FRACTION");
  });

  it("does not establish a window from a snapshot without a valid resetAt", () => {
    const initial = createWindowState({ scope: "primary", windowMs: FIVE_HOURS, subjects });
    const state = reduceWindow(initial, snapshot(T, 0.4, { resetAt: 0 }));

    expect(state.primed).toBe(false);
    expect(state.resetAt).toBe(0);
    expect(state.fraction).toBe(1);
    expect(state.lastReason).toBe("SNAPSHOT_INVALID_RESET_AT");
  });

  it("backfills a sole exclusive card from the first trusted mother snapshot", () => {
    const initial = createWindowState({
      scope: "primary",
      windowMs: FIVE_HOURS,
      subjects: [{ quotaSubjectId: "A", share: 1, exclusive: true }],
    });
    const state = reduceWindow(initial, snapshot(T, 0.33));

    expect(state.subjects.A.carriedAttributedShare).toBeCloseTo(0.67, 12);
    expect(state.unattributedShare).toBe(0);
    expect(getSubjectQuota(state, "A").personalFraction).toBeCloseTo(0.33, 12);
    expect(getSubjectQuota(state, "A").fraction).toBeCloseTo(0.33, 12);
  });

  it("does not invent personal attribution for a shared cold start", () => {
    const state = reduceWindow(
      createWindowState({ scope: "primary", windowMs: FIVE_HOURS, subjects }),
      snapshot(T, 0.33),
    );

    expect(state.subjects.A.carriedAttributedShare).toBe(0);
    expect(state.subjects.B.carriedAttributedShare).toBe(0);
  });

  it("uses a zero resetAt snapshot as an observation without moving an established window", () => {
    const before = primed();
    const state = reduceWindow(before, snapshot(T + 10, 0.8, { resetAt: 0 }));

    expect(state.fraction).toBe(0.8);
    expect(state.resetAt).toBe(before.resetAt);
    expect(state.windowStart).toBe(before.windowStart);
  });

  it("does not apply the same report id twice while a failed checkpoint is retried", () => {
    let state = primed();
    state = reduceWindow(state, usage("A", T + 10));
    const once = state.subjects.A.cumulativeCu;
    state = reduceWindow(state, usage("A", T + 10));
    expect(state.subjects.A.cumulativeCu).toBe(once);
    expect(state.lastReason).toBe("EVENT_DUPLICATE");
  });

  it("makes first-request snapshot-before-report equal report-before-snapshot", () => {
    const initial = primed();
    const reportFirst = reduceWindow(
      reduceWindow(initial, usage("A", T + 10)),
      snapshot(T + 20, 0.97),
    );
    const snapshotFirst = reduceWindow(
      reduceWindow(initial, snapshot(T + 20, 0.97)),
      usage("A", T + 10, T + 30),
    );

    expect(snapshotFirst.subjects).toEqual(reportFirst.subjects);
    expect(snapshotFirst.assignedBurn).toBeCloseTo(0.03, 12);
    expect(snapshotFirst.unattributedShare).toBe(0);
    expect(snapshotFirst.subjects.A.attributedShare).toBeCloseTo(0.03, 12);
  });

  it("rebalances an existing A when B report arrives after the snapshot", () => {
    let initial = primed();
    initial = reduceWindow(initial, usage("A", T + 5, T + 5, 100));
    initial = reduceWindow(initial, snapshot(T + 6, 0.98));

    const reportFirst = reduceWindow(
      reduceWindow(initial, usage("B", T + 10, T + 10, 300)),
      snapshot(T + 20, 0.9),
    );
    const snapshotFirst = reduceWindow(
      reduceWindow(initial, snapshot(T + 20, 0.9)),
      usage("B", T + 10, T + 30, 300),
    );

    expect(snapshotFirst.subjects).toEqual(reportFirst.subjects);
    expect(snapshotFirst.subjects.A.attributedShare).toBeCloseTo(0.025, 12);
    expect(snapshotFirst.subjects.B.attributedShare).toBeCloseTo(0.075, 12);
  });

  it.each([1_000, 30_000, 9 * 60_000 + 59_000])("reconciles a report delayed by %d ms", (delay) => {
    let state = primed();
    state = reduceWindow(state, snapshot(T + 20, 0.95));
    state = reduceWindow(state, usage("A", T + 10, T + 20 + delay));
    expect(state.subjects.A.attributedShare).toBeCloseTo(0.05, 12);
    expect(state.unattributedShare).toBe(0);
    expect(state.lastReason).toBe("LATE_USAGE_RECONCILED");
  });

  it("keeps evidence missing after the bounded reorder horizon", () => {
    let state = primed();
    state = reduceWindow(state, snapshot(T + 20, 0.95));
    state = reduceWindow(state, usage("A", T + 10, T + 20 + 10 * 60_000 + 1));
    expect(state.unattributedShare).toBeCloseTo(0.05, 12);
    expect(state.subjects.A.attributedShare).toBe(0);
    expect(state.subjects.A.cumulativeCu).toBe(100);
    expect(state.lastReason).toBe("USAGE_EVIDENCE_MISSING");
  });

  it("does not move confirmed burn for usage that happened after the snapshot", () => {
    let state = primed();
    state = reduceWindow(state, snapshot(T + 20, 0.95));
    state = reduceWindow(state, usage("A", T + 21));
    expect(state.unattributedShare).toBeCloseTo(0.05, 12);
    expect(state.subjects.A.attributedShare).toBe(0);
  });

  it("immediately mirrors a trusted mother-account rebound", () => {
    let state = primed();
    state = reduceWindow(state, usage("A", T + 10));
    state = reduceWindow(state, snapshot(T + 20, 0.8));
    state = reduceWindow(state, snapshot(T + 30, 0.9));
    expect(state.assignedBurn).toBeCloseTo(0.1, 12);
    expect(state.subjects.A.attributedShare).toBeCloseTo(0.1, 12);
    expect(getSubjectQuota(state, "A").fraction).toBeGreaterThan(0.7);
  });

  it("does not apply the same snapshot id twice", () => {
    let state = primed();
    const event = snapshot(T + 30, 0.8);
    state = reduceWindow(state, event);
    const before = state;
    state = reduceWindow(state, { ...event, fraction: 0.7, arrivedAt: T + 40 });
    expect(state.fraction).toBe(before.fraction);
    expect(state.lastReason).toBe("EVENT_DUPLICATE");
  });

  it("replays two snapshots and intervening usage identically when arrivals reorder within the horizon", () => {
    const older = snapshot(T + 10, 0.9, { snapshotId: "older" });
    const report = usage("A", T + 15, T + 15);
    const newer = snapshot(T + 20, 0.7, { snapshotId: "newer" });
    const permutations = <TItem,>(items: TItem[]): TItem[][] => items.length <= 1
      ? [items]
      : items.flatMap((item, index) => permutations(items.filter((_, i) => i !== index)).map((tail) => [item, ...tail]));
    const results = permutations([older, report, newer]).map((ordered) => ordered.reduce(
      (state, event, index) => reduceWindow(state, { ...event, arrivedAt: T + 30 + index }),
      primed(),
    ));
    const expected = results[0];

    for (const result of results.slice(1)) {
      expect(result.fraction).toBe(expected.fraction);
      expect(result.assignedBurn).toBeCloseTo(expected.assignedBurn, 12);
      expect(result.unattributedShare).toBeCloseTo(expected.unattributedShare, 12);
      expect(result.subjects).toEqual(expected.subjects);
    }
    expect(expected.assignedBurn).toBeCloseTo(0.2, 12);
    expect(expected.unattributedShare).toBeCloseTo(0.1, 12);
  });

  it("still rejects a snapshot that arrives outside the reorder horizon", () => {
    let state = primed();
    state = reduceWindow(state, snapshot(T + 20, 0.7, { snapshotId: "newer" }));
    const before = state;
    state = reduceWindow(state, snapshot(T + 10, 0.9, {
      snapshotId: "too-late",
      arrivedAt: T + 20 + 10 * 60_000 + 1,
    }));

    expect(state.fraction).toBe(before.fraction);
    expect(state.assignedBurn).toBe(before.assignedBurn);
    expect(state.unattributedShare).toBe(before.unattributedShare);
    expect(state.lastReason).toBe("SNAPSHOT_STALE_OBSERVED_AT");
  });

  it("applies a newer observation without allowing resetAt to move backward", () => {
    let state = primed();
    const originalResetAt = state.resetAt;
    const originalWindowStart = state.windowStart;
    state = reduceWindow(state, snapshot(T + 20, 0.8, {
      snapshotId: "backward-reset",
      resetAt: originalResetAt - 60 * 60 * 1000,
    }));

    expect(state.fraction).toBe(0.8);
    expect(state.resetAt).toBe(originalResetAt);
    expect(state.windowStart).toBe(originalWindowStart);
  });

  it("scales pool users so their absolute usable total never exceeds mother remaining", () => {
    let state = primed();
    state = reduceWindow(state, snapshot(T + 20, 0.2));
    const a = getSubjectQuota(state, "A");
    const b = getSubjectQuota(state, "B");
    expect(a.absoluteRemaining + b.absoluteRemaining).toBeCloseTo(0.2, 12);
  });

  it("keeps personal remaining separate from mother-account conservation scaling", () => {
    let state = primed();
    state = reduceWindow(state, snapshot(T + 20, 0.2));

    const a = getSubjectQuota(state, "A");
    const b = getSubjectQuota(state, "B");

    expect(a.personalFraction).toBe(1);
    expect(b.personalFraction).toBe(1);
    expect(a.fraction).toBeCloseTo(0.2, 12);
    expect(b.fraction).toBeCloseTo(0.2, 12);
    expect(a.absoluteRemaining + b.absoluteRemaining).toBeCloseTo(0.2, 12);
  });

  it("updates primary and weekly independently", () => {
    let windows = createQuotaWindows({ subjects, primaryWindowMs: FIVE_HOURS, weeklyWindowMs: WEEK });
    windows = reduceQuotaWindows(windows, { scope: "primary", event: snapshot(T, 1) });
    windows = reduceQuotaWindows(windows, { scope: "weekly", event: snapshot(T, 1, { resetAt: T + WEEK }) });
    windows = reduceQuotaWindows(windows, { scope: "both", event: usage("A", T + 10) });
    windows = reduceQuotaWindows(windows, { scope: "primary", event: snapshot(T + 20, 0.8) });

    expect(windows.primary.subjects.A.attributedShare).toBeCloseTo(0.2, 12);
    expect(windows.weekly.subjects.A.attributedShare).toBe(0);
    expect(windows.weekly.subjects.A.cumulativeCu).toBe(100);
  });

  it("keeps accounting by stable subject across join, leave, and credential rebind", () => {
    let state = reduceWindow(
      createWindowState({ scope: "primary", windowMs: FIVE_HOURS, subjects: [subjects[0]] }),
      snapshot(T, 1),
    );
    state = reduceWindow(state, usage("A", T + 5));
    state = reduceWindow(state, snapshot(T + 10, 0.9));

    const join: MembershipEvent = {
      kind: "membership",
      membershipId: "join-B",
      subjects,
      occurredAt: T + 11,
      arrivedAt: T + 11,
    };
    state = reduceWindow(state, join);
    expect(state.subjects.A.attributedShare).toBeCloseTo(0.1, 12);
    expect(state.subjects.B.attributedShare).toBe(0);

    state = reduceWindow(state, usage("B", T + 12, T + 12, 100));
    state = reduceWindow(state, snapshot(T + 20, 0.8));
    expect(state.subjects.A.attributedShare).toBeCloseTo(0.1, 12);
    expect(state.subjects.B.attributedShare).toBeCloseTo(0.1, 12);

    state = reduceWindow(state, {
      kind: "membership",
      membershipId: "leave-A",
      subjects: [subjects[1]],
      occurredAt: T + 21,
      arrivedAt: T + 21,
    });
    expect(getSubjectQuota(state, "A").fraction).toBe(0);
    expect(state.subjects.A.cumulativeCu).toBe(100);

    state = reduceWindow(state, {
      kind: "membership",
      membershipId: "same-subject-new-card",
      subjects: [subjects[0], subjects[1]],
      occurredAt: T + 22,
      arrivedAt: T + 22,
    });
    expect(state.subjects.A.cumulativeCu).toBe(100);
    expect(state.subjects.A.attributedShare).toBeCloseTo(0.1, 12);
  });

  it("resets only the scope whose official window advanced", () => {
    let windows = createQuotaWindows({ subjects, primaryWindowMs: FIVE_HOURS, weeklyWindowMs: WEEK });
    windows = reduceQuotaWindows(windows, { scope: "primary", event: snapshot(T, 1) });
    windows = reduceQuotaWindows(windows, { scope: "weekly", event: snapshot(T, 1, { resetAt: T + WEEK }) });
    windows = reduceQuotaWindows(windows, { scope: "both", event: usage("A", T + 10) });
    windows = reduceQuotaWindows(windows, { scope: "primary", event: snapshot(T + 20, 0.8) });
    windows = reduceQuotaWindows(windows, { scope: "weekly", event: snapshot(T + 20, 0.9, { resetAt: T + WEEK }) });
    windows = reduceQuotaWindows(windows, {
      scope: "primary",
      event: snapshot(T + FIVE_HOURS, 1, { resetAt: T + 2 * FIVE_HOURS }),
    });

    expect(windows.primary.subjects.A.cumulativeCu).toBe(0);
    expect(windows.primary.subjects.A.attributedShare).toBe(0);
    expect(windows.weekly.subjects.A.cumulativeCu).toBe(100);
    expect(windows.weekly.subjects.A.attributedShare).toBeCloseTo(0.1, 12);
  });

  it("is invariant to all usage/snapshot network arrival permutations within the horizon", () => {
    const events = [usage("A", T + 10, 0, 100), usage("B", T + 12, 0, 300), snapshot(T + 20, 0.8)];
    const permutations = <TItem,>(items: TItem[]): TItem[][] => items.length <= 1
      ? [items]
      : items.flatMap((item, index) => permutations(items.filter((_, i) => i !== index)).map((tail) => [item, ...tail]));
    const results = permutations(events).map((ordered) => ordered.reduce((state, event, index) => reduceWindow(state, {
      ...event,
      arrivedAt: T + 30 + index,
    }), primed()));
    const expected = results[0];
    for (const result of results.slice(1)) {
      expect(result.subjects).toEqual(expected.subjects);
      expect(result.assignedBurn).toBeCloseTo(expected.assignedBurn, 12);
      expect(result.unattributedShare).toBeCloseTo(expected.unattributedShare, 12);
    }
  });

  it("bounds the in-memory/persisted reorder tail", () => {
    let state = primed();
    for (let i = 0; i < 300; i += 1) state = reduceWindow(state, usage("A", T + 1 + i, T + 1 + i, 1));
    expect(state.reorderTail.length).toBeLessThanOrEqual(REORDER_MAX_EVENTS);
    expect(Buffer.byteLength(JSON.stringify(state.reorderTail), "utf8")).toBeLessThanOrEqual(REORDER_MAX_BYTES);
  });

  it("records an observable reason when capacity compacts causal evidence", () => {
    const oversized = usage("A", T + 1, T + 1, 1);
    oversized.reportId = `oversized-${"x".repeat(REORDER_MAX_BYTES + 1)}`;

    const state = reduceWindow(primed(), oversized);

    expect(state.reorderTail).toHaveLength(0);
    expect(state.lastReason).toBe("WINDOW_TAIL_COMPACTED");
    expect(state.lastCompactionCount).toBe(2);
  });

  it("maintains accounting and capacity invariants through a long deterministic sequence", () => {
    let state = primed();
    let fraction = 1;
    for (let i = 1; i <= 200; i += 1) {
      state = reduceWindow(state, usage(i % 2 ? "A" : "B", T + i * 10, T + i * 10, i));
      if (i % 5 === 0) {
        fraction = Math.max(0, fraction - 0.01);
        state = reduceWindow(state, snapshot(T + i * 10 + 1, fraction));
      }
      const attributed = Object.values(state.subjects).reduce((sum, subject) => sum + subject.attributedShare, 0);
      const usable = Object.keys(state.subjects).reduce((sum, id) => sum + getSubjectQuota(state, id).absoluteRemaining, 0);
      expect(attributed + state.unattributedShare).toBeLessThanOrEqual(1 - state.fraction + 1e-9);
      expect(usable).toBeLessThanOrEqual(state.fraction + 1e-9);
    }
  });

  it("never oversells the mother account across 100 users and randomized changes", () => {
    const hundred = Array.from({ length: 100 }, (_, i) => ({
      quotaSubjectId: `U${i}`,
      share: 0.01,
    }));
    let state = reduceWindow(
      createWindowState({ scope: "primary", windowMs: FIVE_HOURS, subjects: hundred }),
      snapshot(T, 1),
    );
    let seed = 0x5eed1234;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    let fraction = 1;
    for (let i = 1; i <= 1_000; i += 1) {
      const id = `U${Math.floor(random() * 100)}`;
      state = reduceWindow(state, usage(id, T + i * 10, T + i * 10, 1 + Math.floor(random() * 10_000)));
      if (i % 7 === 0) {
        // Includes both downward use and upward rebound observations.
        fraction = Math.max(0, Math.min(1, fraction + (random() - 0.58) * 0.08));
        state = reduceWindow(state, snapshot(T + i * 10 + 1, fraction));
      }
      const totalUsable = hundred.reduce(
        (sum, subject) => sum + getSubjectQuota(state, subject.quotaSubjectId).absoluteRemaining,
        0,
      );
      expect(totalUsable).toBeLessThanOrEqual(state.fraction + 1e-9);
    }
  });
});
