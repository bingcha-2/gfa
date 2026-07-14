// Pure catalog pricing and purchase config generation. No IO.

import { accountCapacity, oversellCeiling, type SupplyPolicyCatalog } from "./unified-entitlement";
import { supportsApiUsdProduct } from "../token-server/api-usd-quota";

export interface UsageTier {
  bucketLimits: Record<string, number>;
  weeklyTokenLimit: number;
}

export interface CatalogConfig extends SupplyPolicyCatalog {
  usageTiers: Record<string, UsageTier>;
  pricing: {
    pool: { product: Record<string, number>; usage: Record<string, number>; devicePerExtra: number };
    bind: {
      levelPrice: Record<string, Record<string, number>>;
      /** API-equivalent USD quota for one purchased share. */
      usdQuotaPerSeat?: Record<string, Record<string, { fiveHour: number; weekly: number }>>;
      /** Legacy full-account quota; converted once during catalog migration. */
      usdQuota?: Record<string, Record<string, { fiveHour: number; weekly: number }>>;
      share: Record<string, number>;
      devicePerExtra: number;
    };
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
  const shareCapacity = accountCapacity(catalog, catalog.shareCapacity ?? 8);
  // 独享:占满整号(shareSeats=shareCapacity),绕过拼车的 SEAT_OPTIONS 校验。
  const share = selection.exclusive === true ? { shareSeats: shareCapacity } : resolveShareSelection(selection, shareCapacity);
  // 满容量即独享:显式勾选,或 shareSeats 买满 shareCapacity(占满整号份数)→ 标 exclusive。
  // 与展示层 access-key-store.isExclusiveCard(weight≥容量)同口径。只是营销标签,不锁号(仍可超卖)。
  const exclusive = selection.exclusive === true || share.shareSeats >= shareCapacity;
  // quotaSeatCapacity only caps sales. Personal USD quota is configured per
  // share and never divided by account capacity or the oversell factor.
  const quotaSeatCapacity = exclusive ? shareCapacity : oversellCeiling(catalog, shareCapacity);
  let fullPriceCents = 0;
  const usdQuotaByProduct: Record<string, { fiveHour: number; weekly: number }> = {};
  const products: string[] = [];
  const levels: Record<string, string> = {};
  for (const { product, level } of selection.items) {
    const price = bind.levelPrice[product]?.[level];
    if (price === undefined) {
      throw new Error(`unknown level "${level}" for product "${product}"`);
    }
    fullPriceCents += price;
    const quota = bind.usdQuotaPerSeat?.[product]?.[level]
      ?? legacyPerSeatQuota(bind.usdQuota?.[product]?.[level], oversellCeiling(catalog, shareCapacity));
    if (!supportsApiUsdProduct(product) && (positiveAmount(quota?.fiveHour) > 0 || positiveAmount(quota?.weekly) > 0)) {
      throw new Error(`API-equivalent USD quota is not supported for product "${product}"`);
    }
    if (supportsApiUsdProduct(product) && (positiveAmount(quota?.fiveHour) > 0 || positiveAmount(quota?.weekly) > 0)) {
      usdQuotaByProduct[product] = {
        fiveHour: scalePerSeatQuota(positiveAmount(quota?.fiveHour), share.shareSeats),
        weekly: scalePerSeatQuota(positiveAmount(quota?.weekly), share.shareSeats),
      };
    }
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
      ...(Object.keys(usdQuotaByProduct).length > 0 ? { quotaSeatCapacity } : {}),
      weight: share.shareSeats,
      exclusive,
      ...(Object.keys(usdQuotaByProduct).length > 0 ? { quotaAlgorithm: "usd", usdQuotaByProduct } : {}),
      // 绑定线固定路由到所分配的母号。Codex/Claude 由订阅美元额度
      // 限流；Antigravity 继续使用旧 token bucket/fair-share。
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

function positiveAmount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function legacyPerSeatQuota(
  quota: { fiveHour: number; weekly: number } | undefined,
  sellableShares: number,
): { fiveHour: number; weekly: number } | undefined {
  if (!quota) return undefined;
  return {
    fiveHour: Number(quota.fiveHour || 0) / sellableShares,
    weekly: Number(quota.weekly || 0) / sellableShares,
  };
}

function scalePerSeatQuota(perSeat: number, seats: number): number {
  return Math.round((perSeat * seats) * 1_000_000) / 1_000_000;
}
