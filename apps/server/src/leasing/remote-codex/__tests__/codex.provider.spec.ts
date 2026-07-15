import { describe, expect, it } from "vitest";

import { CodexProvider } from "../codex.provider";
import { getModelQuotaFraction } from "../../token-server/lease-scheduler";

describe("CodexProvider.leaseResponseExtras codexFastAllowed", () => {
  const provider = new CodexProvider();

  it("emits codexFastAllowed=true iff plan is fast-capable (no server env gate)", () => {
    expect(provider.leaseResponseExtras({ planType: "pro" } as any).codexFastAllowed).toBe(true);
    // plus is not fast-capable → omitted
    expect(provider.leaseResponseExtras({ planType: "plus" } as any).codexFastAllowed).toBeUndefined();
  });

  it("still carries codexWindows alongside the flag", () => {
    const extras = provider.leaseResponseExtras({
      planType: "pro", codexHourlyPercent: 80, codexWeeklyPercent: 30,
    } as any);
    expect(extras.codexFastAllowed).toBe(true);
    expect(extras.codexWindows).toBeDefined();
  });
});

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
        hourlyPresent: true,
        weeklyPresent: true,
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

  it("keeps the prior weekly when the client reports it as -1 (weekly window absent = unknown, not exhausted)", () => {
    const provider = new CodexProvider();
    // Account already carries a known-good weekly from an earlier full report.
    const account: any = {
      id: 1, email: "a@b.c", refreshToken: "r", enabled: true,
      codexHourlyPercent: 10, codexWeeklyPercent: 98,
      codexWeeklyResetTime: "2099-06-16T14:00:00Z",
    };
    // Upstream usage omitted the weekly (secondary) window → reported as -1
    // (explicit unknown), never a fabricated 100 that would poison fair-share.
    provider.applyQuotaSnapshot(account, {
      codexQuota: {
        hourlyPercent: 94,
        weeklyPercent: -1,
        hourlyResetTime: "2099-06-10T05:00:00Z",
        weeklyResetTime: "",
      },
    });
    // 5h updates; weekly stays 98 (NOT clobbered); binding = 5h (94 < 98) → 0.94.
    expect(account.codexHourlyPercent).toBe(94);
    expect(account.codexWeeklyPercent).toBe(98);
    expect(account.codexWeeklyResetTime).toBe("2099-06-16T14:00:00Z");
    expect((account as any).modelQuotaFractions.codex).toBeCloseTo(0.94, 5);
  });

  it("clears stale hourly state when a classified snapshot reports no hourly window", () => {
    const provider = new CodexProvider();
    const account: any = {
      id: 1, email: "a@b.c", refreshToken: "r", enabled: true,
      codexHourlyPercent: 10, codexHourlyResetTime: "2099-06-10T05:00:00Z",
      codexWeeklyPercent: 90, codexWeeklyResetTime: "2099-06-16T14:00:00Z",
      modelQuotaFractions: { codex: 0.1 },
      modelQuotaResetTimes: { codex: "2099-06-10T05:00:00Z" },
    };

    provider.applyQuotaSnapshot(account, {
      codexQuota: {
        hourlyPercent: -1,
        weeklyPercent: 72,
        hourlyPresent: false,
        weeklyPresent: true,
        weeklyResetTime: "2099-06-16T14:00:00Z",
      },
    });

    expect(account.codexHourlyPercent).toBeUndefined();
    expect(account.codexHourlyResetTime).toBeUndefined();
    expect(account.codexWeeklyPercent).toBe(72);
    expect(account.modelQuotaFractions.codex).toBeCloseTo(0.72, 5);
    expect(account.modelQuotaResetTimes.codex).toBe("2099-06-16T14:00:00Z");
  });

  it("preserves unknown presence across account persistence", () => {
    const provider = new CodexProvider();
    const account: any = { id: 1, email: "a@b.c", refreshToken: "r", enabled: true };
    provider.applyQuotaSnapshot(account, {
      fetchedAt: 100,
      codexQuota: { hourlyPercent: 90, weeklyPercent: -1, hourlyPresent: true },
    });

    expect(provider.quotaSnapshotInputs(account)[0]).toMatchObject({
      hourlyPresent: true,
      weeklyPresent: undefined,
    });
    expect((provider.leaseResponseExtras(account).codexWindows as any).weeklyPresent).toBeUndefined();
  });

  it("ignores an older presence snapshot that arrives after a newer weekly-only snapshot", () => {
    const provider = new CodexProvider();
    const account: any = { id: 1, email: "a@b.c", refreshToken: "r", enabled: true };
    provider.applyQuotaSnapshot(account, {
      fetchedAt: 200,
      codexQuota: { hourlyPercent: -1, weeklyPercent: 72, hourlyPresent: false, weeklyPresent: true },
    });
    provider.applyQuotaSnapshot(account, {
      fetchedAt: 100,
      codexQuota: { hourlyPercent: 90, weeklyPercent: 90, hourlyPresent: true, weeklyPresent: true },
    });

    expect(account.codexHourlyPercent).toBeUndefined();
    expect(account.codexHourlyPresent).toBe(false);
    expect(account.codexWeeklyPercent).toBe(72);
  });

  it("clears the old binding reset when the new binding has no reset", () => {
    const provider = new CodexProvider();
    const account: any = {
      id: 1, email: "a@b.c", refreshToken: "r", enabled: true,
      codexHourlyPercent: 10,
      codexHourlyResetTime: "2099-06-10T05:00:00Z",
      modelQuotaFractions: { codex: 0.1 },
      modelQuotaResetTimes: { codex: "2099-06-10T05:00:00Z" },
    };
    provider.applyQuotaSnapshot(account, {
      codexQuota: { hourlyPercent: -1, weeklyPercent: 72, hourlyPresent: false, weeklyPresent: true },
    });

    expect(account.modelQuotaFractions.codex).toBeCloseTo(0.72, 5);
    expect(account.modelQuotaResetTimes.codex).toBeUndefined();
  });

  it("keeps the reset when the same exhausted binding omits reset temporarily", () => {
    const provider = new CodexProvider();
    const account: any = {
      id: 1, email: "a@b.c", refreshToken: "r", enabled: true,
      codexHourlyPercent: 0,
      codexHourlyPresent: true,
      codexHourlyResetTime: "2099-06-10T05:00:00Z",
      codexWeeklyPercent: 80,
      codexWeeklyPresent: true,
      modelQuotaFractions: { codex: 0 },
      modelQuotaResetTimes: { codex: "2099-06-10T05:00:00Z" },
    };

    provider.applyQuotaSnapshot(account, {
      codexQuota: {
        hourlyPercent: 0, weeklyPercent: 80,
        hourlyPresent: true, weeklyPresent: true,
      },
    });

    expect(account.modelQuotaFractions.codex).toBe(0);
    expect(account.modelQuotaResetTimes.codex).toBe("2099-06-10T05:00:00Z");
  });

  it("honors a genuine 0 (real exhaustion is a known value, not unknown)", () => {
    const { account } = snap({
      codexQuota: {
        hourlyPercent: 80,
        weeklyPercent: 0,
        weeklyResetTime: "2099-06-16T14:00:00Z",
      },
    });
    // weekly 0 binds → fraction 0; the real exhaustion is persisted, not skipped.
    expect((account as any).codexWeeklyPercent).toBe(0);
    expect((account as any).modelQuotaFractions.codex).toBeCloseTo(0, 5);
  });

  it("does not touch persisted quota when both windows are unknown (-1)", () => {
    const provider = new CodexProvider();
    const account: any = {
      id: 1, email: "a@b.c", refreshToken: "r",
      codexHourlyPercent: 50, codexWeeklyPercent: 60,
      modelQuotaFractions: { codex: 0.5 },
    };
    provider.applyQuotaSnapshot(account, {
      codexQuota: { hourlyPercent: -1, weeklyPercent: -1, hourlyResetTime: "", weeklyResetTime: "" },
    });
    expect(account.codexHourlyPercent).toBe(50);
    expect(account.codexWeeklyPercent).toBe(60);
    expect((account as any).modelQuotaFractions.codex).toBeCloseTo(0.5, 5);
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

describe("CodexProvider.leaseResponseExtras", () => {
  it("surfaces the leased account's 5h/weekly windows for upstream reset synchronization", () => {
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
        hourlyPresent: true,
        weeklyPresent: true,
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
