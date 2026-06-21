// Supply policies describe per-account sales capacity.
// Codex/Anthropic bind quotas stay fair-share governed.
// Antigravity bind quotas can additionally publish fixed token buckets.

export interface SupplyPolicy {
  defaultLevel: string;
  salesSeatsPerAccount: Record<string, number>;
  buckets?: Record<string, unknown>;
}

export interface FixedQuotaSource {
  source: "fixed";
  window5h: number;
  weekly: number;
}

export interface EntitlementInput {
  products: string[];
  shareSeats: number;
  shareCapacity: number;
}

export interface BucketEntitlements {
  bucketLimits?: Record<string, number>;
  weeklyBucketLimits?: Record<string, number>;
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
    antigravity: {
      defaultLevel: "ultra",
      salesSeatsPerAccount: { ultra: 10 },
      buckets: {
        "antigravity-gemini": { source: "fixed", window5h: 100_000_000, weekly: 400_000_000 },
        "antigravity-claude": { source: "fixed", window5h: 12_000_000, weekly: 40_000_000 },
      },
    },
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
      buckets: mergeBucketSources(base?.buckets, override.buckets),
    };
  }

  return merged;
}

export function buildFixedEntitlements(
  catalog: SupplyPolicyCatalog,
  input: EntitlementInput,
): BucketEntitlements {
  const ratio = entitlementRatio(input);
  const policies = mergeSupplyPolicies(catalog);
  const bucketLimits: Record<string, number> = {};
  const weeklyBucketLimits: Record<string, number> = {};

  for (const product of input.products) {
    const policy = policies[product];
    if (!policy?.buckets) continue;
    for (const [bucket, source] of Object.entries(policy.buckets)) {
      if (!isFixedQuotaSource(source)) continue;
      writePositive(bucketLimits, bucket, Math.floor(source.window5h * ratio));
      writePositive(weeklyBucketLimits, bucket, Math.floor(source.weekly * ratio));
    }
  }

  return {
    ...(Object.keys(bucketLimits).length > 0 ? { bucketLimits } : {}),
    ...(Object.keys(weeklyBucketLimits).length > 0 ? { weeklyBucketLimits } : {}),
  };
}

export function entitlementRatio(input: Pick<EntitlementInput, "shareSeats" | "shareCapacity">): number {
  const shareSeats = Math.max(1, Math.floor(Number(input.shareSeats) || 1));
  const shareCapacity = Math.max(1, Math.floor(Number(input.shareCapacity) || 1));
  return Math.min(1, shareSeats / shareCapacity);
}

export function writePositive(target: Record<string, number>, key: string, value: number): void {
  const normalized = Math.floor(Number(value));
  if (key && Number.isFinite(normalized) && normalized > 0) {
    target[key] = normalized;
  }
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

function mergeBucketSources(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = { ...(base ?? {}) };
  for (const [bucket, source] of Object.entries(override ?? {})) {
    const current = merged[bucket];
    if (isFixedQuotaSource(source) || !isFixedQuotaSource(current)) {
      merged[bucket] = source;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function isFixedQuotaSource(value: unknown): value is FixedQuotaSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return (
    source.source === "fixed" &&
    Number.isFinite(Number(source.window5h)) &&
    Number.isFinite(Number(source.weekly))
  );
}
