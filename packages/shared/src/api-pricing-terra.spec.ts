import { describe, expect, it } from "vitest";
import { calculateApiValue, type ApiValueUsage } from "./api-pricing";

// https://developers.openai.com/api/docs/models/gpt-6.1-terra
// Checked 2026-10-27. Codex uses the existing standard cache-write bucket;
// extended (12-hour) cache retention is not represented by this registry.
const base: ApiValueUsage = {
  provider: "codex", modelId: "gpt-6.1-terra", pricingMode: "standard",
  inputTokens: 0, cachedInputTokens: 0, cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0, outputTokens: 0, contextTokens: 272000,
  occurredAt: Date.parse("2026-10-27T00:00:00Z"),
};

describe("GPT-6.1 Terra pricing", () => {
  it.each([
    ["standard", 272000, [1, 0.05, 1.25, 1.25, 5]],
    ["standard", 272001, [2, 0.1, 2.5, 2.5, 7.5]],
    ["priority", 272000, [2, 0.1, 2.5, 2.5, 10]],
    ["priority", 272001, [4, 0.2, 5, 5, 15]],
  ] as const)("%s at context %i", (pricingMode, contextTokens, prices) => {
    const fields = ["inputTokens", "cachedInputTokens", "cacheWrite5mTokens", "cacheWrite1hTokens", "outputTokens"] as const;
    fields.forEach((field, i) => {
      expect(calculateApiValue({ ...base, pricingMode, contextTokens, [field]: 1e6 }))
        .toMatchObject({ usd: prices[i], quality: "exact", canonicalModelId: "gpt-6.1-terra" });
    });
  });

  it("keeps previous-generation, pre-release and unknown-variant pricing separate", () => {
    expect(calculateApiValue({ ...base, modelId: "gpt-5.6-terra", inputTokens: 1e6 }).usd).toBe(2.5);
    expect(calculateApiValue({ ...base, occurredAt: Date.parse("2026-10-25T00:00:00Z") }).quality)
      .toBe("conservative-fallback");
    expect(calculateApiValue({ ...base, modelId: "gpt-6.1-terra-pro" }).quality)
      .toBe("conservative-fallback");
  });
});
