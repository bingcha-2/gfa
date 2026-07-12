import { calculateQuotaCu, type QuotaProvider } from "@gfa/shared";

export interface FairShareUsageEvent {
  reportId: string;
  provider: QuotaProvider;
  accountId: number;
  quotaSubjectId: string;
  modelId: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
  serviceTier: "standard" | "fast";
  requestStartedAt: number;
  upstreamCompletedAt: number;
  arrivedAt: number;
}

export type CalculatedFairShareUsage = FairShareUsageEvent & ReturnType<typeof calculateQuotaCu>;

export function calculateFairShareCu(event: FairShareUsageEvent): CalculatedFairShareUsage {
  return {
    ...event,
    ...calculateQuotaCu({
      provider: event.provider,
      modelId: event.modelId,
      inputTokens: event.inputTokens,
      cachedInputTokens: event.cachedInputTokens,
      cacheWrite5mTokens: event.cacheWrite5mTokens,
      cacheWrite1hTokens: event.cacheWrite1hTokens,
      outputTokens: event.outputTokens,
      serviceTier: event.serviceTier,
      occurredAt: event.upstreamCompletedAt,
    }),
  };
}
