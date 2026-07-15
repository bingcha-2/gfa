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
  const aliasMatchLength = (aliasValue: string) => {
    const alias = norm(aliasValue);
    if (id === alias) return alias.length;
    // Provider snapshots append a date to a stable model id. Do not accept an
    // arbitrary suffix here: product variants such as `-spark` can have a
    // different (or unpublished) rate and must fall back conservatively.
    if (!id.startsWith(`${alias}-`)) return 0;
    const suffix = id.slice(alias.length);
    return /^-(?:\d{8}|\d{4}-\d{2}-\d{2})(?:$|[-.])/.test(suffix) ? alias.length : 0;
  };
  const matchLength = (model: ApiPriceModel) => [model.canonicalModelId, ...model.aliases]
    .reduce((longest, alias) => Math.max(longest, aliasMatchLength(alias)), 0);
  return registry.models
    .filter((model) => model.provider === usage.provider && activeAt(model, usage.occurredAt))
    .filter((model) => matchLength(model) > 0)
    .sort((a, b) => matchLength(b) - matchLength(a) || Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom))[0];
}

// Fallback pricing for an unrecognized / variant / newly-minted model id. We
// price it as the provider's current FLAGSHIP model — NOT the max across every
// active SKU. A soon-to-expire legacy premium (e.g. opus-4-1 $15/$75, active
// until 2026-08-05) must not punish routine model-id churn (-thinking/-preview
// suffixes, next-gen ids not yet in the snapshot) with a 3-5x quota burn.
const FALLBACK_MODEL_IDS: Partial<Record<QuotaProvider, string>> = {
  anthropic: "claude-opus-4-8",
  codex: "gpt-5.6-sol",
};

function priceEnvelope(prices: TokenPrice[]): TokenPrice {
  const max = (field: keyof TokenPrice) => Math.max(...prices.map((price) => price[field]));
  return {
    input: max("input"),
    cacheRead: max("cacheRead"),
    cacheWrite5m: max("cacheWrite5m"),
    cacheWrite1h: max("cacheWrite1h"),
    output: max("output"),
  };
}

// The flagship model's own price for `mode`, picking its short/long tier by the
// request's context size. Anthropic has no Priority tier, so fall back to the
// flagship's Standard rate rather than another model's.
function flagshipPrice(
  provider: QuotaProvider,
  mode: ApiPricingMode,
  at: number,
  contextTokens: number,
): TokenPrice | undefined {
  const flagshipId = FALLBACK_MODEL_IDS[provider];
  if (!flagshipId) return undefined;
  const model = registry.models.find((candidate) => candidate.provider === provider
    && activeAt(candidate, at)
    && [candidate.canonicalModelId, ...candidate.aliases].some((alias) => norm(alias) === norm(flagshipId)));
  if (!model) return undefined;
  const modePrices = model.modes[mode] || (mode !== "standard" ? model.modes.standard : undefined);
  if (!modePrices) return undefined;
  const tier = model.contextThreshold != null && contextTokens > model.contextThreshold ? "long" : "short";
  return modePrices[tier] || modePrices.short || modePrices.long;
}

function conservativePrice(usage: ApiValueUsage): TokenPrice {
  const { provider, pricingMode: mode, occurredAt: at } = usage;
  const flagship = flagshipPrice(provider, mode, at, tokens(usage.contextTokens));
  if (flagship) return flagship;
  // Defensive: no flagship configured / active / priced for this mode. Never
  // throw or return $0 — fall back to the highest active rate as before.
  let prices = registry.models
    .filter((model) => model.provider === provider && activeAt(model, at))
    .flatMap((model) => Object.values(model.modes[mode] || {}))
    .filter((price): price is TokenPrice => Boolean(price));
  if (prices.length === 0 && mode !== "standard") {
    prices = registry.models
      .filter((model) => model.provider === provider && activeAt(model, at))
      .flatMap((model) => Object.values(model.modes.standard || {}))
      .filter((price): price is TokenPrice => Boolean(price));
  }
  if (prices.length === 0) throw new Error(`No API pricing for ${provider}/${mode}`);
  return priceEnvelope(prices);
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
    price = conservativePrice(usage);
    contextTier = "unknown";
  } else {
    const requestedTier = model.contextThreshold != null && usage.contextTokens > model.contextThreshold ? "long" : "short";
    const modePrices = model.modes[usage.pricingMode];
    if (!modePrices) {
      price = conservativePrice(usage);
      contextTier = "unknown";
      quality = "conservative-fallback";
    } else {
      const exactTier = modePrices[requestedTier];
      if (exactTier) {
        price = exactTier;
        contextTier = requestedTier;
      } else {
        price = conservativePrice(usage);
        contextTier = "unknown";
        quality = "unsupported-context";
      }
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
