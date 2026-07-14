// 套餐配置页的展示常量 + 空 config 默认值(纯数据,无 React)。
//
// - PRODUCT_LABELS / FAMILIES_BY_PRODUCT:产品展示名 + 每产品的模型「桶」键
//   (与后端 product-bucket.ts 对齐)。
//   用量档与统一绑定线供给策略都会复用这些 "<product>-<family>" 桶键。
// - DEFAULT_CONFIG:首次(无任何发布版)进页面时的占位 config(spec §4.1 示例数值),
//   让运营有个可改的起点,而不是空白表单。价格单位=分。

import type { CatalogConfig } from "@/lib/account/catalog-pricing";
import { API_USD_QUOTA_PER_SEAT_DEFAULTS } from "@gfa/shared";

/** 产品展示名(与购买页 productNames 一致;键缺失回退原始 key)。 */
export const PRODUCT_LABELS: Record<string, string> = {
  anthropic: "Anthropic (Claude)",
  codex: "Codex",
  antigravity: "Antigravity (Gemini)",
};

export const ANTIGRAVITY_FIXED_QUOTA_DEFAULTS: Record<
  string,
  { window5h: number; weekly: number }
> = {
  "antigravity-gemini": { window5h: 100_000_000, weekly: 400_000_000 },
  "antigravity-claude": { window5h: 12_000_000, weekly: 40_000_000 },
};

/**
 * 每一份 API 等价美元额度默认值，资料口径截至 2026-07-14。
 *
 * - Codex 当前临时取消 5h 卡点，因此 5h=0，只启用周额度。
 * - Codex `plus` 沿用目录现有的低档键，对应资料中的 5x 档；`pro` 对应 20x 档。
 * - Claude 周额度使用可复现实测的保守下界（Max 5x 约 $523、Max 20x
 *   约 $1,100），不把临时活动固化进长期套餐；5h 使用当前可编辑估值。
 *
 * 这些是运营默认值，不是厂商承诺额度；后台发布目录前可逐档修改。
 */
export { API_USD_QUOTA_PER_SEAT_DEFAULTS };

/** 每产品暴露的模型家族 → 复合桶键 "<product>-<family>"。 */
export const FAMILIES_BY_PRODUCT: Record<string, string[]> = {
  antigravity: ["gemini", "claude"],
  codex: ["gpt"],
  anthropic: ["claude"],
};

const FAMILY_LABELS: Record<string, string> = {
  gemini: "Gemini",
  claude: "Claude",
  gpt: "GPT",
};

/** 复合桶键 → 人类标签,如 "antigravity-claude" → "Antigravity · Claude"。 */
export function bucketLabel(bucket: string): string {
  const idx = bucket.indexOf("-");
  if (idx < 0) return PRODUCT_LABELS[bucket] ?? bucket;
  const product = bucket.slice(0, idx);
  const family = bucket.slice(idx + 1);
  const pl = PRODUCT_LABELS[product] ?? product;
  const fl = FAMILY_LABELS[family] ?? family;
  return `${pl} · ${fl}`;
}

/** 给定启用产品集合,推导用量档应覆盖的全部桶键(去重保序)。 */
export function bucketsForProducts(products: string[]): string[] {
  const out: string[] = [];
  for (const product of products) {
    for (const family of FAMILIES_BY_PRODUCT[product] ?? []) {
      const key = `${product}-${family}`;
      if (!out.includes(key)) out.push(key);
    }
  }
  return out;
}

/** 产品展示名(回退原始 key)。 */
export function productLabel(product: string): string {
  return PRODUCT_LABELS[product] ?? product;
}

/**
 * 首次进页面、且后端无任何 PUBLISHED 版本时的占位 config。
 * 数值取 spec §4.1 的示例(分),运营在此基础上改后存草稿 → 发布。
 */
export const DEFAULT_CONFIG: CatalogConfig = {
  products: ["anthropic", "codex", "antigravity"],
  levels: {
    anthropic: ["pro", "max-5x", "max-20x"],
    codex: ["plus", "pro"],
    antigravity: ["pro", "ultra"],
  },
  usageTiers: {
    small: { bucketLimits: { "anthropic-claude": 50000 }, weeklyTokenLimit: 250000 },
    large: { bucketLimits: { "anthropic-claude": 150000 }, weeklyTokenLimit: 750000 },
  },
  pricing: {
    pool: {
      product: { anthropic: 6900, codex: 3900, antigravity: 3900 },
      usage: { small: 0, large: 3000 },
      devicePerExtra: 900,
    },
    bind: {
      levelPrice: {
        anthropic: { pro: 9900, "max-5x": 15900, "max-20x": 29900 },
        codex: { plus: 13900, pro: 19900 },
        antigravity: { pro: 11900, ultra: 19900 },
      },
      usdQuotaPerSeat: API_USD_QUOTA_PER_SEAT_DEFAULTS,
      share: { "1": 0, "2": -2000, "4": -4000, "8": 0 },
      devicePerExtra: 900,
    },
  },
  durationDays: 30,
  windowMs: 18_000_000,
  oversellFactor: 1.5,
  supplyPolicies: {
    antigravity: {
      defaultLevel: "ultra",
      buckets: Object.fromEntries(
        Object.entries(ANTIGRAVITY_FIXED_QUOTA_DEFAULTS).map(([bucket, quota]) => [
          bucket,
          { source: "fixed", ...quota },
        ]),
      ),
    },
  },
};
