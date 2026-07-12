import registryJson from "./quota-rates.json";

export type QuotaProvider = "codex" | "anthropic";
export type QuotaRateQuality = "exact" | "conservative-fallback";

export interface QuotaUsage {
  provider: QuotaProvider;
  modelId: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
  serviceTier: "standard" | "fast";
  occurredAt: number;
}

export interface ModelQuotaRate {
  provider: QuotaProvider;
  canonicalModelId: string;
  aliases: string[];
  effectiveFrom: string;
  effectiveUntil?: string;
  inputPerMillion: number;
  cachedInputPerMillion: number;
  cacheWrite5mPerMillion: number;
  cacheWrite1hPerMillion: number;
  outputPerMillion: number;
  fastMultiplier?: number;
}

export type ResolvedQuotaRate = ModelQuotaRate & {
  version: string;
  quality: QuotaRateQuality;
};

type Registry = { version: string; models: ModelQuotaRate[] };
const registry = registryJson as Registry;

function activeAt(rate: ModelQuotaRate, occurredAt: number): boolean {
  const from = Date.parse(rate.effectiveFrom);
  const until = rate.effectiveUntil ? Date.parse(rate.effectiveUntil) : Number.POSITIVE_INFINITY;
  return occurredAt >= from && occurredAt < until;
}

function normalizeModelId(modelId: string): string {
  return String(modelId || "").trim().toLowerCase();
}

function conservativeFallback(provider: QuotaProvider, occurredAt: number): ModelQuotaRate {
  const active = registry.models.filter((rate) => rate.provider === provider && activeAt(rate, occurredAt));
  if (active.length === 0) throw new Error(`No active quota rates for provider ${provider}`);
  const max = (field: keyof Pick<ModelQuotaRate,
    "inputPerMillion" | "cachedInputPerMillion" | "cacheWrite5mPerMillion" | "cacheWrite1hPerMillion" | "outputPerMillion"
  >) => Math.max(...active.map((rate) => rate[field]));
  return {
    provider,
    canonicalModelId: `${provider}-unknown-conservative`,
    aliases: [],
    effectiveFrom: new Date(Math.min(...active.map((rate) => Date.parse(rate.effectiveFrom)))).toISOString(),
    inputPerMillion: max("inputPerMillion"),
    cachedInputPerMillion: max("cachedInputPerMillion"),
    cacheWrite5mPerMillion: max("cacheWrite5mPerMillion"),
    cacheWrite1hPerMillion: max("cacheWrite1hPerMillion"),
    outputPerMillion: max("outputPerMillion"),
    fastMultiplier: Math.max(1, ...active.map((rate) => rate.fastMultiplier || 1)),
  };
}

export function resolveQuotaRate(provider: QuotaProvider, modelId: string, occurredAt: number): ResolvedQuotaRate {
  const normalized = normalizeModelId(modelId);
  const matches = registry.models
    .filter((rate) => rate.provider === provider && activeAt(rate, occurredAt))
    .filter((rate) => rate.canonicalModelId === normalized || rate.aliases.some((alias) => normalizeModelId(alias) === normalized))
    .sort((a, b) => Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom));
  const exact = matches[0];
  return {
    ...(exact || conservativeFallback(provider, occurredAt)),
    version: registry.version,
    quality: exact ? "exact" : "conservative-fallback",
  };
}

function safeTokens(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function calculateQuotaCu(usage: QuotaUsage): {
  cu: number;
  canonicalModelId: string;
  rateVersion: string;
  quality: QuotaRateQuality;
} {
  const rate = resolveQuotaRate(usage.provider, usage.modelId, usage.occurredAt);
  const base = (
    safeTokens(usage.inputTokens) * rate.inputPerMillion
    + safeTokens(usage.cachedInputTokens) * rate.cachedInputPerMillion
    + safeTokens(usage.cacheWrite5mTokens) * rate.cacheWrite5mPerMillion
    + safeTokens(usage.cacheWrite1hTokens) * rate.cacheWrite1hPerMillion
    + safeTokens(usage.outputTokens) * rate.outputPerMillion
  ) / 1_000_000;
  const multiplier = usage.serviceTier === "fast" ? (rate.fastMultiplier || 1) : 1;
  return {
    cu: base * multiplier,
    canonicalModelId: rate.canonicalModelId,
    rateVersion: rate.version,
    quality: rate.quality,
  };
}
