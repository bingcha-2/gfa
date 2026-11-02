import { describe, expect, it } from "vitest";
import { calculateApiValue, type ApiValueUsage } from "./api-pricing";

// https://platform.claude.com/docs/en/about-claude/pricing
// Checked 2026-11-02. Haiku 5.5 is priced by prompt length: a request whose prompt
// (input + cache reads + cache writes) is over 100,000 tokens pays the higher rate
// on every token of that request, output included.
const base: ApiValueUsage = {
  provider: "anthropic", modelId: "claude-haiku-5-5", pricingMode: "standard",
  inputTokens: 0, cachedInputTokens: 0, cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0, outputTokens: 0, contextTokens: 100000,
  occurredAt: Date.parse("2026-11-02T00:00:00Z"),
};

describe("Claude Haiku 5.5 pricing", () => {
  it.each([
    [100000, [0.1, 0.01, 0.125, 0.2, 0.5]],
    [100001, [0.5, 0.05, 0.625, 1, 2.5]],
  ] as const)("context %i uses the matching tier", (contextTokens, prices) => {
    const fields = ["inputTokens", "cachedInputTokens", "cacheWrite5mTokens", "cacheWrite1hTokens", "outputTokens"] as const;
    fields.forEach((field, i) => {
      expect(calculateApiValue({ ...base, contextTokens, [field]: 1e6 }))
        .toMatchObject({ usd: prices[i], quality: "exact", canonicalModelId: "claude-haiku-5-5" });
    });
  });

  it("is priced far below Haiku 4.5, not as a fallback", () => {
    const usage = { ...base, inputTokens: 1e6, outputTokens: 1e6 };
    const v55 = calculateApiValue(usage);
    const v45 = calculateApiValue({ ...usage, modelId: "claude-haiku-4-5" });
    expect(v55.quality).toBe("exact");
    expect(v55.usd).toBeCloseTo(0.6, 9);
    expect(v45.usd).toBe(6);
  });

  it("does not leak the new entry onto other Haiku ids", () => {
    expect(calculateApiValue({ ...base, modelId: "claude-haiku-5-5-pro", inputTokens: 1e6 }).quality)
      .toBe("conservative-fallback");
  });
});
