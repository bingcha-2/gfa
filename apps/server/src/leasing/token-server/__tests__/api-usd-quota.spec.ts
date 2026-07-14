import { describe, expect, it } from "vitest";

import { apiValueUsdForEvent } from "../api-usd-quota";

describe("apiValueUsdForEvent", () => {
  it("prices Claude 5m and 1h cache creation separately", () => {
    expect(apiValueUsdForEvent({
      product: "anthropic", modelKey: "claude-opus-4-8",
      inputTokens: 200_000, cacheWrite5mTokens: 100_000, cacheWrite1hTokens: 100_000,
      outputTokens: 0, contextTokens: 200_000,
    })).toBeCloseTo(1.625);
  });

  it("prices the canonical gross Anthropic event without double-counting its subsets", () => {
    expect(apiValueUsdForEvent({
      product: "anthropic", modelKey: "claude-opus-4-8",
      inputTokens: 500_000, cachedInputTokens: 100_000,
      cacheWrite5mTokens: 100_000, cacheWrite1hTokens: 100_000,
      outputTokens: 0, contextTokens: 500_000,
    })).toBeCloseTo(2.675); // $1 input + $0.05 read + $0.625 5m + $1 1h
  });

  it("treats Codex cached input as a subset of gross input", () => {
    expect(apiValueUsdForEvent({
      product: "codex", modelKey: "gpt-5.6-sol",
      inputTokens: 1_000_000, cachedInputTokens: 800_000,
      outputTokens: 0, contextTokens: 100_000,
    })).toBeCloseTo(1.4); // 200k × $5 + 800k × $0.5
  });

  it("uses the Codex long-context tier when context crosses 272k", () => {
    const short = apiValueUsdForEvent({
      product: "codex", modelKey: "gpt-5.6-sol", inputTokens: 1_000_000,
      outputTokens: 0, contextTokens: 271_999,
    });
    const long = apiValueUsdForEvent({
      product: "codex", modelKey: "gpt-5.6-sol", inputTokens: 1_000_000,
      outputTokens: 0, contextTokens: 272_001,
    });
    expect(short).toBe(5);
    expect(long).toBe(10);
  });
});
