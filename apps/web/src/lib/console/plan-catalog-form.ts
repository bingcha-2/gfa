/**
 * PlanCatalog 表单 ↔ config 的纯转换层(无 IO,可单测)。
 *
 * 后台「套餐配置」页让运营用表单编辑 PlanCatalog.config(spec §4.1 / §7.1),
 * 全程不碰 JSON。这里负责两个方向的组装/拆解:
 *
 *   configToForm(config) — 把后端 config(价格单位=分)拆成表单状态(价格单位=元、
 *                          数字字段为受控字符串、嵌套结构摊平成可编辑列表)。
 *   formToConfig(form)   — 把表单状态重新组装回 config(元 ×100 转分、丢弃空行)。
 *
 * ★ 价格单位:config 里一律是分;表单里一律是元。configToForm ÷100,
 *   formToConfig ×100(四舍五入到整分,见 yuanToCents)。★
 *
 * 表单状态刻意全部用字符串存数字(元 / token 数 / 设备数),这样输入框能受控且
 * 允许「清空 → 暂时为空串」的中间态;组装时再按数字解析(parseCents / parseInt)。
 * 价格预览复用 catalog-pricing.ts 的 computePurchase —— 故 formToConfig 产出的
 * 结构与该文件的 CatalogConfig 完全一致。
 */

import type { CatalogConfig } from "@/lib/account/catalog-pricing";

// ── 席位档(绑定线 share 折扣的键)。与购买页 SHARE_OPTIONS 对齐。 ──
export const SHARE_SEATS = [1, 2, 4, 8] as const;

// ── 表单状态类型 ───────────────────────────────────────────────────────────────

/** 一个产品在表单里的一行:开关 + 等级 pill 列表。 */
export interface ProductRow {
  /** 产品 key,如 "anthropic"。 */
  product: string;
  /** 是否启用(出现在 config.products 里)。 */
  enabled: boolean;
  /** 该产品的等级档(绑定线可选档,config.levels[product])。有序、可加删。 */
  levels: string[];
}

/** 旧版用量档兼容数据:每桶 token 上限(字符串)+ 周限额。 */
export interface UsageTierRow {
  /** 档 key,如 "small"。 */
  key: string;
  /** 每桶上限,桶键 → token 数字符串(空串 = 0)。 */
  bucketLimits: Record<string, string>;
  /** 周 token 上限(字符串,空串 = 0)。 */
  weeklyTokenLimit: string;
}

/** 旧版用量定价兼容数据(元)。 */
export interface PoolPricingForm {
  /** 每产品基础价(元),产品 key → 元字符串。 */
  product: Record<string, string>;
  /** 用量加价(元),档 key → 元字符串。 */
  usage: Record<string, string>;
  /** 每多一台设备加价(元)。 */
  devicePerExtra: string;
}

/** 绑定线定价(元)。 */
export interface BindPricingForm {
  /** 等级价矩阵(元),产品 → 等级 → 元字符串。 */
  levelPrice: Record<string, Record<string, string>>;
  /** 席位折扣(元,通常为负),"1"|"2"|"4"|"8" → 元字符串。 */
  share: Record<string, string>;
  /** 每多一台设备加价(元)。 */
  devicePerExtra: string;
}

export interface SupplyPolicyForm {
  defaultLevel: string;
  salesSeatsPerAccount: Record<string, string>;
  buckets: Record<string, unknown>;
}

/** 完整表单状态(展示态)。 */
export interface PlanCatalogForm {
  /** 产品与等级(有序)。products 与 levels 都从这里派生。 */
  products: ProductRow[];
  /** 旧版用量档兼容数据(有序,如 small / large)。 */
  usageTiers: UsageTierRow[];
  pricing: { pool: PoolPricingForm; bind: BindPricingForm };
  /** 有效期(天,字符串)。 */
  durationDays: string;
  /** 限额窗口(毫秒,字符串)。锁死 5h,但仍存表单里以便组装回 config。 */
  windowMs: string;
  /** 统一绑定线动态供给策略;数字字段在表单里以字符串编辑。 */
  supplyPolicies?: Record<string, SupplyPolicyForm>;
  /** 自动分配时允许超过供给策略席位的倍率;空值表示使用服务端默认值。 */
  oversellFactor?: string;
}

// ── 数值转换(元 ↔ 分 / 字符串 ↔ 数字)──────────────────────────────────────────

/** 元字符串 → 分整数。空串 / 非法 → 0;四舍五入到整分(避免 19.99×100=1998.999…)。 */
export function yuanToCents(yuan: string): number {
  const n = Number(yuan);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** 分整数 → 元字符串。0 → "0";去掉浮点误差尾巴。 */
export function centsToYuan(cents: number): string {
  const n = Number(cents);
  if (!Number.isFinite(n)) return "0";
  // /100 后最多两位小数;用 Number(...) 去掉 "99.00" / 末尾零。
  return String(Number((n / 100).toFixed(2)));
}

/** token / 设备 / 天 等「整数字符串」→ 整数。空串 / 非法 / 负 → 0。 */
function toInt(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/** 整数 → 字符串(0 也展示为 "0";用于回填)。 */
function intToStr(value: number): string {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.floor(n)) : "0";
}

function factorToStr(value: number): string {
  return Number.isFinite(value) ? String(value) : "";
}

function optionalOversellFactor(value: string | undefined): Pick<CatalogConfig, "oversellFactor"> {
  if (value === undefined || value.trim() === "") return {};
  const n = Number(value);
  if (!Number.isFinite(n)) return {};
  return { oversellFactor: Math.max(1, n) };
}

// ── config → form(拆解 + ÷100)────────────────────────────────────────────────

/**
 * 把后端 config 拆成表单状态。容错:任何缺失字段都给空安全默认,避免运营在
 * 半成品 config 上编辑时崩溃。产品顺序以 config.products 为准,再并入只在
 * levels/pricing 里出现的产品(防止漏显示)。
 */
export function configToForm(config: CatalogConfig): PlanCatalogForm {
  const products = config.products ?? [];
  const levels = config.levels ?? {};
  const poolPricing = config.pricing?.pool ?? { product: {}, usage: {}, devicePerExtra: 0 };
  const bindPricing = config.pricing?.bind ?? { levelPrice: {}, share: {}, devicePerExtra: 0 };

  // 产品全集:config.products 优先保序,再补 levels / pool.product / bind.levelPrice 里的孤儿。
  const productOrder = uniqueInOrder([
    ...products,
    ...Object.keys(levels),
    ...Object.keys(poolPricing.product ?? {}),
    ...Object.keys(bindPricing.levelPrice ?? {}),
  ]);

  const productRows: ProductRow[] = productOrder.map((product) => ({
    product,
    enabled: products.includes(product),
    levels: [...(levels[product] ?? [])],
  }));

  // 用量档全集:usageTiers 的键 ∪ pool.usage 的键(保 small/large 常见顺序)。
  const tierKeys = uniqueInOrder([
    ...Object.keys(config.usageTiers ?? {}),
    ...Object.keys(poolPricing.usage ?? {}),
  ]);
  const usageTiers: UsageTierRow[] = tierKeys.map((key) => {
    const tier = config.usageTiers?.[key];
    const bucketLimits: Record<string, string> = {};
    for (const [bucket, limit] of Object.entries(tier?.bucketLimits ?? {})) {
      bucketLimits[bucket] = intToStr(Number(limit));
    }
    return {
      key,
      bucketLimits,
      weeklyTokenLimit: intToStr(Number(tier?.weeklyTokenLimit ?? 0)),
    };
  });

  // 旧版用量定价(分 → 元)。
  const pool: PoolPricingForm = {
    product: mapValuesToYuan(poolPricing.product ?? {}, productOrder),
    usage: mapValuesToYuan(poolPricing.usage ?? {}, tierKeys),
    devicePerExtra: centsToYuan(Number(poolPricing.devicePerExtra ?? 0)),
  };

  // 绑定定价(分 → 元)。等级价矩阵逐产品逐等级。
  const levelPrice: Record<string, Record<string, string>> = {};
  for (const product of productOrder) {
    const row = bindPricing.levelPrice?.[product] ?? {};
    const productLevels = levels[product] ?? Object.keys(row);
    const out: Record<string, string> = {};
    for (const level of uniqueInOrder([...productLevels, ...Object.keys(row)])) {
      out[level] = centsToYuan(Number(row[level] ?? 0));
    }
    levelPrice[product] = out;
  }
  const share: Record<string, string> = {};
  for (const n of SHARE_SEATS) {
    share[String(n)] = centsToYuan(Number(bindPricing.share?.[String(n)] ?? 0));
  }
  const bind: BindPricingForm = {
    levelPrice,
    share,
    devicePerExtra: centsToYuan(Number(bindPricing.devicePerExtra ?? 0)),
  };

  return {
    products: productRows,
    usageTiers,
    pricing: { pool, bind },
    durationDays: intToStr(Number(config.durationDays ?? 0)),
    windowMs: intToStr(Number(config.windowMs ?? 0)),
    ...(config.oversellFactor === undefined
      ? {}
      : { oversellFactor: factorToStr(Number(config.oversellFactor)) }),
    ...(config.supplyPolicies === undefined
      ? {}
      : { supplyPolicies: supplyPoliciesToForm(config.supplyPolicies) }),
  };
}

// ── form → config(组装 + ×100)────────────────────────────────────────────────

/**
 * 把表单状态组装回 config。约定:
 *  - 只有 enabled 的产品进 config.products;但 levels / 定价矩阵对所有出现的产品都写
 *    (停用产品保留其等级/价,便于重新启用,且与发布版的历史对齐)。
 *  - 元 → 分(yuanToCents)。
 *  - 等级价矩阵只写该产品「当前等级列表」里的等级(删掉的等级随之消失)。
 *  - 产出结构与 catalog-pricing.ts 的 CatalogConfig 完全一致,可直接喂 computePurchase。
 */
export function formToConfig(form: PlanCatalogForm): CatalogConfig {
  const enabledProducts = form.products.filter((p) => p.enabled).map((p) => p.product);

  // levels:逐产品写其等级列表(去空白、去重、保序)。
  const levels: Record<string, string[]> = {};
  for (const row of form.products) {
    levels[row.product] = uniqueInOrder(row.levels.map((l) => l.trim()).filter(Boolean));
  }

  // usageTiers:逐档写 bucketLimits(只留 >0 的桶)+ 周限额。
  const usageTiers: CatalogConfig["usageTiers"] = {};
  for (const tier of form.usageTiers) {
    const bucketLimits: Record<string, number> = {};
    for (const [bucket, raw] of Object.entries(tier.bucketLimits)) {
      const n = toInt(raw);
      if (n > 0) bucketLimits[bucket] = n;
    }
    usageTiers[tier.key] = {
      bucketLimits,
      weeklyTokenLimit: toInt(tier.weeklyTokenLimit),
    };
  }

  // 旧版用量定价(元 → 分)。
  const poolProduct: Record<string, number> = {};
  for (const row of form.products) {
    poolProduct[row.product] = yuanToCents(form.pricing.pool.product[row.product] ?? "");
  }
  const poolUsage: Record<string, number> = {};
  for (const tier of form.usageTiers) {
    poolUsage[tier.key] = yuanToCents(form.pricing.pool.usage[tier.key] ?? "");
  }

  // bind 定价(元 → 分)。等级价只写当前等级列表里的等级。
  const levelPrice: Record<string, Record<string, number>> = {};
  for (const row of form.products) {
    const out: Record<string, number> = {};
    for (const level of levels[row.product]) {
      out[level] = yuanToCents(form.pricing.bind.levelPrice[row.product]?.[level] ?? "");
    }
    levelPrice[row.product] = out;
  }
  const share: Record<string, number> = {};
  for (const n of SHARE_SEATS) {
    share[String(n)] = yuanToCents(form.pricing.bind.share[String(n)] ?? "");
  }

  return {
    products: enabledProducts,
    levels,
    usageTiers,
    pricing: {
      pool: {
        product: poolProduct,
        usage: poolUsage,
        devicePerExtra: yuanToCents(form.pricing.pool.devicePerExtra),
      },
      bind: {
        levelPrice,
        share,
        devicePerExtra: yuanToCents(form.pricing.bind.devicePerExtra),
      },
    },
    durationDays: toInt(form.durationDays),
    windowMs: toInt(form.windowMs),
    ...optionalOversellFactor(form.oversellFactor),
    ...(form.supplyPolicies === undefined
      ? {}
      : { supplyPolicies: supplyPoliciesToConfig(form.supplyPolicies) }),
  };
}

// ── 校验(发布前)────────────────────────────────────────────────────────────────

/**
 * 发布前的轻校验:返回错误消息数组(空 = 通过)。只拦「会让购买页 / 计价崩」的硬错,
 * 不做风格挑剔。具体:至少一个启用产品、有效期 ≥ 1、窗口 ≥ 1 分钟、
 * 启用产品在绑定线至少有一个等级。
 */
export function validateForm(form: PlanCatalogForm): string[] {
  const errors: string[] = [];
  const enabled = form.products.filter((p) => p.enabled);

  if (enabled.length === 0) {
    errors.push("至少启用一个产品。");
  }
  if (toInt(form.durationDays) < 1) {
    errors.push("有效期需 ≥ 1 天。");
  }
  if (toInt(form.windowMs) < 60_000) {
    errors.push("限额窗口需 ≥ 60000 毫秒(1 分钟)。");
  }
  for (const row of enabled) {
    const levels = row.levels.map((l) => l.trim()).filter(Boolean);
    if (levels.length === 0) {
      errors.push(`产品「${row.product}」已启用但没有任何等级(绑定线需要至少一个)。`);
    }
  }
  return errors;
}

// ── 小工具 ─────────────────────────────────────────────────────────────────────

/** 去重保序(首次出现位置)。 */
function uniqueInOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/** 把「键 → 分」的映射按给定键序转成「键 → 元字符串」(缺失键补 "0")。 */
function mapValuesToYuan(source: Record<string, number>, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of uniqueInOrder([...keys, ...Object.keys(source)])) {
    out[key] = centsToYuan(Number(source[key] ?? 0));
  }
  return out;
}

function supplyPoliciesToForm(
  policies: CatalogConfig["supplyPolicies"],
): Record<string, SupplyPolicyForm> {
  const out: Record<string, SupplyPolicyForm> = {};
  for (const [product, policy] of Object.entries(policies ?? {})) {
    const salesSeatsPerAccount: Record<string, string> = {};
    for (const [level, seats] of Object.entries(policy.salesSeatsPerAccount ?? {})) {
      salesSeatsPerAccount[level] = intToStr(Number(seats));
    }
    out[product] = {
      defaultLevel: policy.defaultLevel ?? "",
      salesSeatsPerAccount,
      buckets: { ...(policy.buckets ?? {}) },
    };
  }
  return out;
}

function supplyPoliciesToConfig(
  policies: Record<string, SupplyPolicyForm>,
): NonNullable<CatalogConfig["supplyPolicies"]> {
  const out: NonNullable<CatalogConfig["supplyPolicies"]> = {};
  for (const [product, policy] of Object.entries(policies ?? {})) {
    const salesSeatsPerAccount: Record<string, number> = {};
    for (const [level, seats] of Object.entries(policy.salesSeatsPerAccount ?? {})) {
      salesSeatsPerAccount[level] = toInt(String(seats));
    }
    out[product] = {
      defaultLevel: policy.defaultLevel ?? "",
      salesSeatsPerAccount,
      buckets: { ...(policy.buckets ?? {}) },
    };
  }
  return out;
}
