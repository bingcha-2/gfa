import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountQuotaSnapshotTracker } from "../account-quota-snapshot-tracker";

function makeTracker() {
  const createMany = vi.fn(async () => ({ count: 0 }));
  const prisma = { accountQuotaSnapshot: { createMany } };
  const tracker = new AccountQuotaSnapshotTracker(prisma);
  return { tracker, createMany };
}

let active: AccountQuotaSnapshotTracker | null = null;
afterEach(() => {
  active?.destroy();
  active = null;
});

describe("AccountQuotaSnapshotTracker", () => {
  it("enqueues the first snapshot for a key", () => {
    const { tracker } = makeTracker();
    active = tracker;
    tracker.record({ provider: "codex", accountId: 1, modelKey: "codex", hourlyPercent: 80, weeklyPercent: 60 });
    expect(tracker.getQueueForTesting()).toHaveLength(1);
  });

  it("on-change dedup: skips when percentages and resets are unchanged", () => {
    const { tracker } = makeTracker();
    active = tracker;
    tracker.record({ provider: "codex", accountId: 1, modelKey: "codex", hourlyPercent: 80, weeklyPercent: 60 });
    tracker.record({ provider: "codex", accountId: 1, modelKey: "codex", hourlyPercent: 80.4, weeklyPercent: 59.7 });
    // <1% change on both → deduped
    expect(tracker.getQueueForTesting()).toHaveLength(1);
  });

  it("enqueues again when a percentage moves >= 1%", () => {
    const { tracker } = makeTracker();
    active = tracker;
    tracker.record({ provider: "codex", accountId: 1, modelKey: "codex", hourlyPercent: 80, weeklyPercent: 60 });
    tracker.record({ provider: "codex", accountId: 1, modelKey: "codex", hourlyPercent: 78, weeklyPercent: 60 });
    expect(tracker.getQueueForTesting()).toHaveLength(2);
  });

  it("enqueues again when a reset time changes (window rolled over)", () => {
    const { tracker } = makeTracker();
    active = tracker;
    const t1 = new Date("2026-06-07T10:00:00Z");
    const t2 = new Date("2026-06-07T15:00:00Z");
    tracker.record({ provider: "codex", accountId: 1, modelKey: "codex", hourlyPercent: 80, hourlyResetAt: t1 });
    tracker.record({ provider: "codex", accountId: 1, modelKey: "codex", hourlyPercent: 80, hourlyResetAt: t2 });
    expect(tracker.getQueueForTesting()).toHaveLength(2);
  });

  it("keys per provider/account/model independently (antigravity per-model)", () => {
    const { tracker } = makeTracker();
    active = tracker;
    tracker.record({ provider: "antigravity", accountId: 1, modelKey: "gemini-2.5-pro", hourlyPercent: 50 });
    tracker.record({ provider: "antigravity", accountId: 1, modelKey: "gemini-2.5-flash", hourlyPercent: 50 });
    expect(tracker.getQueueForTesting()).toHaveLength(2);
  });

  it("flush() batches to prisma.accountQuotaSnapshot.createMany and clears the queue", async () => {
    const { tracker, createMany } = makeTracker();
    active = tracker;
    tracker.record({ provider: "codex", accountId: 1, modelKey: "codex", hourlyPercent: 80 });
    tracker.record({ provider: "anthropic", accountId: 2, modelKey: "claude", hourlyPercent: 40 });
    await tracker.flush();
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0]?.[0]?.data).toHaveLength(2);
    expect(tracker.getQueueForTesting()).toHaveLength(0);
  });

  it("flush() is a no-op on an empty queue", async () => {
    const { tracker, createMany } = makeTracker();
    active = tracker;
    await tracker.flush();
    expect(createMany).not.toHaveBeenCalled();
  });

  it("destroy() stops the flush timer", () => {
    const { tracker } = makeTracker();
    const spy = vi.spyOn(global, "clearInterval");
    tracker.destroy();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
