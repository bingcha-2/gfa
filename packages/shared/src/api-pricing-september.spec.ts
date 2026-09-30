import { describe, expect, it } from "vitest";
import { calculateApiValue, type ApiValueUsage } from "./api-pricing";

// Official OpenAI and Anthropic pricing, checked 2026-09-30.
const base: ApiValueUsage = {
  provider: "codex", modelId: "gpt-6.1-sol", pricingMode: "standard",
  inputTokens: 0, cachedInputTokens: 0, cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0, outputTokens: 0, contextTokens: 272000,
  occurredAt: Date.parse("2026-09-30T00:00:00Z"),
};
describe("September model prices", () => {
  it.each([
    ["standard", 272000, [2, 0.1, 2.5, 2.5, 10]],
    ["standard", 272001, [4, 0.2, 5, 5, 15]],
    ["priority", 272000, [4, 0.2, 5, 5, 20]],
    ["priority", 272001, [8, 0.4, 10, 10, 30]],
  ] as const)("GPT-6.1 Sol %s context %i", (pricingMode, contextTokens, prices) => {
    const fields = ["inputTokens", "cachedInputTokens", "cacheWrite5mTokens", "cacheWrite1hTokens", "outputTokens"] as const;
    fields.forEach((field, i) => expect(calculateApiValue({...base, pricingMode, contextTokens, [field]: 1e6}))
      .toMatchObject({usd: prices[i], quality: "exact", canonicalModelId: "gpt-6.1-sol"}));
  });
  it.each([
    ["claude-sonnet-5-5", [2, 0.2, 2.5, 4, 10]],
    ["claude-opus-5-5", [4, 0.2, 5, 8, 20]],
    ["claude-fable-5-1", [10, 0.25, 12.5, 20, 50]],
    ["claude-opus-5", [5, 0.5, 6.25, 10, 25]],
  ] as const)("Claude %s cache and long context prices", (modelId, prices) => {
    const fields = ["inputTokens", "cachedInputTokens", "cacheWrite5mTokens", "cacheWrite1hTokens", "outputTokens"] as const;
    fields.forEach((field, i) => expect(calculateApiValue({...base, provider:"anthropic", modelId, contextTokens:1e6, [field]:1e6}))
      .toMatchObject({usd:prices[i],quality:"exact",canonicalModelId:modelId}));
  });
  it("does not confuse Sol generations, unreleased usage, or arbitrary suffixes", () => {
    expect(calculateApiValue({...base, modelId:"gpt-6-sol",cachedInputTokens:1e6}).usd).toBe(0.2);
    expect(calculateApiValue({...base, occurredAt:Date.parse("2026-09-28T00:00:00Z")}).quality).toBe("conservative-fallback");
    expect(calculateApiValue({...base, modelId:"gpt-6.1-sol-pro"}).quality).toBe("conservative-fallback");
  });
});
