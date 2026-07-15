import { afterEach, describe, expect, it, vi } from "vitest";
import { QuotaWriteCoordinator } from "./quota-write-coordinator";

describe("QuotaWriteCoordinator", () => {
  afterEach(() => vi.useRealTimers());

  it.each([1, 10, 64])("micro-batches %d account revisions into one commit", async (count) => {
    vi.useFakeTimers();
    const commit = vi.fn(async () => undefined);
    const coordinator = new QuotaWriteCoordinator<{ value: number }>({ commit });
    const promises = Array.from({ length: count }, (_, i) => coordinator.enqueue(`account-${i}`, i + 1, { value: i }));
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(promises);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0]).toHaveLength(count);
  });

  it("flushes immediately at 64 and puts the 65th revision in the next batch", async () => {
    vi.useFakeTimers();
    const commit = vi.fn(async () => undefined);
    const coordinator = new QuotaWriteCoordinator<{ value: number }>({ commit });
    const first = Array.from({ length: 64 }, (_, i) => coordinator.enqueue(`account-${i}`, 1, { value: i }));
    await Promise.resolve();
    const last = coordinator.enqueue("account-64", 1, { value: 64 });
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all([...first, last]);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls.map((call) => call[0].length)).toEqual([64, 1]);
  });

  it("collapses same-account changes to the newest revision while resolving every waiter", async () => {
    vi.useFakeTimers();
    const commit = vi.fn(async () => undefined);
    const coordinator = new QuotaWriteCoordinator<{ value: number }>({ commit });
    const p1 = coordinator.enqueue("account-1", 1, { value: 1 });
    const p2 = coordinator.enqueue("account-1", 2, { value: 2 });
    await vi.advanceTimersByTimeAsync(10);
    await expect(Promise.all([p1, p2])).resolves.toEqual([2, 2]);
    expect(commit.mock.calls[0][0]).toEqual([{ key: "account-1", revision: 2, payload: { value: 2 } }]);
  });

  it("merges receipt ids while collapsing the same account revision", async () => {
    vi.useFakeTimers();
    const commit = vi.fn(async () => undefined);
    const coordinator = new QuotaWriteCoordinator<{ value: number; receipts: string[] }>({
      commit,
      mergePayload: (oldValue, newValue) => ({
        value: newValue.value,
        receipts: [...new Set([...oldValue.receipts, ...newValue.receipts])],
      }),
    });
    const p1 = coordinator.enqueue("account-1", 1, { value: 1, receipts: ["r1"] });
    const p2 = coordinator.enqueue("account-1", 2, { value: 2, receipts: ["r2"] });
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all([p1, p2]);
    expect(commit.mock.calls[0][0][0].payload).toEqual({ value: 2, receipts: ["r1", "r2"] });
  });

  it("rejects failed checkpoints so the caller can retry the same revision", async () => {
    vi.useFakeTimers();
    const commit = vi.fn()
      .mockRejectedValueOnce(new Error("locked"))
      .mockResolvedValueOnce(undefined);
    const coordinator = new QuotaWriteCoordinator<{ value: number }>({ commit });
    const first = coordinator.enqueue("account-1", 1, { value: 1 });
    const firstRejected = expect(first).rejects.toThrow("locked");
    await vi.advanceTimersByTimeAsync(10);
    await firstRejected;
    const retry = coordinator.enqueue("account-1", 1, { value: 1 });
    await vi.advanceTimersByTimeAsync(10);
    await expect(retry).resolves.toBe(1);
  });

  it("acknowledges healthy keys when a committed batch reports isolated stale keys", async () => {
    vi.useFakeTimers();
    const staleKey = "account-1";
    const error = Object.assign(new Error("stale revision"), {
      code: "QUOTA_STALE_REVISION",
      staleKeys: [staleKey],
    });
    // The repository commits every healthy sibling first, then reports only the
    // isolated stale keys so their callers retry instead of poisoning the batch.
    const commit = vi.fn(async () => { throw error; });
    const coordinator = new QuotaWriteCoordinator<{ value: number }>({ commit });
    const stale = coordinator.enqueue(staleKey, 1, { value: 1 });
    const healthy = coordinator.enqueue("account-2", 2, { value: 2 });
    const staleRejected = expect(stale).rejects.toBe(error);

    await vi.advanceTimersByTimeAsync(10);

    await staleRejected;
    await expect(healthy).resolves.toBe(2);
    // A later enqueue at the already-durable healthy revision must not write it
    // again merely because another key in its original batch was stale.
    await expect(coordinator.enqueue("account-2", 2, { value: 2 })).resolves.toBe(2);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("rejects the whole batch when a stale error does not identify a queued key", async () => {
    vi.useFakeTimers();
    const error = Object.assign(new Error("malformed stale result"), {
      code: "QUOTA_STALE_REVISION",
      staleKeys: ["not-in-this-batch"],
    });
    const coordinator = new QuotaWriteCoordinator<{ value: number }>({
      commit: async () => { throw error; },
    });
    const first = coordinator.enqueue("account-1", 1, { value: 1 });
    const second = coordinator.enqueue("account-2", 1, { value: 2 });
    const firstRejected = expect(first).rejects.toBe(error);
    const secondRejected = expect(second).rejects.toBe(error);

    await vi.advanceTimersByTimeAsync(10);

    await Promise.all([firstRejected, secondRejected]);
  });

  it("can persist a new receipt even when reducer revision did not change", async () => {
    vi.useFakeTimers();
    const commit = vi.fn(async () => undefined);
    const coordinator = new QuotaWriteCoordinator<{ receipt: string }>({ commit });
    const first = coordinator.enqueue("account-1", 1, { receipt: "r1" }, true);
    await vi.advanceTimersByTimeAsync(10);
    await first;
    const second = coordinator.enqueue("account-1", 1, { receipt: "r2" }, true);
    await vi.advanceTimersByTimeAsync(10);
    await second;
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls[1][0][0].payload.receipt).toBe("r2");
  });

  it("runs low-priority prune only after checkpoint work is empty", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const coordinator = new QuotaWriteCoordinator<{ value: number }>({
      commit: async () => { order.push("checkpoint"); },
    });
    const prune = coordinator.scheduleLowPriority(async () => { order.push("prune"); });
    const checkpoint = coordinator.enqueue("account-1", 1, { value: 1 });
    await vi.advanceTimersByTimeAsync(10);
    await checkpoint;
    await vi.runAllTimersAsync();
    await prune;
    expect(order).toEqual(["checkpoint", "prune"]);
    await expect(prune).resolves.toBe(true);
  });

  it("gives up on the deadline without running work the coordinator never made room for", async () => {
    vi.useFakeTimers();
    const work = vi.fn(async () => undefined);
    // Never resolves, so the coordinator stays mid-flush exactly as it would
    // while a write-lock storm holds the commit open.
    const coordinator = new QuotaWriteCoordinator<{ value: number }>({ commit: () => new Promise<void>(() => {}) });
    void coordinator.enqueue("account-1", 1, { value: 1 });
    await vi.advanceTimersByTimeAsync(10);

    const prune = coordinator.scheduleLowPriority(work, 5_000);
    await vi.advanceTimersByTimeAsync(4_990);
    expect(work).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);

    await expect(prune).resolves.toBe(false);
    // The point of the deadline: skipped outright, never deferred into a later
    // turn where it would race whatever the caller scheduled next.
    expect(work).not.toHaveBeenCalled();
  });

  it("waits without a deadline when the coordinator goes quiet before it lapses", async () => {
    vi.useFakeTimers();
    const work = vi.fn(async () => undefined);
    const coordinator = new QuotaWriteCoordinator<{ value: number }>({ commit: async () => undefined });
    const checkpoint = coordinator.enqueue("account-1", 1, { value: 1 });
    const prune = coordinator.scheduleLowPriority(work, 5_000);
    await vi.advanceTimersByTimeAsync(10);
    await checkpoint;
    await vi.runAllTimersAsync();

    await expect(prune).resolves.toBe(true);
    expect(work).toHaveBeenCalledOnce();
  });
});
