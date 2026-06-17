export type QuotaSource =
  | { source: "fixed"; window5h: number; weekly: number }
  | { source: "learned"; provider: string; planType: string; family: string };

export interface SupplyPolicy {
  defaultLevel: string;
  salesSeatsPerAccount: Record<string, number>;
  buckets: Record<string, QuotaSource>;
}

export interface EntitlementInput {
  products: string[];
  levels?: Record<string, string>;
  shareSeats: number;
  shareCapacity: number;
}

export interface BucketEntitlements {
  bucketLimits: Record<string, number>;
  weeklyBucketLimits: Record<string, number>;
}

export interface SupplyPolicyCatalog {
  supplyPolicies?: Record<string, Partial<SupplyPolicy>>;
}

export function defaultSupplyPolicies(): Record<string, SupplyPolicy> {
  return {
    anthropic: {
      defaultLevel: "max-20x",
      salesSeatsPerAccount: { "max-20x": 10 },
      buckets: {
        "anthropic-claude": {
          source: "learned",
          provider: "anthropic",
          planType: "max-20x",
          family: "claude",
        },
      },
    },
    codex: {
      defaultLevel: "pro",
      salesSeatsPerAccount: { pro: 10 },
      buckets: {
        "codex-gpt": {
          source: "learned",
          provider: "codex",
          planType: "pro",
          family: "gpt",
        },
      },
    },
    antigravity: {
      defaultLevel: "ultra",
      salesSeatsPerAccount: { ultra: 10 },
      buckets: {
        "antigravity-gemini": {
          source: "fixed",
          window5h: 100_000_000,
          weekly: 400_000_000,
        },
        "antigravity-claude": {
          source: "fixed",
          window5h: 12_000_000,
          weekly: 40_000_000,
        },
      },
    },
  };
}

export function buildFixedEntitlements(catalog: SupplyPolicyCatalog, input: EntitlementInput): BucketEntitlements {
  const ratio = entitlementRatio(input);
  const policies = mergeSupplyPolicies(catalog);
  const entitlements: BucketEntitlements = { bucketLimits: {}, weeklyBucketLimits: {} };

  for (const product of input.products) {
    const policy = policies[product];
    if (!policy) continue;

    for (const [bucket, source] of Object.entries(policy.buckets)) {
      if (source.source !== "fixed") continue;
      writePositive(entitlements.bucketLimits, bucket, Math.floor(source.window5h * ratio));
      writePositive(entitlements.weeklyBucketLimits, bucket, Math.floor(source.weekly * ratio));
    }
  }

  return entitlements;
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
      buckets: {
        ...(base?.buckets ?? {}),
        ...(override.buckets ?? {}),
      },
    };
  }

  return merged;
}

export function entitlementRatio(input: Pick<EntitlementInput, "shareSeats" | "shareCapacity">): number {
  const shareSeats = Number(input.shareSeats);
  const shareCapacity = Number(input.shareCapacity);
  if (!Number.isFinite(shareSeats) || !Number.isFinite(shareCapacity) || shareCapacity <= 0) return 0;
  return shareSeats / shareCapacity;
}

export function writePositive(target: Record<string, number>, bucket: string, limit: number): void {
  if (Number.isFinite(limit) && limit > 0) {
    target[bucket] = limit;
  }
}
