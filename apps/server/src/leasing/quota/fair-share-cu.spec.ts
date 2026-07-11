import { describe, expect, it } from "vitest";
import { calculateFairShareCu, type FairShareUsageEvent } from "./fair-share-cu";

const AT = Date.parse("2026-07-11T00:00:00Z");

function event(fields: Partial<FairShareUsageEvent> = {}): FairShareUsageEvent {
  return {
    reportId: "report-1",
    provider: "codex",
    accountId: 1,
    quotaSubjectId: "subject-1",
    modelId: "gpt-5.6-luna",
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: 0,
    serviceTier: "standard",
    requestStartedAt: AT - 1_000,
    upstreamCompletedAt: AT,
    arrivedAt: AT + 1_000,
    ...fields,
  };
}

describe("calculateFairShareCu", () => {
  it("counts every non-zero usage dimension", () => {
    expect(calculateFairShareCu(event({
      modelId: "gpt-5.6-sol",
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheWrite5mTokens: 1_000_000,
      outputTokens: 1_000_000,
    })).cu).toBe(41.75);
  });

  it("returns zero only when upstream usage is zero", () => {
    expect(calculateFairShareCu(event()).cu).toBe(0);
    expect(calculateFairShareCu(event({ modelId: "unknown", outputTokens: 1 })).cu).toBeGreaterThan(0);
  });

  it("does not skip autocomplete usage", () => {
    expect(calculateFairShareCu(event({ modelId: "tab_flash_lite_preview", inputTokens: 10_000 })).cu).toBeGreaterThan(0);
  });

  it("keeps event identity and causal timestamps with the result", () => {
    expect(calculateFairShareCu(event())).toMatchObject({
      reportId: "report-1",
      accountId: 1,
      quotaSubjectId: "subject-1",
      requestStartedAt: AT - 1_000,
      upstreamCompletedAt: AT,
      arrivedAt: AT + 1_000,
    });
  });
});
