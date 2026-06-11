import { describe, expect, it } from "vitest";

import { CodexProvider } from "../codex.provider";
import { getModelQuotaFraction } from "../../token-server/lease-scheduler";

describe("CodexProvider.applyQuotaSnapshot", () => {
  function snap(quota: any) {
    const provider = new CodexProvider();
    const account: any = { id: 1, email: "a@b.c", refreshToken: "r", enabled: true };
    return provider.applyQuotaSnapshot(account, quota);
  }

  it("stores hourly/weekly percentages and a binding codex quota fraction", () => {
    const { account } = snap({
      planType: "pro",
      codexQuota: {
        hourlyPercent: 80,
        weeklyPercent: 30,
        hourlyResetTime: "2036-06-01T10:00:00Z",
        weeklyResetTime: "2036-06-05T00:00:00Z",
      },
    });

    expect(account.planType).toBe("pro");
    // Binding fraction = the more restrictive window = min(80, 30)/100 = 0.3
    expect((account as any).modelQuotaFractions.codex).toBeCloseTo(0.3, 5);
    // Reset time of the binding (weekly) window.
    expect((account as any).modelQuotaResetTimes.codex).toBe("2036-06-05T00:00:00Z");
    // Raw percentages kept for display.
    expect((account as any).codexHourlyPercent).toBe(80);
    expect((account as any).codexWeeklyPercent).toBe(30);
    expect((account as any).modelQuotaRefreshedAt).toBeGreaterThan(0);
  });

  it("makes codex models quota-aware via fuzzy match on the 'codex' key", () => {
    const { account } = snap({ codexQuota: { hourlyPercent: 50, weeklyPercent: 90 } });
    // Any codex model resolves to the 'codex' fraction (0.5 = min(50,90)/100).
    expect(getModelQuotaFraction(account, "gpt-5-codex")).toBeCloseTo(0.5, 5);
    expect(getModelQuotaFraction(account, "gpt-5.2-codex")).toBeCloseTo(0.5, 5);
  });

  it("quotaFractionFor applies the account-level codex quota to ALL codex models", () => {
    const provider = new CodexProvider();
    const account: any = { id: 1, email: "a@b.c", refreshToken: "r", enabled: true };
    provider.applyQuotaSnapshot(account, { codexQuota: { hourlyPercent: 50, weeklyPercent: 90 } });

    // *-codex names already worked via fuzzy match...
    expect(provider.quotaFractionFor(account, "gpt-5-codex")).toBeCloseTo(0.5, 5);
    // ...but plain gpt-5.x names did NOT (P1 regression) — now they do.
    expect(provider.quotaFractionFor(account, "gpt-5.2")).toBeCloseTo(0.5, 5);
    expect(provider.quotaFractionFor(account, "gpt-5.4")).toBeCloseTo(0.5, 5);
  });

  it("quotaFractionFor returns null when the account has no codex quota yet", () => {
    const provider = new CodexProvider();
    expect(provider.quotaFractionFor({ id: 1, email: "a@b.c", refreshToken: "r" } as any, "gpt-5.2")).toBeNull();
  });

  it("quotaSnapshotInputs returns one codex 5h/weekly window row", () => {
    const provider = new CodexProvider();
    const { account } = provider.applyQuotaSnapshot(
      { id: 1, email: "a@b.c", refreshToken: "r" } as any,
      {
        codexQuota: {
          hourlyPercent: 80, weeklyPercent: 30,
          hourlyResetTime: "2036-06-01T10:00:00Z", weeklyResetTime: "2036-06-05T00:00:00Z",
        },
      },
    );
    const rows = provider.quotaSnapshotInputs!(account);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ modelKey: "codex", hourlyPercent: 80, weeklyPercent: 30 });
    expect(rows[0].hourlyResetAt).toEqual(new Date("2036-06-01T10:00:00Z"));
  });

  it("quotaSnapshotInputs returns [] with no codex window data", () => {
    expect(new CodexProvider().quotaSnapshotInputs!({ id: 1, email: "a@b.c" } as any)).toEqual([]);
  });

  it("is a safe no-op when no codexQuota is present", () => {
    const { account } = snap({ planType: "plus" });
    expect(account.planType).toBe("plus");
    expect((account as any).modelQuotaFractions).toBeUndefined();
  });
});

describe("CodexProvider.bloodBarFraction", () => {
  it("returns the binding (more restrictive) fraction and its reset time", () => {
    const provider = new CodexProvider();
    const account: any = { id: 1, email: "a@b.c", refreshToken: "r", enabled: true };
    provider.applyQuotaSnapshot(account, {
      codexQuota: {
        hourlyPercent: 80,
        weeklyPercent: 30,
        weeklyResetTime: "2036-06-05T00:00:00Z",
      },
    });

    const bar = provider.bloodBarFraction(account, "gpt-5-codex");
    expect(bar.fraction).toBeCloseTo(0.3, 5);
    expect(bar.resetAt).toBe(Date.parse("2036-06-05T00:00:00Z"));
  });

  it("reports unknown (fraction -1) when there is no quota snapshot yet", () => {
    const provider = new CodexProvider();
    const bar = provider.bloodBarFraction({ id: 1, email: "a@b.c", refreshToken: "r" } as any, "gpt-5-codex");
    expect(bar.fraction).toBe(-1);
    expect(bar.resetAt).toBe(0);
  });
});

describe("CodexProvider.leaseResponseExtras", () => {
  it("surfaces the leased account's 5h/weekly windows so the client renders both codex bars without an upstream fetch", () => {
    const provider = new CodexProvider();
    const account: any = { id: 1, email: "a@b.c", refreshToken: "r", enabled: true };
    provider.applyQuotaSnapshot(account, {
      codexQuota: {
        hourlyPercent: 80,
        weeklyPercent: 30,
        hourlyResetTime: "2036-06-01T10:00:00Z",
        weeklyResetTime: "2036-06-05T00:00:00Z",
      },
    });

    expect(provider.leaseResponseExtras(account)).toEqual({
      codexWindows: {
        hourlyPercent: 80,
        weeklyPercent: 30,
        hourlyResetTime: "2036-06-01T10:00:00Z",
        weeklyResetTime: "2036-06-05T00:00:00Z",
      },
    });
  });

  it("omits codexWindows entirely before any quota snapshot exists (client keeps showing 未知, not fake 100%)", () => {
    const provider = new CodexProvider();
    expect(provider.leaseResponseExtras({ id: 1, email: "a@b.c", refreshToken: "r" } as any)).toEqual({});
  });
});

describe("CodexProvider.statusAccountExtras", () => {
  it("surfaces both 5h/weekly remaining percentages and reset times for the console", () => {
    const provider = new CodexProvider();
    const account: any = { id: 1, email: "a@b.c", refreshToken: "r", enabled: true };
    provider.applyQuotaSnapshot(account, {
      codexQuota: {
        hourlyPercent: 80,
        weeklyPercent: 30,
        hourlyResetTime: "2036-06-01T10:00:00Z",
        weeklyResetTime: "2036-06-05T00:00:00Z",
      },
    });

    expect(provider.statusAccountExtras(account)).toEqual({
      codexHourlyPercent: 80,
      codexWeeklyPercent: 30,
      codexHourlyResetTime: "2036-06-01T10:00:00Z",
      codexWeeklyResetTime: "2036-06-05T00:00:00Z",
    });
  });

  it("returns null percentages (not 0) before any quota snapshot exists", () => {
    const provider = new CodexProvider();
    expect(provider.statusAccountExtras({ id: 1, email: "a@b.c", refreshToken: "r" } as any)).toEqual({
      codexHourlyPercent: null,
      codexWeeklyPercent: null,
      codexHourlyResetTime: "",
      codexWeeklyResetTime: "",
    });
  });
});

describe("CodexProvider.egressPolicy", () => {
  it("is optional — codex uses a bound proxy when present, else local direct (fail-open)", () => {
    expect(new CodexProvider().egressPolicy).toBe("optional");
  });
});
