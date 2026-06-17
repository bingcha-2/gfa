import { describe, expect, it, vi } from "vitest";

import { QuotaBaselineService } from "./quota-baseline.service";

describe("QuotaBaselineService", () => {
  it("combines fixed entitlements with learned quota profile rows", async () => {
    const findUnique = vi.fn(async ({ where }) => {
      const key = where.provider_planType_family;
      if (key.provider === "anthropic") return { window5h: 50_000_001, weekly: 200_000_005 };
      if (key.provider === "codex") return { window5h: 30_000_000, weekly: 0 };
      return null;
    });
    const service = new QuotaBaselineService({ quotaProfile: { findUnique } } as any);

    const entitlements = await service.buildEntitlements(
      {},
      { products: ["anthropic", "codex", "antigravity"], shareSeats: 1, shareCapacity: 2 },
    );

    expect(entitlements).toEqual({
      bucketLimits: {
        "anthropic-claude": 25_000_000,
        "codex-gpt": 15_000_000,
        "antigravity-gemini": 50_000_000,
        "antigravity-claude": 6_000_000,
      },
      weeklyBucketLimits: {
        "anthropic-claude": 100_000_002,
        "antigravity-gemini": 200_000_000,
        "antigravity-claude": 20_000_000,
      },
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        provider_planType_family: {
          provider: "anthropic",
          planType: "max-20x",
          family: "claude",
        },
      },
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        provider_planType_family: {
          provider: "codex",
          planType: "pro",
          family: "gpt",
        },
      },
    });
  });

  it("skips missing or zero learned rows and honors catalog learned overrides", async () => {
    const findUnique = vi.fn(async ({ where }) => {
      const key = where.provider_planType_family;
      if (key.provider === "anthropic" && key.planType === "max-5x") {
        return { window5h: 10_001, weekly: 19_999 };
      }
      if (key.provider === "codex") {
        return null;
      }
      if (key.provider === "zero-product") {
        return { window5h: 0, weekly: 0 };
      }
      return { window5h: 0, weekly: 0 };
    });
    const service = new QuotaBaselineService({ quotaProfile: { findUnique } } as any);

    const entitlements = await service.buildEntitlements(
      {
        supplyPolicies: {
          anthropic: {
            buckets: {
              "anthropic-claude": {
                source: "learned",
                provider: "anthropic",
                planType: "max-5x",
                family: "claude",
              },
            },
          },
          "zero-product": {
            defaultLevel: "zero",
            salesSeatsPerAccount: { zero: 10 },
            buckets: {
              "zero-bucket": {
                source: "learned",
                provider: "zero-product",
                planType: "zero",
                family: "zero",
              },
            },
          },
        },
      },
      { products: ["anthropic", "codex", "zero-product"], shareSeats: 1, shareCapacity: 4 },
    );

    expect(entitlements).toEqual({
      bucketLimits: { "anthropic-claude": 2_500 },
      weeklyBucketLimits: { "anthropic-claude": 4_999 },
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        provider_planType_family: {
          provider: "zero-product",
          planType: "zero",
          family: "zero",
        },
      },
    });
  });

  it("uses the selected product level for learned quota lookup when present", async () => {
    const findUnique = vi.fn(async () => ({ window5h: 80_000_000, weekly: 320_000_000 }));
    const service = new QuotaBaselineService({ quotaProfile: { findUnique } } as any);

    await service.buildEntitlements(
      {},
      {
        products: ["anthropic"],
        levels: { anthropic: "max-5x" },
        shareSeats: 2,
        shareCapacity: 8,
      },
    );

    expect(findUnique).toHaveBeenCalledWith({
      where: {
        provider_planType_family: {
          provider: "anthropic",
          planType: "max-5x",
          family: "claude",
        },
      },
    });
  });
});
