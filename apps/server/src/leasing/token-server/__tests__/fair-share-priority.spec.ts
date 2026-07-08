import { describe, expect, it } from "vitest";

import {
  CODEX_PRIORITY_FAIR_SHARE_MULTIPLIER,
  FairShareTracker,
  fairShareCostMultiplierForServiceTier,
} from "../fair-share-tracker";

describe("fairShareCostMultiplierForServiceTier", () => {
  it("priority -> configured multiplier", () => {
    expect(fairShareCostMultiplierForServiceTier("priority")).toBe(CODEX_PRIORITY_FAIR_SHARE_MULTIPLIER);
    expect(fairShareCostMultiplierForServiceTier("Priority")).toBe(CODEX_PRIORITY_FAIR_SHARE_MULTIPLIER);
  });
  it("standard / flex / empty / undefined -> 1", () => {
    expect(fairShareCostMultiplierForServiceTier("")).toBe(1);
    expect(fairShareCostMultiplierForServiceTier(undefined)).toBe(1);
    expect(fairShareCostMultiplierForServiceTier("flex")).toBe(1);
    expect(fairShareCostMultiplierForServiceTier("default")).toBe(1);
  });
});

describe("FairShareTracker.weightedCost costMultiplier", () => {
  const model = "gpt-5-codex";
  const base = FairShareTracker.weightedCost(model, 1000, 500, 100);

  it("defaults to 1x (unchanged from prior behaviour)", () => {
    expect(FairShareTracker.weightedCost(model, 1000, 500, 100, 1)).toBe(base);
    expect(FairShareTracker.weightedCost(model, 1000, 500, 100)).toBe(base);
  });
  it("priority multiplier scales the cost", () => {
    const fast = FairShareTracker.weightedCost(model, 1000, 500, 100, CODEX_PRIORITY_FAIR_SHARE_MULTIPLIER);
    expect(fast).toBeCloseTo(base * CODEX_PRIORITY_FAIR_SHARE_MULTIPLIER, 6);
  });
  it("guards invalid multiplier (0 / negative / NaN) back to 1x", () => {
    expect(FairShareTracker.weightedCost(model, 1000, 500, 100, 0)).toBe(base);
    expect(FairShareTracker.weightedCost(model, 1000, 500, 100, -3)).toBe(base);
    expect(FairShareTracker.weightedCost(model, 1000, 500, 100, NaN)).toBe(base);
  });
});
