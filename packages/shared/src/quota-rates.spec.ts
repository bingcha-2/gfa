import { describe, expect, it } from "vitest";
import { calculateQuotaCu, resolveQuotaRate, type QuotaUsage } from "./quota-rates";

const AT = Date.parse("2026-07-11T00:00:00Z");

function usage(modelId: string, fields: Partial<QuotaUsage> = {}): QuotaUsage {
  return {
    provider: "codex",
    modelId,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: 0,
    serviceTier: "standard",
    occurredAt: AT,
    ...fields,
  };
}

describe("quota rate registry", () => {
  it("uses distinct official Codex model credits", () => {
    expect(calculateQuotaCu(usage("gpt-5.6-sol", { inputTokens: 1_000_000 }))).toMatchObject({
      cu: 5,
      canonicalModelId: "gpt-5.6-sol",
      quality: "exact",
    });
    expect(calculateQuotaCu(usage("gpt-5.6-terra", { inputTokens: 1_000_000 })).cu).toBe(2.5);
    expect(calculateQuotaCu(usage("gpt-5.6-luna", { inputTokens: 1_000_000 })).cu).toBe(1);
    expect(calculateQuotaCu(usage("gpt-5.4-mini-2026-03-17", { inputTokens: 1_000_000 })).cu).toBe(0.75);
  });

  it("prices input, cache, cache creation, and output independently", () => {
    const result = calculateQuotaCu(usage("gpt-5.6-sol", {
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheWrite5mTokens: 1_000_000,
      outputTokens: 1_000_000,
    }));

    expect(result.cu).toBe(41.75);
  });

  it("uses model-specific priority multipliers instead of a global fast multiplier", () => {
    expect(calculateQuotaCu(usage("gpt-5.5", {
      inputTokens: 1_000_000,
      serviceTier: "fast",
    })).cu).toBe(12.5);
    expect(calculateQuotaCu(usage("gpt-5.4", {
      inputTokens: 1_000_000,
      serviceTier: "fast",
    })).cu).toBe(5);
    expect(calculateQuotaCu(usage("gpt-5.6-sol", {
      inputTokens: 1_000_000,
      serviceTier: "fast",
    })).cu).toBe(10);
  });

  it("resolves Claude aliases and effective versions", () => {
    expect(resolveQuotaRate("anthropic", "claude-opus-4-8", AT)).toMatchObject({
      canonicalModelId: "claude-opus-4-8",
      inputPerMillion: 5,
      quality: "exact",
    });
    expect(calculateQuotaCu(usage("claude-fable-5", {
      provider: "anthropic",
      inputTokens: 1_000_000,
    })).cu).toBe(10);
    expect(calculateQuotaCu(usage("claude-haiku-4-5", {
      provider: "anthropic",
      outputTokens: 1_000_000,
    })).cu).toBe(5);
  });

  it("resolves dated provider model ids through the longest alias", () => {
    expect(resolveQuotaRate("anthropic", "claude-opus-4-20250514", AT)).toMatchObject({
      canonicalModelId: "claude-opus-4-8",
      inputPerMillion: 5,
      quality: "exact",
    });
    expect(resolveQuotaRate("anthropic", "claude-sonnet-4-20250514", AT)).toMatchObject({
      canonicalModelId: "claude-sonnet-5",
      inputPerMillion: 3,
      quality: "exact",
    });
    expect(resolveQuotaRate("codex", "gpt-5.4-mini-2026-03-17", AT)).toMatchObject({
      canonicalModelId: "gpt-5.4-mini",
      inputPerMillion: 0.75,
      quality: "exact",
    });
  });

  it("resolves registered autocomplete suffix variants without charging the provider maximum", () => {
    expect(resolveQuotaRate("codex", "tab_flash_lite_preview-20260711", AT)).toMatchObject({
      canonicalModelId: "codex-autocomplete",
      inputPerMillion: 0.1,
      quality: "exact",
    });
  });

  it("never silently drops autocomplete or unknown non-zero usage", () => {
    expect(calculateQuotaCu(usage("tab_flash_lite_preview", { inputTokens: 1_000_000 })).cu).toBeGreaterThan(0);

    const unknown = calculateQuotaCu(usage("gpt-future-unknown", { inputTokens: 1_000_000 }));
    expect(unknown.cu).toBeGreaterThan(0);
    expect(unknown.quality).toBe("conservative-fallback");
  });

  it("keeps zero usage at zero even on a fallback model", () => {
    expect(calculateQuotaCu(usage("unknown"))).toMatchObject({
      cu: 0,
      quality: "conservative-fallback",
    });
  });
});
