import pricingJson from "./api-pricing.json";
import type { QuotaProvider } from "./quota-rates";

export type ApiPricingMode = "standard" | "priority";
export type ApiContextTier = "short" | "long" | "unknown";
export type ApiValuationQuality = "exact" | "unsupported-context" | "conservative-fallback";

export interface ApiValueUsage {
  provider: QuotaProvider;
  modelId: string;
  pricingMode: ApiPricingMode;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
  contextTokens: number;
  occurredAt: number;
}

interface TokenPrice {
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
}

interface ApiPriceModel {
  provider: QuotaProvider;
  canonicalModelId: string;
  aliases: string[];
  effectiveFrom: string;
  effectiveUntil?: string;
  contextThreshold?: number;
  modes: Partial<Record<ApiPricingMode, Partial<Record<"short" | "long", TokenPrice>>>>;
}

type Registry = { version: string; models: ApiPriceModel[] };
const registry = pricingJson as Registry;

const norm = (value: string) => String(value || "").trim().toLowerCase();
const activeAt = (model: ApiPriceModel, at: number) => at >= Date.parse(model.effectiveFrom)
  && at < (model.effectiveUntil ? Date.parse(model.effectiveUntil) : Number.POSITIVE_INFINITY);
const tokens = (value: number) => Number.isFinite(value) && value > 0 ? value : 0;

function findModel(usage: ApiValueUsage): ApiPriceModel | undefined {
  const id = norm(usage.modelId);
  return registry.models
    .filter((model) => model.provider === usage.provider && activeAt(model, usage.occurredAt))
    .filter((model) => norm(model.canonicalModelId) === id || model.aliases.some((alias) => norm(alias) === id))
    .sort((a, b) => Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom))[0];
}

function conservativePrice(provider: QuotaProvider, mode: ApiPricingMode, at: number): TokenPrice {
  const prices = registry.models
    .filter((model) => model.provider === provider && activeAt(model, at))
    .flatMap((model) => Object.values(model.modes[mode] || {}))
    .filter((price): price is TokenPrice => Boolean(price));
  if (prices.length === 0) throw new Error(`No API pricing for ${provider}/${mode}`);
  const max = (field: keyof TokenPrice) => Math.max(...prices.map((price) => price[field]));
  return {
    input: max("input"),
    cacheRead: max("cacheRead"),
    cacheWrite5m: max("cacheWrite5m"),
    cacheWrite1h: max("cacheWrite1h"),
    output: max("output"),
  };
}

export function calculateApiValue(usage: ApiValueUsage): {
  usd: number;
  canonicalModelId: string;
  pricingVersion: string;
  pricingMode: ApiPricingMode;
  contextTier: ApiContextTier;
  quality: ApiValuationQuality;
} {
  const model = findModel(usage);
  let quality: ApiValuationQuality = model ? "exact" : "conservative-fallback";
  let contextTier: ApiContextTier = "short";
  let price: TokenPrice;

  if (!model) {
    price = conservativePrice(usage.provider, usage.pricingMode, usage.occurredAt);
    contextTier = "unknown";
  } else {
    const requestedTier = model.contextThreshold != null && usage.contextTokens >= model.contextThreshold ? "long" : "short";
    const modePrices = model.modes[usage.pricingMode] || model.modes.standard;
    const exactTier = modePrices?.[requestedTier];
    if (exactTier) {
      price = exactTier;
      contextTier = requestedTier;
    } else {
      const short = modePrices?.short || model.modes.standard?.short;
      if (!short) throw new Error(`No usable API pricing for ${model.canonicalModelId}`);
      price = short;
      contextTier = "unknown";
      quality = "unsupported-context";
    }
  }

  const usd = (
    tokens(usage.inputTokens) * price.input
    + tokens(usage.cachedInputTokens) * price.cacheRead
    + tokens(usage.cacheWrite5mTokens) * price.cacheWrite5m
    + tokens(usage.cacheWrite1hTokens) * price.cacheWrite1h
    + tokens(usage.outputTokens) * price.output
  ) / 1_000_000;

  return {
    usd,
    canonicalModelId: model?.canonicalModelId || `${usage.provider}-unknown-conservative`,
    pricingVersion: registry.version,
    pricingMode: usage.pricingMode,
    contextTier,
    quality,
  };
}
