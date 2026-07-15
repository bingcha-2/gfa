import { API_USD_QUOTA_PER_SEAT_DEFAULTS, cheapestApiUsdLevel } from "@gfa/shared";

import type { CatalogConfig } from "../plan-catalog/pricing";
import { accountCapacity, oversellCeiling } from "../plan-catalog/unified-entitlement";
import { supportsApiUsdProduct } from "../token-server/api-usd-quota";
import { ACCOUNT_SHARE_CAPACITY } from "../token-server/token-billing";

export const SUBSCRIPTION_USD_MIGRATION_VERSION = 5;

export interface SubscriptionUsdMigrationOptions {
  /** Publishing a catalog intentionally updates every existing subscription. */
  forceCatalogRefresh?: boolean;
  catalogVersion?: number;
}

export type SubscriptionUsdMigrationResult = {
  changed: boolean;
  config: Record<string, any>;
  products: string[];
};

function finiteNonNegative(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function positiveInteger(value: unknown, fallback: number): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function scaledPerSeat(value: number, seats: number): number {
  return Math.round((finiteNonNegative(value) * seats) * 1_000_000) / 1_000_000;
}

function configuredProducts(config: Record<string, any>): string[] {
  const sources = [
    ...(Array.isArray(config.products) ? config.products : []),
    ...Object.keys(config.levels && typeof config.levels === "object" ? config.levels : {}),
    ...Object.keys(config.bindings && typeof config.bindings === "object" ? config.bindings : {}),
  ];
  return [...new Set(sources.map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
}

function defaultLevel(product: string, config: Record<string, any>, catalog?: Partial<CatalogConfig> | null): string {
  const explicit = String(config.levels?.[product] || "").trim();
  if (explicit) return explicit;
  const fromPolicy = String(catalog?.supplyPolicies?.[product]?.defaultLevel || "").trim();
  // No recorded level and no catalog default → fall back to the CHEAPEST tier,
  // never the top tier. A level-less legacy row must not be gifted max-20x/pro.
  return fromPolicy || cheapestApiUsdLevel(product);
}

function perSeatQuota(
  product: string,
  level: string,
  catalog?: Partial<CatalogConfig> | null,
  legacyDivisor = 1,
): { fiveHour: number; weekly: number } {
  const current = catalog?.pricing?.bind?.usdQuotaPerSeat?.[product]?.[level];
  if (current) {
    return {
      fiveHour: finiteNonNegative(current.fiveHour),
      weekly: finiteNonNegative(current.weekly),
    };
  }
  const legacy = catalog?.pricing?.bind?.usdQuota?.[product]?.[level];
  if (legacy) {
    return {
      fiveHour: finiteNonNegative(legacy.fiveHour) / legacyDivisor,
      weekly: finiteNonNegative(legacy.weekly) / legacyDivisor,
    };
  }
  // An explicitly published zero is intentional, so the fallback is selected
  // by the absence of the level entry rather than by positive-value checks.
  const quota = API_USD_QUOTA_PER_SEAT_DEFAULTS[product]?.[level]
    ?? API_USD_QUOTA_PER_SEAT_DEFAULTS[product]?.[cheapestApiUsdLevel(product)];
  return {
    fiveHour: finiteNonNegative(quota?.fiveHour),
    weekly: finiteNonNegative(quota?.weekly),
  };
}

/**
 * One-way, idempotent rollout migration for bind/carpool subscriptions.
 *
 * - Codex/Claude products each get an independent API-equivalent USD limit.
 * - Version 2 full-account allocations are replaced once by per-share values.
 * - Publishing a catalog can force-refresh every existing subscription.
 * - Manual per-subscription edits survive restarts until the next
 *   catalog publish, while used USD and window timestamps remain untouched.
 * - Version 5 refreshes prior built-in estimates without overwriting an
 *   already valid manual per-product quota.
 * - Antigravity is deliberately excluded and keeps its legacy bucket/fair-share
 *   algorithm even when it shares a subscription with Codex/Claude.
 */
export function migrateBindSubscriptionToUsd(
  input: Record<string, any>,
  catalog?: Partial<CatalogConfig> | null,
  options: SubscriptionUsdMigrationOptions = {},
): SubscriptionUsdMigrationResult {
  const config = { ...(input || {}) };
  const bindingProducts = Object.entries(
    config.bindings && typeof config.bindings === "object" ? config.bindings : {},
  )
    .filter(([, accountId]) => Number(accountId) > 0)
    .map(([product]) => String(product).trim().toLowerCase());
  const inferredLegacyBind = bindingProducts.some(supportsApiUsdProduct);
  const explicitLine = String(config.line || "").trim();
  if ((explicitLine && explicitLine !== "bind") || (!explicitLine && !inferredLegacyBind)) {
    return { changed: false, config, products: [] };
  }
  // Very early subscriptions carried bindings but no line discriminator.
  // Treat that durable mother-account assignment as authoritative bind intent.
  if (!config.line && inferredLegacyBind) config.line = "bind";

  const products = configuredProducts(config).filter(supportsApiUsdProduct);
  if (products.length === 0) return { changed: false, config, products: [] };

  const capacity = accountCapacity(catalog ?? {}, positiveInteger(config.shareCapacity ?? catalog?.shareCapacity, ACCOUNT_SHARE_CAPACITY));
  const seats = Math.min(
    capacity,
    positiveInteger(config.shareSeats ?? config.weight, 1),
  );
  const exclusive = config.exclusive === true || seats >= capacity;
  const legacySeatCapacity = Math.max(
    0,
    ...products.map((product) => positiveInteger(config.salesSeatCapacity?.[product], 0)),
  );
  // New purchases snapshot this denominator. Preserve it so a later catalog
  // oversell change never rewrites an existing subscription's fixed quota.
  const quotaSeatCapacity = exclusive
    ? capacity
    : positiveInteger(
        config.quotaSeatCapacity,
        legacySeatCapacity || oversellCeiling(catalog ?? {}, capacity),
      );
  const usdQuotaByProduct: Record<string, { fiveHour: number; weekly: number }> = {};
  for (const product of products) {
    const quota = perSeatQuota(
      product,
      defaultLevel(product, config, catalog),
      catalog,
      oversellCeiling(catalog ?? {}, capacity),
    );
    usdQuotaByProduct[product] = {
      fiveHour: scaledPerSeat(quota.fiveHour, seats),
      weekly: scaledPerSeat(quota.weekly, seats),
    };
  }

  const requiresPerSeatUpgrade = Number(config.usdQuotaMigrationVersion || 0) < SUBSCRIPTION_USD_MIGRATION_VERSION;
  const hasProductQuota = config.usdQuotaByProduct
    && typeof config.usdQuotaByProduct === "object";
  const preserveManualQuota = config.usdQuotaSource === "manual" && hasProductQuota;
  const previousCatalogVersion = Number(config.usdQuotaCatalogVersion);
  const publishedCatalogChanged = options.catalogVersion !== undefined
    && Number.isFinite(previousCatalogVersion)
    && previousCatalogVersion !== options.catalogVersion;
  const shouldRefresh = options.forceCatalogRefresh
    || (requiresPerSeatUpgrade && !preserveManualQuota)
    || publishedCatalogChanged
    || !hasProductQuota;
  if (shouldRefresh) {
    config.usdQuotaByProduct = usdQuotaByProduct;
    config.usdQuotaSource = "catalog";
    if (options.catalogVersion !== undefined) config.usdQuotaCatalogVersion = options.catalogVersion;
  }
  config.shareCapacity = capacity;
  config.quotaSeatCapacity = quotaSeatCapacity;
  delete config.salesSeatCapacity;
  config.quotaAlgorithm = "usd";
  delete config.usdLimit5h;
  delete config.usdLimitWeekly;
  delete config.usdQuotaProducts;
  config.usdQuotaMigrationVersion = SUBSCRIPTION_USD_MIGRATION_VERSION;

  return {
    changed: JSON.stringify(config) !== JSON.stringify(input || {}),
    config,
    products,
  };
}
