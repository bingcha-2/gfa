import { afterEach, describe, expect, it, vi } from "vitest";

import { ReceiptPruneScheduler } from "../receipt-prune-scheduler";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ReceiptPruneScheduler", () => {
  it("owns one timer for all providers and stops it after the final unregister", () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
    const scheduler = new ReceiptPruneScheduler();

    const stopCodex = scheduler.register({ provider: "codex", pruneBatch: vi.fn(async () => 0) });
    const stopAnthropic = scheduler.register({ provider: "anthropic", pruneBatch: vi.fn(async () => 0) });
    const stopTokenServer = scheduler.register({ provider: "token-server", pruneBatch: vi.fn(async () => 0) });

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    stopCodex();
    stopAnthropic();
    expect(clearTimeoutSpy).not.toHaveBeenCalled();
    stopTokenServer();
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it("schedules the shared cleanup for the next Beijing-time 03:00", () => {
    vi.useFakeTimers();
    // 17:00 UTC = 01:00 the next day in Beijing, regardless of host timezone.
    vi.setSystemTime(new Date("2026-07-14T17:00:00.000Z"));
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const scheduler = new ReceiptPruneScheduler();

    const stop = scheduler.register({ provider: "codex", pruneBatch: vi.fn(async () => 0) });

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2 * 60 * 60 * 1000);
    stop();
  });

  it("runs providers serially and caps the whole process to one shared batch budget", async () => {
    vi.useFakeTimers();
    let active = 0;
    let maxActive = 0;
    const calls: string[] = [];
    const prune = (provider: string) => vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      calls.push(provider);
      await Promise.resolve();
      active--;
      return 500;
    });
    const scheduler = new ReceiptPruneScheduler({ batchSize: 500, maxBatches: 5, batchPauseMs: 0 });
    const stops = ["codex", "anthropic", "token-server"].map((provider) =>
      scheduler.register({ provider, pruneBatch: prune(provider) }),
    );

    await scheduler.runOnce();

    expect(maxActive).toBe(1);
    expect(calls).toEqual(["codex", "anthropic", "token-server", "codex", "anthropic"]);
    stops.forEach((stop) => stop());
  });

  it("does not start a second cleanup while the previous global run is active", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pruneBatch = vi.fn(async () => { await gate; return 0; });
    const scheduler = new ReceiptPruneScheduler();
    const stop = scheduler.register({ provider: "codex", pruneBatch });

    const first = scheduler.runOnce();
    await Promise.resolve();
    await scheduler.runOnce();
    expect(pruneBatch).toHaveBeenCalledTimes(1);

    release();
    await first;
    stop();
  });

  it("stops the whole cleanup run when one provider fails", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const scheduler = new ReceiptPruneScheduler({ maxBatches: 3, batchPauseMs: 0, onError });
    const stopCodex = scheduler.register({
      provider: "codex",
      pruneBatch: vi.fn(async () => { throw new Error("database is locked"); }),
    });
    const anthropic = vi.fn(async () => 0);
    const stopAnthropic = scheduler.register({ provider: "anthropic", pruneBatch: anthropic });

    await scheduler.runOnce();

    expect(onError).toHaveBeenCalledWith("codex", expect.any(Error));
    expect(anthropic).not.toHaveBeenCalled();
    stopCodex();
    stopAnthropic();
  });

  it("stops the daily run when its time budget is exhausted", async () => {
    vi.useFakeTimers();
    let now = 0;
    const pruneBatch = vi.fn(async () => {
      now += 3_000;
      return 500;
    });
    const scheduler = new ReceiptPruneScheduler({
      maxBatches: 100,
      maxDurationMs: 5_000,
      batchPauseMs: 0,
      now: () => now,
    });
    const stop = scheduler.register({ provider: "codex", pruneBatch });

    await scheduler.runOnce();

    expect(pruneBatch).toHaveBeenCalledTimes(2);
    stop();
  });
});
