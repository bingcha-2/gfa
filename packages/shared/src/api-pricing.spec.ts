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
    expect(calculateApiValue(usage({ inputTokens: 1_000_000, contextTokens: 272_000 })).usd).toBe(5);
    expect(calculateApiValue(usage({ inputTokens: 1_000_000, contextTokens: 272_001 })).usd).toBe(10);
  });

  it("uses real Standard prices for different GPT models", () => {
    expect(calculateApiValue(usage({ modelId: "gpt-5.6-terra", inputTokens: 1_000_000 })).usd).toBe(2.5);
    expect(calculateApiValue(usage({ modelId: "gpt-5.6-luna", inputTokens: 1_000_000 })).usd).toBe(1);
    expect(calculateApiValue(usage({ modelId: "gpt-5.4-mini-2026-03-17", outputTokens: 1_000_000 })).usd).toBe(4.5);
    expect(calculateApiValue(usage({ modelId: "gpt-5.4-mini", contextTokens: 1_000_000, inputTokens: 1_000_000 })))
      .toMatchObject({ usd: 0.75, contextTier: "short", quality: "exact" });
    expect(calculateApiValue(usage({ modelId: "gpt-5.3-codex", outputTokens: 1_000_000 })).usd).toBe(14);
    expect(calculateApiValue(usage({ modelId: "gpt-5.2-codex", inputTokens: 1_000_000 })).usd).toBe(1.75);
    expect(calculateApiValue(usage({ modelId: "gpt-5.1-codex-max", inputTokens: 1_000_000 })).usd).toBe(1.25);
    expect(calculateApiValue(usage({ modelId: "gpt-5-codex-mini", outputTokens: 1_000_000 })).usd).toBe(2);
    expect(calculateApiValue(usage({ modelId: "codex-mini-latest", cachedInputTokens: 1_000_000 })).usd).toBe(0.375);
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
      usd: 12.5,
      contextTier: "unknown",
      quality: "unsupported-context",
    });
  });

  it("marks an unpublished model/mode pairing as conservative", () => {
    expect(calculateApiValue(usage({
      modelId: "gpt-5.3-codex",
      pricingMode: "priority",
      inputTokens: 1_000_000,
    }))).toMatchObject({ canonicalModelId: "gpt-5.3-codex", quality: "conservative-fallback" });
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

  it("resolves dated provider model ids through the longest alias", () => {
    expect(calculateApiValue(usage({
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      inputTokens: 1_000_000,
      occurredAt: Date.parse("2026-06-01T00:00:00Z"),
    }))).toMatchObject({ usd: 3, canonicalModelId: "claude-sonnet-4", quality: "exact" });
  });

  it("uses the current Sonnet 5 introductory price without rewriting the post-promotion price", () => {
    expect(calculateApiValue(usage({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      inputTokens: 1_000_000,
    }))).toMatchObject({ usd: 2, quality: "exact" });
    expect(calculateApiValue(usage({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      inputTokens: 1_000_000,
      occurredAt: Date.parse("2026-09-01T00:00:00Z"),
    }))).toMatchObject({ usd: 3, quality: "exact" });
  });

  it("keeps expensive historical Opus models separate from current Opus", () => {
    expect(calculateApiValue(usage({
      provider: "anthropic",
      modelId: "claude-opus-4-1-20250805",
      outputTokens: 1_000_000,
    }))).toMatchObject({ usd: 75, canonicalModelId: "claude-opus-4-1", quality: "exact" });
    expect(calculateApiValue(usage({
      provider: "anthropic",
      modelId: "claude-opus-4-6-thinking",
      outputTokens: 1_000_000,
    }))).toMatchObject({ usd: 25, canonicalModelId: "claude-opus-4-6", quality: "exact" });
  });

  it("does not mislabel an unpublished product variant as an exact snapshot", () => {
    expect(calculateApiValue(usage({
      modelId: "gpt-5.3-codex-spark",
      inputTokens: 1_000_000,
    }))).toMatchObject({ canonicalModelId: "codex-unknown-conservative", quality: "conservative-fallback" });
    expect(calculateApiValue(usage({
      provider: "anthropic",
      modelId: "claude-sonnet-4-20990101",
      inputTokens: 1_000_000,
    }))).toMatchObject({ canonicalModelId: "anthropic-unknown-conservative", quality: "conservative-fallback" });
  });

  it("marks unknown models instead of presenting fallback as exact", () => {
    const value = calculateApiValue(usage({ modelId: "gpt-future", inputTokens: 1_000_000 }));
    expect(value.usd).toBeGreaterThan(0);
    expect(value.quality).toBe("conservative-fallback");
  });
});
