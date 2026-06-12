/**
 * Client-side catalog pricing — pure, no IO.
 *
 * Mirrors the server's authoritative `computePurchase`
 * (apps/server/src/leasing/plan-catalog/pricing.ts) byte-for-byte so the
 * realtime price the user sees on the purchase page equals what the backend
 * charges. The server stays the source of truth (it recomputes on order
 * creation and 400s on an invalid selection); this is the display mirror.
 *
 * Keep this file in sync with the server pricing.ts. Parity is asserted by
 * src/test/account/catalog-pricing.test.ts using the same fixtures as the
 * server spec.
 */

/** A number shaped as a single account is sliced into; share users → weight. */
const SHARE_CAPACITY = 8;

export interface CatalogUsageTier {
  bucketLimits: Record<string, number>;
  weeklyTokenLimit: number;
}

/** The PUBLISHED PlanCatalog.config, as returned by GET /api/plan-catalog. */
export interface CatalogConfig {
  products: string[];
  levels: Record<string, string[]>;
  usageTiers: Record<string, CatalogUsageTier>;
  pricing: {
    pool: {
      product: Record<string, number>;
      usage: Record<string, number>;
      devicePerExtra: number;
    };
    bind: {
      levelPrice: Record<string, Record<string, number>>;
      share: Record<string, number>;
      devicePerExtra: number;
    };
  };
  durationDays: number;
  windowMs: number;
}

export interface PoolSelection {
  line: "pool";
  products: string[];
  usageTier: string;
  deviceLimit: number;
}

export interface BindItem {
  product: string;
  level: string;
}

export interface BindSelection {
  line: "bind";
  items: BindItem[];
  shareUsers: number;
  deviceLimit: number;
}

export type Selection = PoolSelection | BindSelection;

export interface PurchaseResult {
  priceCents: number;
  config: Record<string, unknown>;
}

export function computePurchase(catalog: CatalogConfig, selection: Selection): PurchaseResult {
  return selection.line === "bind"
    ? computeBind(catalog, selection)
    : computePool(catalog, selection);
}

function computePool(catalog: CatalogConfig, selection: PoolSelection): PurchaseResult {
  const pool = catalog.pricing.pool;
  if (!(selection.usageTier in catalog.usageTiers)) {
    throw new Error(`unknown usage tier "${selection.usageTier}"`);
  }
  let priceCents = 0;
  for (const product of selection.products) priceCents += pool.product[product] ?? 0;
  priceCents += pool.usage[selection.usageTier] ?? 0;
  priceCents += extraDeviceCost(selection.deviceLimit, pool.devicePerExtra);

  const tier = catalog.usageTiers[selection.usageTier];
  return {
    priceCents,
    config: {
      line: "pool",
      products: selection.products,
      bucketLimits: tier.bucketLimits,
      weeklyTokenLimit: tier.weeklyTokenLimit,
      deviceLimit: selection.deviceLimit,
      windowMs: catalog.windowMs,
    },
  };
}

function computeBind(catalog: CatalogConfig, selection: BindSelection): PurchaseResult {
  const bind = catalog.pricing.bind;
  let priceCents = 0;
  const products: string[] = [];
  const levels: Record<string, string> = {};
  for (const { product, level } of selection.items) {
    const price = bind.levelPrice[product]?.[level];
    if (price === undefined) {
      throw new Error(`unknown level "${level}" for product "${product}"`);
    }
    priceCents += price;
    products.push(product);
    levels[product] = level;
  }
  priceCents += bind.share[String(selection.shareUsers)] ?? 0;
  priceCents += extraDeviceCost(selection.deviceLimit, bind.devicePerExtra);

  return {
    priceCents,
    config: {
      line: "bind",
      products,
      levels,
      weight: SHARE_CAPACITY / selection.shareUsers,
      deviceLimit: selection.deviceLimit,
      windowMs: catalog.windowMs,
    },
  };
}

function extraDeviceCost(deviceLimit: number, perExtra: number): number {
  return Math.max(0, deviceLimit - 1) * perExtra;
}
