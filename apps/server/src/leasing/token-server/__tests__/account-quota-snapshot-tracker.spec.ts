import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACCOUNT_QUOTA_SNAPSHOT_RETENTION_MS,
  AccountQuotaSnapshotTracker,
} from "../account-quota-snapshot-tracker";

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
  it("只安排下一次北京时间 02:00 的每日清理", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T17:00:00.000Z")); // Beijing 01:00
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const tracker = new AccountQuotaSnapshotTracker({ accountQuotaSnapshot: {} });
    active = tracker;

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 60 * 60 * 1000);
    tracker.destroy();
    active = null;
    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it("enqueues the first snapshot for a key", () => {
    const { tracker } = makeTracker();
    active = tracker;
    tracker.record({ provider: "codex", accountId: 1, modelKey: "codex", hourlyPercent: 80, weeklyPercent: 60 });
    expect(tracker.getQueueForTesting()).toHaveLength(1);
  });

  it("on-change dedup: skips changes smaller than 0.1%", () => {
    const { tracker } = makeTracker();
    active = tracker;
    tracker.record({ provider: "codex", accountId: 1, modelKey: "codex", hourlyPercent: 80, weeklyPercent: 60 });
    tracker.record({ provider: "codex", accountId: 1, modelKey: "codex", hourlyPercent: 80.04, weeklyPercent: 59.96 });
    // <0.1% change on both → deduped
    expect(tracker.getQueueForTesting()).toHaveLength(1);
  });

  it("enqueues again when a percentage moves at least 0.1%", () => {
    const { tracker } = makeTracker();
    active = tracker;
    tracker.record({ provider: "codex", accountId: 1, modelKey: "codex", hourlyPercent: 80, weeklyPercent: 60 });
    tracker.record({ provider: "codex", accountId: 1, modelKey: "codex", hourlyPercent: 79.9, weeklyPercent: 60 });
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

  it("前一次 flush 未结束时不会追加第二个写任务", async () => {
    let resolveCreateMany!: (value: { count: number }) => void;
    const createMany = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveCreateMany = resolve;
      }))
      .mockResolvedValue({ count: 1 });
    const tracker = new AccountQuotaSnapshotTracker(
      { accountQuotaSnapshot: { createMany } },
      { autoStart: false },
    );
    tracker.record({ provider: "codex", accountId: 1, modelKey: "codex", hourlyPercent: 80 });

    const first = tracker.flush();
    await Promise.resolve();
    tracker.record({ provider: "codex", accountId: 2, modelKey: "codex", hourlyPercent: 70 });
    const second = tracker.flush();

    expect(createMany).toHaveBeenCalledOnce();
    resolveCreateMany({ count: 1 });
    await Promise.all([first, second]);
    expect(tracker.getQueueForTesting()).toHaveLength(1);

    await tracker.flush();
    expect(createMany).toHaveBeenCalledTimes(2);
  });

  it("destroy() stops the flush timer", () => {
    const { tracker } = makeTracker();
    const spy = vi.spyOn(global, "clearInterval");
    tracker.destroy();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("分批删除 7 天以前的快照", async () => {
    const findMany = vi.fn()
      .mockResolvedValueOnce(Array.from({ length: 500 }, (_, id) => ({ id: `a${id}` })))
      .mockResolvedValueOnce([{ id: "last" }]);
    const deleteMany = vi.fn().mockResolvedValue({ count: 500 });
    const tracker = new AccountQuotaSnapshotTracker(
      { accountQuotaSnapshot: { findMany, deleteMany } },
      { autoStart: false, now: () => ACCOUNT_QUOTA_SNAPSHOT_RETENTION_MS + 24 * 60 * 60 * 1000 },
    );
    await tracker.pruneOld();
    expect(deleteMany).toHaveBeenCalledTimes(2);
    expect(deleteMany.mock.calls[0][0].where.id.in).toHaveLength(500);
    expect(findMany.mock.calls[0][0].where.timestamp.lt.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});
