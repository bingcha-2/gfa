// 供给策略:目前只承载「每号销售席位容量」(salesSeatsPerAccount)。
// 历史的 per-bucket 额度(QuotaSource: fixed/learned → bucketLimits/weeklyBucketLimits)已删除
// —— 绑定卡额度统一由 fair-share 治理(见 QUOTA-REDESIGN.md),不再下发静态 entitlements。

export interface SupplyPolicy {
  defaultLevel: string;
  salesSeatsPerAccount: Record<string, number>;
}

export interface SupplyPolicyCatalog {
  supplyPolicies?: Record<string, Partial<SupplyPolicy>>;
  /** 全局统一容量 C:一个号拼几个人(份)。后台可配;缺省回退 ACCOUNT_SHARE_CAPACITY。
   *  同时是 seat 层占座上限与 fair-share 分母保底 N —— 两套口径合一(见 QUOTA-REDESIGN)。 */
  accountCapacity?: number;
  /** 拼车超卖系数:封顶 = ceil(C × factor)。后台可配;缺省 1.5。独享永不超卖,不走这条。 */
  oversellFactor?: number;
}

/** 超卖系数默认值:拼车最多卖到 1.5×C。 */
export const DEFAULT_OVERSELL_FACTOR = 1.5;

/** 统一容量 C:catalog.accountCapacity(后台覆盖)→ fallback(调用方传 ACCOUNT_SHARE_CAPACITY)。 */
export function accountCapacity(catalog: SupplyPolicyCatalog, fallback: number): number {
  const override = positiveInteger(catalog.accountCapacity);
  if (override) return override;
  const fb = Math.floor(Number(fallback));
  return Number.isFinite(fb) && fb > 0 ? fb : 8;
}

/** 后台可配超卖系数:catalog.oversellFactor → 默认 1.5。clamp ≥ 1(系数 <1 = 比基准还少卖,无意义)。 */
export function oversellFactor(catalog: SupplyPolicyCatalog): number {
  const raw = Number(catalog.oversellFactor);
  if (!Number.isFinite(raw)) return DEFAULT_OVERSELL_FACTOR;
  return raw < 1 ? 1 : raw;
}

/** 拼车超卖封顶 = ceil(C × factor)。 */
export function oversellCeiling(catalog: SupplyPolicyCatalog, fallback: number): number {
  return Math.ceil(accountCapacity(catalog, fallback) * oversellFactor(catalog));
}

export function defaultSupplyPolicies(): Record<string, SupplyPolicy> {
  return {
    anthropic: { defaultLevel: "max-20x", salesSeatsPerAccount: { "max-20x": 10 } },
    codex: { defaultLevel: "pro", salesSeatsPerAccount: { pro: 10 } },
    antigravity: { defaultLevel: "ultra", salesSeatsPerAccount: { ultra: 10 } },
  };
}

export function mergeSupplyPolicies(catalog: SupplyPolicyCatalog): Record<string, SupplyPolicy> {
  const defaults = defaultSupplyPolicies();
  const overrides = catalog.supplyPolicies ?? {};
  const products = new Set([...Object.keys(defaults), ...Object.keys(overrides)]);
  const merged: Record<string, SupplyPolicy> = {};

  for (const product of products) {
    const base = defaults[product];
    const override = overrides[product] ?? {};
    merged[product] = {
      defaultLevel: override.defaultLevel ?? base?.defaultLevel ?? "",
      salesSeatsPerAccount: {
        ...(base?.salesSeatsPerAccount ?? {}),
        ...(override.salesSeatsPerAccount ?? {}),
      },
    };
  }

  return merged;
}

export function salesSeatCapacityFor(
  catalog: SupplyPolicyCatalog,
  product: string,
  level: string,
  fallback: number,
): number {
  const policies = mergeSupplyPolicies(catalog);
  const policy = policies[product];
  const capacity = positiveInteger(policy?.salesSeatsPerAccount?.[level]);
  if (capacity) return capacity;
  const defaultCapacity = positiveInteger(policy?.salesSeatsPerAccount?.[policy.defaultLevel]);
  if (defaultCapacity) return defaultCapacity;
  const fallbackCapacity = Math.floor(Number(fallback));
  return Number.isFinite(fallbackCapacity) && fallbackCapacity > 0 ? fallbackCapacity : 8;
}

function positiveInteger(value: unknown): number | null {
  const normalized = Math.floor(Number(value));
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}
