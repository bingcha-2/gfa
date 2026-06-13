// 套餐定价 + Subscription.config 生成(纯函数,无 IO)。对齐 spec §4 / §5。
// 价格 = 基础 + Σ(各旋钮加价),分;config = 购买时快照展开的限额配置。

export interface UsageTier {
  bucketLimits: Record<string, number>;
  weeklyTokenLimit: number;
}

export interface CatalogConfig {
  usageTiers: Record<string, UsageTier>;
  pricing: {
    pool: { product: Record<string, number>; usage: Record<string, number>; devicePerExtra: number };
    bind: { levelPrice: Record<string, Record<string, number>>; share: Record<string, number>; devicePerExtra: number };
  };
  windowMs: number;
  durationDays: number;
  /**
   * 一个号被切成 shareCapacity 份(= 运行时 ACCOUNT_SHARE_CAPACITY,服务端读目录时注入,
   * 见 PlanCatalogService.getPublished/getByVersion)。绑定线每份 weight = shareCapacity /
   * 共享人数,与运行时座位口径同源(去「定价硬编码 8 / 运行时 env」双源)。非权威路径(console
   * 价格预览)拿不到注入值时,computeBind 回退 prod 默认 8。
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
      weight: (catalog.shareCapacity ?? 8) / selection.shareUsers,
      deviceLimit: selection.deviceLimit,
      windowMs: catalog.windowMs,
    },
  };
}

function extraDeviceCost(deviceLimit: number, perExtra: number): number {
  return Math.max(0, deviceLimit - 1) * perExtra;
}
