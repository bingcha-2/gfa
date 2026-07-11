import { describe, expect, it } from "vitest";
import { calculateApiValue, type ApiValueUsage } from "./api-pricing";

const AT = Date.parse("2026-07-11T00:00:00Z");

function usage(fields: Partial<ApiValueUsage> = {}): ApiValueUsage {
  return {
    provider: "codex",
    modelId: "gpt-5.6-sol",
    pricingMode: "standard",
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: 0,
    contextTokens: 100_000,
    occurredAt: AT,
    ...fields,
  };
}

describe("API-equivalent pricing", () => {
  it("reproduces the Sol dashboard golden value using the actual model", () => {
    const value = calculateApiValue(usage({
      inputTokens: 593_410,
      cachedInputTokens: 24_470_000,
      outputTokens: 102_560,
    }));

    expect(value.usd).toBeCloseTo(18.27885, 8);
    expect(value).toMatchObject({
      canonicalModelId: "gpt-5.6-sol",
      pricingMode: "standard",
      contextTier: "short",
      quality: "exact",
    });
  });

  it("selects long context per request rather than after aggregation", () => {
    expect(calculateApiValue(usage({ inputTokens: 1_000_000, contextTokens: 271_999 })).usd).toBe(5);
    expect(calculateApiValue(usage({ inputTokens: 1_000_000, contextTokens: 272_000 })).usd).toBe(10);
  });

  it("uses real Standard prices for different GPT models", () => {
    expect(calculateApiValue(usage({ modelId: "gpt-5.6-terra", inputTokens: 1_000_000 })).usd).toBe(2.5);
    expect(calculateApiValue(usage({ modelId: "gpt-5.6-luna", inputTokens: 1_000_000 })).usd).toBe(1);
    expect(calculateApiValue(usage({ modelId: "gpt-5.4-mini-2026-03-17", outputTokens: 1_000_000 })).usd).toBe(4.5);
  });

  it("uses the published Priority table instead of a global multiplier", () => {
    expect(calculateApiValue(usage({ pricingMode: "priority", inputTokens: 1_000_000 })).usd).toBe(10);
    expect(calculateApiValue(usage({ modelId: "gpt-5.5", pricingMode: "priority", inputTokens: 1_000_000 })).usd).toBe(12.5);
    expect(calculateApiValue(usage({ modelId: "gpt-5.4", pricingMode: "priority", inputTokens: 1_000_000 })).usd).toBe(5);
  });

  it("does not invent an exact unpublished Priority long-context price", () => {
    expect(calculateApiValue(usage({
      pricingMode: "priority",
      contextTokens: 300_000,
      inputTokens: 1_000_000,
    }))).toMatchObject({
      usd: 10,
      contextTier: "unknown",
      quality: "unsupported-context",
    });
  });

  it("separates Claude cache read, 5m creation, and 1h creation", () => {
    const value = calculateApiValue(usage({
      provider: "anthropic",
      modelId: "claude-opus-4-8",
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheWrite5mTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000,
      outputTokens: 1_000_000,
    }));

    expect(value.usd).toBe(46.75);
    expect(value.quality).toBe("exact");
  });

  it("marks unknown models instead of presenting fallback as exact", () => {
    const value = calculateApiValue(usage({ modelId: "gpt-future", inputTokens: 1_000_000 }));
    expect(value.usd).toBeGreaterThan(0);
    expect(value.quality).toBe("conservative-fallback");
  });
});
