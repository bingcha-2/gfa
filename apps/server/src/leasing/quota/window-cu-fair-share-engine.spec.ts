import { describe, expect, it } from "vitest";
import { WindowCuFairShareEngine } from "./window-cu-fair-share-engine";

const T = 1_800_000_000_000;

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
});
