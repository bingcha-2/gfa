import pricingJson from "./api-pricing.json";
import type { QuotaProvider } from "./quota-rates";

export type ApiPricingProvider = QuotaProvider | "antigravity";
export type ApiPricingMode = "standard" | "priority";
export type ApiContextTier = "short" | "long" | "unknown";
export type ApiValuationQuality = "exact" | "unsupported-context" | "conservative-fallback";

export interface ApiValueUsage {
  provider: ApiPricingProvider;
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

export interface TokenPrice {
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
}

export interface ApiPriceModel {
  provider: ApiPricingProvider;
  canonicalModelId: string;
  aliases: string[];
  effectiveFrom: string;
  effectiveUntil?: string;
  contextThreshold?: number;
  modes: Partial<Record<ApiPricingMode, Partial<Record<"short" | "long", TokenPrice>>>>;
}

export type ApiPriceRegistry = { version: string; models: ApiPriceModel[]; effectiveAt?: number };
const bundledRegistry = pricingJson as ApiPriceRegistry;
let snapshots: ApiPriceRegistry[] = [];
export function installApiPriceSnapshots(values: ApiPriceRegistry[]) {
  snapshots = [...values].sort((a, b) => (a.effectiveAt || 0) - (b.effectiveAt || 0));
}
export function getApiPriceSnapshots(): ApiPriceRegistry[] { return snapshots; }
export function apiPriceRegistryAt(at: number): ApiPriceRegistry {
  return [...snapshots].reverse().find(s => (s.effectiveAt || 0) <= at) || bundledRegistry;
}

const norm = (value: string) => String(value || "").trim().toLowerCase();
const activeAt = (model: ApiPriceModel, at: number) => at >= Date.parse(model.effectiveFrom)
  && at < (model.effectiveUntil ? Date.parse(model.effectiveUntil) : Number.POSITIVE_INFINITY);
const tokens = (value: number) => Number.isFinite(value) && value > 0 ? value : 0;

function findModel(usage: ApiValueUsage): ApiPriceModel | undefined {
  const registry = apiPriceRegistryAt(usage.occurredAt);
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

export function calculateApiValue(usage: ApiValueUsage): {
  usd: number;
  canonicalModelId: string;
  pricingVersion: string;
  pricingMode: ApiPricingMode;
  contextTier: ApiContextTier;
  quality: ApiValuationQuality;
} {
  const registry = apiPriceRegistryAt(usage.occurredAt);
  const model = findModel(usage);
  let quality: ApiValuationQuality = model ? "exact" : "conservative-fallback";
  let contextTier: ApiContextTier = "short";
  let price: TokenPrice;

  if (!model) {
    price = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    contextTier = "unknown";
  } else {
    const requestedTier = model.contextThreshold != null && usage.contextTokens > model.contextThreshold ? "long" : "short";
    const modePrices = model.modes[usage.pricingMode];
    if (!modePrices) {
      price = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
      contextTier = "unknown";
      quality = "conservative-fallback";
    } else {
      const exactTier = modePrices[requestedTier];
      if (exactTier) {
        price = exactTier;
        contextTier = requestedTier;
      } else {
        price = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
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

/** Unknown prices are never a license to charge a different model's rate. */
export function requireApiValue(usage: ApiValueUsage) {
  const value = calculateApiValue(usage);
  if (value.quality !== "exact") throw new Error(`MODEL_PRICING_UNAVAILABLE: ${usage.provider}/${usage.modelId}/${usage.pricingMode}`);
  return value;
}
export function hasApiPrice(provider: ApiPricingProvider, modelId: string, pricingMode: ApiPricingMode = "standard", at = Date.now(), contextTokens = 0) {
  return calculateApiValue({provider, modelId, pricingMode, occurredAt: at, contextTokens,
    inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0}).quality === "exact";
}
