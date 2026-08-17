import { describe, expect, it } from "vitest";

import type { QuotaEstimatorAccountState } from "../token-server/account-quota-estimator";
import { estimateQuotaPool, type QuotaPoolSubscriptionInput } from "./quota-pool-estimate";

const NOW = Date.parse("2026-07-17T12:00:00.000Z");
const account = {
  id: 7,
  accountKey: "stable-account-key",
  email: "mother@example.com",
  planType: "max-20x",
  hourlyPercent: 70,
  weeklyPercent: 40,
  hourlyResetAt: "2026-07-17T15:00:00.000Z",
  weeklyResetAt: "2026-07-21T00:00:00.000Z",
  refreshedAt: NOW,
};

const estimator: QuotaEstimatorAccountState = {
  fiveHour: {
    epoch: 3,
    remainingPercent: 70,
    resetAt: Date.parse(account.hourlyResetAt),
    trackedUsedUsd: 30,
    inferredTotalUsd: 100,
    sampleCount: 3,
    sampleBurnBps: 3_000,
    lastSnapshotAt: NOW,
    lastSampleAt: NOW,
    confidence: "high",
  },
  weekly: {
    epoch: 2,
    remainingPercent: 40,
    resetAt: Date.parse(account.weeklyResetAt),
    trackedUsedUsd: 60,
    inferredTotalUsd: 100,
    sampleCount: 2,
    sampleBurnBps: 2_000,
    lastSnapshotAt: NOW,
    lastSampleAt: NOW,
    confidence: "medium",
  },
};

function subscription(overrides: Partial<QuotaPoolSubscriptionInput> = {}): QuotaPoolSubscriptionInput {
  return {
    id: "sub-1",
    customerEmail: "buyer@example.com",
    status: "ACTIVE",
    bindingAccountId: 7,
    weight: 1,
    exclusive: false,
    fiveHourLimit: 60,
    weeklyLimit: 300,
    usedFiveHour: 30,
    usedWeekly: 60,
    upstreamAccountId: 7,
    ...overrides,
  };
}

describe("estimateQuotaPool", () => {
  it("uses same-epoch Redis samples instead of subscription lifetime usage", () => {
    const pool = estimateQuotaPool("anthropic", account, [subscription()], NOW, estimator);

    expect(pool.fiveHour.inferredTotalUsd).toBe(100);
    expect(pool.fiveHour.inferredRemainingUsd).toBe(70);
    expect(pool.weekly.inferredTotalUsd).toBe(100);
    expect(pool.weekly.inferredRemainingUsd).toBe(40);
    expect(pool.fiveHour.trackedUsedUsd).toBe(30);
    expect(pool.fiveHour.coverageRatio).toBeCloseTo(70 / 30);
  });

  it("does not move historical usage when a subscription changes mother account", () => {
    const moved = subscription({ id: "moved", usedFiveHour: 900, upstreamAccountId: 8 });
    const pool = estimateQuotaPool("anthropic", account, [subscription(), moved], NOW, estimator);

    expect(pool.fiveHour.trackedUsedUsd).toBe(30);
    expect(pool.fiveHour.inferredTotalUsd).toBe(100);
    expect(pool.fiveHour.soldLimitUsd).toBe(120);
  });

  it("keeps a reset epoch separate from pre-reset subscription counters", () => {
    const afterReset: QuotaEstimatorAccountState = {
      ...estimator,
      fiveHour: {
        ...estimator.fiveHour!,
        epoch: 4,
        remainingPercent: 90,
        trackedUsedUsd: 10,
        inferredTotalUsd: null,
        sampleCount: 0,
        sampleBurnBps: 0,
        lastSampleAt: 0,
        confidence: "insufficient",
      },
    };
    const pool = estimateQuotaPool(
      "anthropic",
      { ...account, hourlyPercent: 90 },
      [subscription({ usedFiveHour: 90 })],
      NOW,
      afterReset,
    );

    expect(pool.fiveHour.trackedUsedUsd).toBe(10);
    expect(pool.fiveHour.inferredTotalUsd).toBeNull();
    expect(pool.fiveHour.inferredRemainingUsd).toBeNull();
    expect(pool.fiveHour.confidence).toBe("insufficient");
  });

  it("does not let a fresh account file mask a stale estimator epoch", () => {
    const staleEstimator: QuotaEstimatorAccountState = {
      fiveHour: {
        ...estimator.fiveHour!,
        remainingPercent: 40,
        lastSnapshotAt: NOW - 30 * 60 * 1_000,
      },
    };
    const pool = estimateQuotaPool(
      "codex",
      { ...account, hourlyPercent: 99, refreshedAt: NOW },
      [subscription()],
      NOW,
      staleEstimator,
    );

    expect(pool.fiveHour.remainingPercent).toBe(40);
    expect(pool.fiveHour.inferredRemainingUsd).toBe(40);
    expect(pool.fiveHour.confidence).toBe("medium");
    expect(pool.fiveHour.reasons.join(" ")).toContain("15");
  });

  it("shows sampling instead of falling back to the old inaccurate formula", () => {
    const pool = estimateQuotaPool("anthropic", account, [subscription()], NOW);

    expect(pool.fiveHour.confidence).toBe("insufficient");
    expect(pool.fiveHour.inferredTotalUsd).toBeNull();
    expect(pool.fiveHour.trackedUsedUsd).toBe(0);
    expect(pool.fiveHour.reasons.join(" ")).toContain("采样");
  });

  it("exposes only currently ACTIVE bound customer emails for search", () => {
    const pool = estimateQuotaPool("anthropic", account, [
      subscription({ id: "active-1", customerEmail: "Buyer@Example.com" }),
      subscription({ id: "active-2", customerEmail: "buyer@example.com" }),
      subscription({ id: "cancelled", status: "CANCELLED", customerEmail: "old@example.com" }),
      subscription({ id: "other-account", bindingAccountId: 8, customerEmail: "other@example.com" }),
    ], NOW, estimator);

    expect(pool.boundCustomerEmails).toEqual(["buyer@example.com"]);
  });

  it("marks a missing upstream window unavailable", () => {
    const pool = estimateQuotaPool(
      "codex",
      { ...account, hourlyPercent: -1 },
      [subscription()],
      NOW,
      { weekly: estimator.weekly },
    );

    expect(pool.fiveHour.confidence).toBe("unavailable");
    expect(pool.fiveHour.remainingPercent).toBeNull();
  });
});
