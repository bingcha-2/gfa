import { describe, expect, it } from "vitest";

import { normalizeCodexUsage } from "../auth/codex-usage";

describe("normalizeCodexUsage", () => {
  it("classifies a weekly window by duration even when it is primary", () => {
    const got = normalizeCodexUsage({
      plan_type: "pro",
      rate_limit: {
        primary_window: {
          used_percent: 20,
          limit_window_seconds: 604800,
          reset_after_seconds: 600000,
        },
        secondary_window: null,
      },
    }, 1_700_000_000);

    expect(got).toEqual({
      planType: "pro",
      codexQuota: {
        hourlyPercent: -1,
        weeklyPercent: 80,
        hourlyPresent: false,
        weeklyPresent: true,
        weeklyResetTime: new Date((1_700_000_000 + 600000) * 1000).toISOString(),
      },
    });
  });

  it("keeps the legacy two-window position fallback when durations are absent", () => {
    const got = normalizeCodexUsage({
      rate_limit: {
        primary_window: { used_percent: 10 },
        secondary_window: { used_percent: 30 },
      },
    }, 1_700_000_000);

    expect(got?.codexQuota).toMatchObject({
      hourlyPercent: 90,
      weeklyPercent: 70,
      hourlyPresent: true,
      weeklyPresent: true,
    });
  });

  it("keeps both window presences unknown when rate_limit is empty", () => {
    const got = normalizeCodexUsage({ rate_limit: {} }, 1_700_000_000);

    expect(got?.codexQuota).toEqual({
      hourlyPercent: -1,
      weeklyPercent: -1,
    });
  });
});
