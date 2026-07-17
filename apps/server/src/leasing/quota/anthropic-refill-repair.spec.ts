import { describe, expect, it } from "vitest";

import { nextUtcHour, repairAnthropicWeeklyWindow } from "./anthropic-refill-repair";

describe("anthropic refill repair", () => {
  it("rebuilds only the bound Anthropic weekly window", () => {
    const resetObservedAt = Date.parse("2026-07-16T03:12:34.000Z");
    const result = repairAnthropicWeeklyWindow({
      rawWindowState: JSON.stringify({
        usdUsageByProduct: {
          anthropic: {
            used5h: 16.32,
            usedWeekly: 1_099.69,
            windowStartedAt5h: 123,
            upstreamWeekly: { resetAt: 999, lowFraction: 0.76, reboundCandidateCount: 1 },
          },
          codex: { used5h: 3, usedWeekly: 7 },
        },
        untouched: true,
      }),
      accountId: 43,
      resetObservedAt,
      rebuiltUsedWeekly: 17.03,
    });
    const state = JSON.parse(result.windowState);

    expect(result).toMatchObject({ oldUsedWeekly: 1_099.69, newUsedWeekly: 17.03 });
    expect(state.usdUsageByProduct.anthropic).toMatchObject({
      used5h: 16.32,
      usedWeekly: 17.03,
      windowStartedAt5h: 123,
      windowStartedAtWeekly: resetObservedAt,
      upstreamAccountId: 43,
      upstreamWeekly: {
        resetAt: 999,
        lowFraction: 0.76,
        appliedResetEventId: `repair:anthropic:43:weekly:${resetObservedAt}`,
      },
    });
    expect(state.usdUsageByProduct.anthropic.upstreamWeekly.reboundCandidateCount).toBeUndefined();
    expect(state.usdUsageByProduct.codex).toEqual({ used5h: 3, usedWeekly: 7 });
    expect(state.untouched).toBe(true);
  });

  it("rounds a non-hour reset boundary forward so pre-reset hourly usage is never charged", () => {
    expect(nextUtcHour(Date.parse("2026-07-16T03:00:00.000Z")))
      .toBe(Date.parse("2026-07-16T03:00:00.000Z"));
    expect(nextUtcHour(Date.parse("2026-07-16T03:12:34.000Z")))
      .toBe(Date.parse("2026-07-16T04:00:00.000Z"));
  });
});
