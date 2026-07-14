import { describe, expect, it } from "vitest";

import { buildFixedEntitlements, defaultSupplyPolicies } from "./unified-entitlement";

describe("defaultSupplyPolicies", () => {
  it("defines product defaults and antigravity fixed quota buckets", () => {
    expect(defaultSupplyPolicies()).toEqual({
      anthropic: { defaultLevel: "max-20x" },
      codex: { defaultLevel: "pro" },
      antigravity: {
        defaultLevel: "ultra",
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
