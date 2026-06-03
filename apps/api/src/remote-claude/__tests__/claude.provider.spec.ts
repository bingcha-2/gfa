import { describe, expect, it } from "vitest";

import { ClaudeProvider } from "../claude.provider";
import { getModelQuotaFraction } from "../../token-server/lease-scheduler";

describe("ClaudeProvider basics", () => {
  it("has the claude id and an opus-bucketed model catalog", () => {
    const provider = new ClaudeProvider();
    expect(provider.id).toBe("claude");
    // Claude models bill to the universal 'opus' bucket.
    expect(provider.models.classify("claude-opus-4-20250514")).toBe("opus");
    expect(provider.models.list().length).toBeGreaterThan(0);
    expect(provider.models.list().every((m) => m.bucket === "opus")).toBe(true);
  });

  it("treats every account as eligible (no projectId requirement)", () => {
    const provider = new ClaudeProvider();
    expect(provider.isAccountEligible()).toBe(true);
  });
});

describe("ClaudeProvider.applyQuotaSnapshot", () => {
  function snap(quota: any) {
    const provider = new ClaudeProvider();
    const account: any = { id: 1, email: "a@b.c", refreshToken: "r", enabled: true };
    return provider.applyQuotaSnapshot(account, quota);
  }

  it("stores hourly/weekly percentages and a binding claude quota fraction", () => {
    const { account, creditDelta } = snap({
      planType: "max",
      claudeQuota: {
        hourlyPercent: 80,
        weeklyPercent: 30,
        hourlyResetTime: "2026-06-01T10:00:00Z",
        weeklyResetTime: "2026-06-05T00:00:00Z",
      },
    });

    expect(creditDelta).toBeNull(); // claude has no credits concept
    expect(account.planType).toBe("max");
    // Binding fraction = the more restrictive window = min(80, 30)/100 = 0.3
    expect((account as any).modelQuotaFractions.claude).toBeCloseTo(0.3, 5);
    // Reset time of the binding (weekly) window.
    expect((account as any).modelQuotaResetTimes.claude).toBe("2026-06-05T00:00:00Z");
    // Raw percentages kept for display.
    expect((account as any).claudeHourlyPercent).toBe(80);
    expect((account as any).claudeWeeklyPercent).toBe(30);
    expect((account as any).modelQuotaRefreshedAt).toBeGreaterThan(0);
  });

  it("makes claude models quota-aware via fuzzy match on the 'claude' key", () => {
    const { account } = snap({ claudeQuota: { hourlyPercent: 50, weeklyPercent: 90 } });
    // Any claude model resolves to the 'claude' fraction (0.5 = min(50,90)/100).
    expect(getModelQuotaFraction(account, "claude-opus-4-20250514")).toBeCloseTo(0.5, 5);
    expect(getModelQuotaFraction(account, "claude-sonnet-4-5-20250929")).toBeCloseTo(0.5, 5);
  });

  it("quotaFractionFor applies the account-level claude quota to ALL claude models", () => {
    const provider = new ClaudeProvider();
    const account: any = { id: 1, email: "a@b.c", refreshToken: "r", enabled: true };
    provider.applyQuotaSnapshot(account, { claudeQuota: { hourlyPercent: 50, weeklyPercent: 90 } });

    expect(provider.quotaFractionFor(account, "claude-opus-4-20250514")).toBeCloseTo(0.5, 5);
    expect(provider.quotaFractionFor(account, "claude-haiku-4-5-20251001")).toBeCloseTo(0.5, 5);
  });

  it("quotaFractionFor returns null when the account has no claude quota yet", () => {
    const provider = new ClaudeProvider();
    expect(
      provider.quotaFractionFor({ id: 1, email: "a@b.c", refreshToken: "r" } as any, "claude-opus-4-20250514"),
    ).toBeNull();
  });

  it("is a safe no-op when no claudeQuota is present", () => {
    const { account, creditDelta } = snap({ planType: "pro" });
    expect(creditDelta).toBeNull();
    expect(account.planType).toBe("pro");
    expect((account as any).modelQuotaFractions).toBeUndefined();
  });
});

describe("ClaudeProvider.bloodBarFraction", () => {
  it("returns the binding (more restrictive) fraction and its reset time", () => {
    const provider = new ClaudeProvider();
    const account: any = { id: 1, email: "a@b.c", refreshToken: "r", enabled: true };
    provider.applyQuotaSnapshot(account, {
      claudeQuota: {
        hourlyPercent: 80,
        weeklyPercent: 30,
        weeklyResetTime: "2026-06-05T00:00:00Z",
      },
    });

    const bar = provider.bloodBarFraction(account, "claude-opus-4-20250514");
    expect(bar.fraction).toBeCloseTo(0.3, 5);
    expect(bar.resetAt).toBe(Date.parse("2026-06-05T00:00:00Z"));
  });

  it("reports unknown (fraction -1) when there is no quota snapshot yet", () => {
    const provider = new ClaudeProvider();
    const bar = provider.bloodBarFraction(
      { id: 1, email: "a@b.c", refreshToken: "r" } as any,
      "claude-opus-4-20250514",
    );
    expect(bar.fraction).toBe(-1);
    expect(bar.resetAt).toBe(0);
  });
});

describe("ClaudeProvider.leaseResponseExtras", () => {
  it("surfaces the leased account's 5h/weekly windows so the client renders both claude bars without an upstream fetch", () => {
    const provider = new ClaudeProvider();
    const account: any = { id: 1, email: "a@b.c", refreshToken: "r", enabled: true };
    provider.applyQuotaSnapshot(account, {
      claudeQuota: {
        hourlyPercent: 80,
        weeklyPercent: 30,
        hourlyResetTime: "2026-06-01T10:00:00Z",
        weeklyResetTime: "2026-06-05T00:00:00Z",
      },
    });

    expect(provider.leaseResponseExtras(account)).toEqual({
      claudeWindows: {
        hourlyPercent: 80,
        weeklyPercent: 30,
        hourlyResetTime: "2026-06-01T10:00:00Z",
        weeklyResetTime: "2026-06-05T00:00:00Z",
      },
    });
  });

  it("omits claudeWindows entirely before any quota snapshot exists (client keeps showing 未知, not fake 100%)", () => {
    const provider = new ClaudeProvider();
    expect(provider.leaseResponseExtras({ id: 1, email: "a@b.c", refreshToken: "r" } as any)).toEqual({});
  });
});

describe("ClaudeProvider.statusAccountExtras", () => {
  it("surfaces both 5h/weekly remaining percentages and reset times for the console", () => {
    const provider = new ClaudeProvider();
    const account: any = { id: 1, email: "a@b.c", refreshToken: "r", enabled: true };
    provider.applyQuotaSnapshot(account, {
      claudeQuota: {
        hourlyPercent: 80,
        weeklyPercent: 30,
        hourlyResetTime: "2026-06-01T10:00:00Z",
        weeklyResetTime: "2026-06-05T00:00:00Z",
      },
    });

    expect(provider.statusAccountExtras(account)).toEqual({
      claudeHourlyPercent: 80,
      claudeWeeklyPercent: 30,
      claudeHourlyResetTime: "2026-06-01T10:00:00Z",
      claudeWeeklyResetTime: "2026-06-05T00:00:00Z",
    });
  });

  it("returns null percentages (not 0) before any quota snapshot exists", () => {
    const provider = new ClaudeProvider();
    expect(provider.statusAccountExtras({ id: 1, email: "a@b.c", refreshToken: "r" } as any)).toEqual({
      claudeHourlyPercent: null,
      claudeWeeklyPercent: null,
      claudeHourlyResetTime: "",
      claudeWeeklyResetTime: "",
    });
  });
});
