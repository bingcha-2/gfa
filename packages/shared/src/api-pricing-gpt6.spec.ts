import { describe, expect, it } from "vitest";
import { calculateApiValue, type ApiValueUsage } from "./api-pricing";

// Official Standard / Fast prices, verified 2026-09-23:
// https://developers.openai.com/api/docs/pricing
// Released 2026-09-22: https://developers.openai.com/api/docs/changelog
const launch = Date.parse("2026-09-22T00:00:00Z");
const usage = (fields: Partial<ApiValueUsage>): ApiValueUsage => ({
  provider: "codex", modelId: "gpt-6-sol", pricingMode: "standard",
  inputTokens: 0, cachedInputTokens: 0, cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0, outputTokens: 0, contextTokens: 272_000,
  occurredAt: launch, ...fields,
});

describe("GPT-6 Sol and Luna billing", () => {
  it.each([
    ["gpt-6-sol", "standard", 272_000, [2, 0.2, 2.5, 2.5, 10]],
    ["gpt-6-sol", "standard", 272_001, [4, 0.4, 5, 5, 15]],
    ["gpt-6-sol", "priority", 272_000, [4, 0.4, 5, 5, 20]],
    ["gpt-6-sol", "priority", 272_001, [8, 0.8, 10, 10, 30]],
    ["gpt-6-luna", "standard", 272_000, [0.1, 0.01, 0.125, 0.125, 0.5]],
    ["gpt-6-luna", "standard", 272_001, [0.2, 0.02, 0.25, 0.25, 0.75]],
    ["gpt-6-luna", "priority", 272_000, [0.2, 0.02, 0.25, 0.25, 1]],
    ["gpt-6-luna", "priority", 272_001, [0.4, 0.04, 0.5, 0.5, 1.5]],
  ] as const)("prices %s %s at context %i", (modelId, pricingMode, contextTokens, rates) => {
    const fields = ["inputTokens", "cachedInputTokens", "cacheWrite5mTokens", "cacheWrite1hTokens", "outputTokens"] as const;
    fields.forEach((field, index) => {
      expect(calculateApiValue(usage({ modelId, pricingMode, contextTokens, [field]: 1_000_000 })))
        .toMatchObject({ usd: rates[index], canonicalModelId: modelId, quality: "exact",
          contextTier: contextTokens > 272_000 ? "long" : "short", pricingVersion: "api-pricing-2026-09-23" });
    });
  });

  it.each(["gpt-6-sol", "gpt-6-luna"])("matches %s snapshots and respects launch date", (modelId) => {
    const base = usage({ modelId, inputTokens: 1_000_000 });
    expect(calculateApiValue({ ...base, modelId: `${modelId}-2026-09-22` })).toEqual(calculateApiValue(base));
    expect(calculateApiValue({ ...base, occurredAt: launch - 1 }).quality).toBe("conservative-fallback");
    expect(calculateApiValue({ ...base, modelId: `${modelId}-pro` }).quality).toBe("conservative-fallback");
  });
});
