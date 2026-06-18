// Pure catalog pricing and purchase config generation. No IO.

import type { SupplyPolicyCatalog } from "./unified-entitlement";

export interface UsageTier {
  bucketLimits: Record<string, number>;
  weeklyTokenLimit: number;
}

export interface CatalogConfig extends SupplyPolicyCatalog {
  usageTiers: Record<string, UsageTier>;
  pricing: {
    pool: { product: Record<string, number>; usage: Record<string, number>; devicePerExtra: number };
    bind: { levelPrice: Record<string, Record<string, number>>; share: Record<string, number>; devicePerExtra: number };
  };
  windowMs: number;
  durationDays: number;
  /**
   * Number of purchasable seats in one upstream account. Bind configs store
   * shareSeats directly, and weight equals shareSeats. Non-authoritative
   * callers such as console previews fall back to 8 when it is not injected.
   */
  shareCapacity?: number;
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
  shareSeats?: number;
  /** Legacy pending orders used shareUsers; convert to seats when present. */
  shareUsers?: number;
  /** 独享:独占整个号(份额 100%、别人不得绑入、永不超卖)。占满 shareCapacity 全部席位。 */
  exclusive?: boolean;
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
  const shareCapacity = catalog.shareCapacity ?? 8;
  const exclusive = selection.exclusive === true;
  // 独享:占满整号(shareSeats=shareCapacity),绕过拼车的 SEAT_OPTIONS 校验。
  const share = exclusive ? { shareSeats: shareCapacity } : resolveShareSelection(selection, shareCapacity);
  let fullPriceCents = 0;
  const products: string[] = [];
  const levels: Record<string, string> = {};
  for (const { product, level } of selection.items) {
    const price = bind.levelPrice[product]?.[level];
    if (price === undefined) {
      throw new Error(`unknown level "${level}" for product "${product}"`);
    }
    fullPriceCents += price;
    products.push(product);
    levels[product] = level;
  }
  let priceCents = Math.floor((fullPriceCents * share.shareSeats) / shareCapacity);
  priceCents += bind.share[String(share.shareSeats)] ?? 0;
  priceCents += extraDeviceCost(selection.deviceLimit, bind.devicePerExtra);

  return {
    priceCents,
    config: {
      line: "bind",
      products,
      levels,
      shareSeats: share.shareSeats,
      shareCapacity,
      weight: share.shareSeats,
      exclusive,
      // 绑定线 = 硬绑(pinned):钉死所分配的共用号,由 fair-share 在拼车主人间公平切分该号。
      // (preferred-dynamic 会在池里漂移、不进 fair-share —— 拼车就切不动了。)
      assignmentPolicy: "pinned",
      deviceLimit: selection.deviceLimit,
      windowMs: catalog.windowMs,
    },
  };
}

const SEAT_OPTIONS = [1, 2, 4, 8] as const;

function resolveShareSelection(
  selection: BindSelection,
  shareCapacity: number,
): { shareSeats: number } {
  if (selection.shareSeats !== undefined) {
    const explicit = Number(selection.shareSeats);
    if (isSeatOption(explicit) && explicit <= shareCapacity) {
      return { shareSeats: explicit };
    }
    throw new Error("shareSeats must be one of 1, 2, 4, 8");
  }

  if (selection.shareUsers !== undefined) {
    const legacyUsers = Number(selection.shareUsers);
    if (isSeatOption(legacyUsers)) {
      const converted = Math.max(1, Math.floor(shareCapacity / legacyUsers));
      if (isSeatOption(converted)) {
        return { shareSeats: converted };
      }
    }
  }

  throw new Error("shareSeats must be one of 1, 2, 4, 8");
}

function isSeatOption(value: number): value is (typeof SEAT_OPTIONS)[number] {
  return Number.isInteger(value) && SEAT_OPTIONS.includes(value as (typeof SEAT_OPTIONS)[number]);
}

function extraDeviceCost(deviceLimit: number, perExtra: number): number {
  return Math.max(0, deviceLimit - 1) * perExtra;
}
