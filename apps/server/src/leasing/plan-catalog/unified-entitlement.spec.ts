import { describe, expect, it } from "vitest";

import { defaultSupplyPolicies, salesSeatCapacityFor } from "./unified-entitlement";

describe("defaultSupplyPolicies", () => {
  it("defines per-product sales-seat capacity (no static per-bucket entitlements — fair-share governs)", () => {
    expect(defaultSupplyPolicies()).toEqual({
      anthropic: { defaultLevel: "max-20x", salesSeatsPerAccount: { "max-20x": 10 } },
      codex: { defaultLevel: "pro", salesSeatsPerAccount: { pro: 10 } },
      antigravity: { defaultLevel: "ultra", salesSeatsPerAccount: { ultra: 10 } },
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
