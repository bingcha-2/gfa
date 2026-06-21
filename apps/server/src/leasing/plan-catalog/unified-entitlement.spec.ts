import { describe, expect, it } from "vitest";

import { buildFixedEntitlements, defaultSupplyPolicies, salesSeatCapacityFor } from "./unified-entitlement";

describe("defaultSupplyPolicies", () => {
  it("defines per-product sales-seat capacity and antigravity fixed quota buckets", () => {
    expect(defaultSupplyPolicies()).toEqual({
      anthropic: { defaultLevel: "max-20x", salesSeatsPerAccount: { "max-20x": 10 } },
      codex: { defaultLevel: "pro", salesSeatsPerAccount: { pro: 10 } },
      antigravity: {
        defaultLevel: "ultra",
        salesSeatsPerAccount: { ultra: 10 },
        buckets: {
          "antigravity-gemini": {
            source: "fixed",
            window5h: 100_000_000,
            weekly: 400_000_000,
          },
          "antigravity-claude": {
            source: "fixed",
            window5h: 12_000_000,
            weekly: 40_000_000,
          },
        },
      },
    });
  });
});

describe("buildFixedEntitlements", () => {
  it("scales antigravity fixed buckets by sold share seats", () => {
    expect(buildFixedEntitlements({}, {
      products: ["antigravity"],
      shareSeats: 1,
      shareCapacity: 8,
    })).toEqual({
      bucketLimits: {
        "antigravity-gemini": 12_500_000,
        "antigravity-claude": 1_500_000,
      },
      weeklyBucketLimits: {
        "antigravity-gemini": 50_000_000,
        "antigravity-claude": 5_000_000,
      },
    });
  });

  it("keeps default fixed antigravity quotas when a legacy catalog still has learned bucket sources", () => {
    const legacyCatalog = {
      supplyPolicies: {
        antigravity: {
          defaultLevel: "ultra",
          salesSeatsPerAccount: { ultra: 8 },
          buckets: {
            "antigravity-gemini": {
              source: "learned",
              provider: "antigravity",
              planType: "ultra",
              family: "gemini",
            },
            "antigravity-claude": {
              source: "learned",
              provider: "antigravity",
              planType: "ultra",
              family: "claude",
            },
          },
        },
      },
    } as any;

    expect(buildFixedEntitlements(legacyCatalog, {
      products: ["antigravity"],
      shareSeats: 1,
      shareCapacity: 8,
    })).toEqual({
      bucketLimits: {
        "antigravity-gemini": 12_500_000,
        "antigravity-claude": 1_500_000,
      },
      weeklyBucketLimits: {
        "antigravity-gemini": 50_000_000,
        "antigravity-claude": 5_000_000,
      },
    });
  });

  it("does not create fixed bucket entitlements for codex or anthropic", () => {
    expect(buildFixedEntitlements({}, {
      products: ["codex", "anthropic"],
      shareSeats: 1,
      shareCapacity: 8,
    })).toEqual({});
  });

  it("caps fixed bucket entitlements at a full upstream account", () => {
    expect(buildFixedEntitlements({}, {
      products: ["antigravity"],
      shareSeats: 16,
      shareCapacity: 8,
    })).toEqual({
      bucketLimits: {
        "antigravity-gemini": 100_000_000,
        "antigravity-claude": 12_000_000,
      },
      weeklyBucketLimits: {
        "antigravity-gemini": 400_000_000,
        "antigravity-claude": 40_000_000,
      },
    });
  });
});

describe("salesSeatCapacityFor", () => {
  it("reads per-product membership sales capacity and falls back through the product default level", () => {
    expect(salesSeatCapacityFor({}, "anthropic", "max-20x", 8)).toBe(10);
    expect(salesSeatCapacityFor({}, "codex", "pro", 8)).toBe(10);
    expect(salesSeatCapacityFor({}, "antigravity", "ultra", 8)).toBe(10);
    expect(salesSeatCapacityFor({}, "anthropic", "pro", 8)).toBe(10);
    expect(salesSeatCapacityFor({
      supplyPolicies: {
        anthropic: {
          defaultLevel: "pro",
          salesSeatsPerAccount: { pro: 12 },
        },
      },
    }, "anthropic", "max-5x", 8)).toBe(12);
    expect(salesSeatCapacityFor({}, "unknown", "pro", 6)).toBe(6);
  });
});
