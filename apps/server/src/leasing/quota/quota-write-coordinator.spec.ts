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
  });
});
