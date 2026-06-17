import { describe, expect, it } from "vitest";

import { buildFixedEntitlements, defaultSupplyPolicies } from "./unified-entitlement";

describe("defaultSupplyPolicies", () => {
  it("defines learned Claude and Codex defaults plus fixed Antigravity buckets", () => {
    expect(defaultSupplyPolicies()).toEqual({
      anthropic: {
        defaultLevel: "max-20x",
        salesSeatsPerAccount: { "max-20x": 10 },
        buckets: {
          "anthropic-claude": {
            source: "learned",
            provider: "anthropic",
            planType: "max-20x",
            family: "claude",
          },
        },
      },
      codex: {
        defaultLevel: "pro",
        salesSeatsPerAccount: { pro: 10 },
        buckets: {
          "codex-gpt": {
            source: "learned",
            provider: "codex",
            planType: "pro",
            family: "gpt",
          },
        },
      },
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
  it("scales fixed sources by shareSeats/shareCapacity and floors both windows", () => {
    const entitlements = buildFixedEntitlements(
      {},
      { products: ["antigravity"], shareSeats: 3, shareCapacity: 10 },
    );

    expect(entitlements).toEqual({
      bucketLimits: {
        "antigravity-gemini": 30_000_000,
        "antigravity-claude": 3_600_000,
      },
      weeklyBucketLimits: {
        "antigravity-gemini": 120_000_000,
        "antigravity-claude": 12_000_000,
      },
    });
  });

  it("merges catalog supply policy overrides and only writes positive fixed limits", () => {
    const entitlements = buildFixedEntitlements(
      {
        supplyPolicies: {
          antigravity: {
            buckets: {
              "antigravity-gemini": { source: "fixed", window5h: 9, weekly: 0 },
              "antigravity-empty": { source: "fixed", window5h: 0, weekly: -1 },
            },
          },
        },
      },
      { products: ["antigravity", "anthropic"], shareSeats: 1, shareCapacity: 2 },
    );

    expect(entitlements).toEqual({
      bucketLimits: {
        "antigravity-gemini": 4,
        "antigravity-claude": 6_000_000,
      },
      weeklyBucketLimits: {
        "antigravity-claude": 20_000_000,
      },
    });
  });
});
