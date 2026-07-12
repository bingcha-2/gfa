import { describe, expect, it } from "vitest";
import {
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

  it("rejects stale and duplicate snapshots", () => {
    let state = primed();
    state = reduceWindow(state, snapshot(T + 30, 0.8));
    const before = state;
    state = reduceWindow(state, snapshot(T + 20, 0.7, { arrivedAt: T + 40 }));
    expect(state.fraction).toBe(before.fraction);
    expect(state.lastReason).toBe("SNAPSHOT_STALE_OBSERVED_AT");
  });

  it("scales pool users so their absolute usable total never exceeds mother remaining", () => {
    let state = primed();
    state = reduceWindow(state, snapshot(T + 20, 0.2));
    const a = getSubjectQuota(state, "A");
    const b = getSubjectQuota(state, "B");
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
