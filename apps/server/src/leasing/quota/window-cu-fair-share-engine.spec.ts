import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { WindowCuFairShareEngine } from "./window-cu-fair-share-engine";

const T = 1_800_000_000_000;

it("logs forward resets and newly created unattributed burn", () => {
  const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  const engine = new WindowCuFairShareEngine({
    provider: "codex",
    trackWeekly: true,
    now: () => T,
    getBoundCardWeights: () => [{ cardId: "A", weight: 1 }],
    getSeatCapacity: () => 1,
    isExclusive: () => false,
  });
  const resetAt = T + 7 * 24 * 60 * 60 * 1000;
  engine.applySnapshot(25, "codex-gpt", "weekly", {
    snapshotId: "prime", fraction: 1, observedAt: T, resetAt,
  });
  engine.applySnapshot(25, "codex-gpt", "weekly", {
    snapshotId: "burn", fraction: 0.99, observedAt: T + 1, resetAt,
  });
  engine.applySnapshot(25, "codex-gpt", "weekly", {
    snapshotId: "reset", fraction: 0.98, observedAt: resetAt, resetAt: resetAt + 7 * 24 * 60 * 60 * 1000,
  });

  const records = log.mock.calls.map(([message]) => JSON.parse(String(message)));
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({
    event: "UNATTRIBUTED_BURN_CREATED", accountId: 25, bucket: "codex-gpt", scope: "weekly",
    snapshotId: "burn", oldFraction: 1, newFraction: 0.99, totalCu: 0,
    oldUnattributedShare: 0, newUnattributedShare: 0.01,
  });
  expect(records[1]).toMatchObject({
    event: "FORWARD_RESET", accountId: 25, bucket: "codex-gpt", scope: "weekly",
    snapshotId: "reset", oldResetAt: resetAt, newResetAt: resetAt + 7 * 24 * 60 * 60 * 1000,
    oldUnattributedShare: 0.01, newUnattributedShare: 0,
  });
  log.mockRestore();
});

describe("WindowCuFairShareEngine global causal budget", () => {
  it("collapses the oldest tails instead of exceeding the process budget", () => {
    const engine = new WindowCuFairShareEngine({
      provider: "codex",
      trackWeekly: true,
      now: () => T,
      maxReorderBytes: 1_000,
      getBoundCardWeights: () => [{ cardId: "A", weight: 1 }],
      getSeatCapacity: () => 1,
      isExclusive: () => false,
    });

    for (const accountId of [1, 2]) {
      engine.applySnapshot(accountId, "codex-gpt", "primary", {
        snapshotId: `p-${accountId}-${"p".repeat(250)}`,
        fraction: 1,
        observedAt: T + accountId,
        resetAt: T + 5 * 60 * 60 * 1000,
      });
      engine.applySnapshot(accountId, "codex-gpt", "weekly", {
        snapshotId: `w-${accountId}-${"w".repeat(250)}`,
        fraction: 1,
        observedAt: T + accountId,
        resetAt: T + 7 * 24 * 60 * 60 * 1000,
      });
    }

    const diagnostic = engine.getReorderDiagnosticsForTesting();
    expect(diagnostic.totalBytes).toBeLessThanOrEqual(1_000);
    expect(diagnostic.windows.some((window) => window.reason === "WINDOW_GLOBAL_TAIL_COMPACTED")).toBe(true);
  });

  it("reports account_recovering when personal quota remains but the mother account is empty", () => {
    const engine = new WindowCuFairShareEngine({
      provider: "codex",
      trackWeekly: false,
      now: () => T,
      getBoundCardWeights: () => [{ cardId: "A", weight: 1 }],
      getSeatCapacity: () => 1,
      isExclusive: () => false,
    });
    engine.applySnapshot(1, "codex-gpt", "primary", {
      snapshotId: "mother-empty",
      fraction: 0,
      observedAt: T,
      resetAt: T + 5 * 60 * 60 * 1000,
    });

    expect(engine.check(1, "A", "codex-gpt")).toMatchObject({
      allowed: false,
      reason: "account_recovering",
      remainingFraction: 0,
    });
  });

  it("does not let an older present snapshot revive a newer absent window", () => {
    const engine = new WindowCuFairShareEngine({
      provider: "codex",
      trackWeekly: true,
      now: () => T,
      getBoundCardWeights: () => [{ cardId: "A", weight: 1 }],
      getSeatCapacity: () => 1,
      isExclusive: () => false,
    });
    engine.applySnapshot(1, "codex-gpt", "primary", {
      snapshotId: "baseline", fraction: 0.8, observedAt: T + 10, resetAt: T + 1000,
    });
    engine.setWindowPresent(1, "codex-gpt", "primary", false, T + 30);
    engine.setWindowPresent(1, "codex-gpt", "primary", true, T + 20);
    engine.applySnapshot(1, "codex-gpt", "primary", {
      snapshotId: "older-present", fraction: 0.9, observedAt: T + 20, resetAt: T + 1000,
    });

    expect(engine.getStateForTesting(1, "codex-gpt")?.primary).toMatchObject({
      primed: false,
      lastSnapshotAt: T + 30,
    });
  });

  it("does not let an older absent event override a newer present observation without a percentage", () => {
    const engine = new WindowCuFairShareEngine({
      provider: "codex",
      trackWeekly: true,
      now: () => T,
      getBoundCardWeights: () => [{ cardId: "A", weight: 1 }],
      getSeatCapacity: () => 1,
      isExclusive: () => false,
    });

    expect(engine.setWindowPresent(1, "codex-gpt", "primary", false, T + 10)).toBe(true);
    expect(engine.setWindowPresent(1, "codex-gpt", "primary", true, T + 30)).toBe(true);
    expect(engine.setWindowPresent(1, "codex-gpt", "primary", false, T + 20)).toBe(false);
  });
});
