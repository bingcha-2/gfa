"use client";

import { NumberInput } from "./form-bits";
import {
  ANTIGRAVITY_FIXED_QUOTA_DEFAULTS,
  bucketLabel,
  bucketsForProducts,
  productLabel,
} from "./catalog-defaults";
import type {
  ProductRow,
  SupplyPolicyForm,
} from "@/lib/console/plan-catalog-form";

export interface SupplyPoliciesSectionProps {
  value?: Record<string, SupplyPolicyForm>;
  products: ProductRow[];
  onChange: (next: Record<string, SupplyPolicyForm>) => void;
  disabled?: boolean;
}

type FixedQuotaField = "window5h" | "weekly";
type FixedQuotaSourceInput = {
  source: "fixed";
  window5h?: unknown;
  weekly?: unknown;
  [key: string]: unknown;
};

export function SupplyPoliciesSection({
  value,
  products,
  onChange,
  disabled,
}: SupplyPoliciesSectionProps) {
  const enabled = products.filter((p) => p.enabled);

  function ensurePolicy(row: ProductRow): SupplyPolicyForm {
    const existing = value?.[row.product];
    if (existing) return existing;
    const defaultLevel = row.levels[0] ?? "";
    const salesSeatsPerAccount = Object.fromEntries(
      row.levels.map((level) => [level, "10"]),
    );
    return {
      defaultLevel,
      salesSeatsPerAccount,
      buckets: defaultBucketsForProduct(row.product, defaultLevel),
    };
  }

  function setPolicy(product: string, patch: Partial<SupplyPolicyForm>) {
    const row = products.find((p) => p.product === product);
    if (!row) return;
    const current = ensurePolicy(row);
    onChange({
      ...(value ?? {}),
      [product]: { ...current, ...patch },
    });
  }

  function setSalesSeats(product: string, level: string, raw: string) {
    const row = products.find((p) => p.product === product);
    if (!row) return;
    const current = ensurePolicy(row);
    setPolicy(product, {
      salesSeatsPerAccount: {
        ...current.salesSeatsPerAccount,
        [level]: raw,
      },
    });
  }

  function setFixedQuota(
    product: string,
    bucket: string,
    field: FixedQuotaField,
    raw: string,
  ) {
    const row = products.find((p) => p.product === product);
    if (!row) return;
    const current = ensurePolicy(row);
    const fallback = ANTIGRAVITY_FIXED_QUOTA_DEFAULTS[bucket] ?? {
      window5h: 0,
      weekly: 0,
    };
    const existing = current.buckets[bucket];
    const fixed = isFixedQuotaSourceInput(existing)
      ? existing
      : {
          source: "fixed" as const,
          window5h: String(fallback.window5h),
          weekly: String(fallback.weekly),
        };

    setPolicy(product, {
      buckets: {
        ...current.buckets,
        [bucket]: {
          ...fixed,
          source: "fixed",
          [field]: raw,
        },
      },
    });
  }

  if (enabled.length === 0) {
    return <p className="text-sm text-muted-foreground">请先启用至少一个产品。</p>;
  }

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {enabled.map((row) => {
        const policy = ensurePolicy(row);
        return (
          <div key={row.product} className="rounded-lg border p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{productLabel(row.product)}</span>
              <code className="text-[11px] text-muted-foreground">
                默认 {policy.defaultLevel || "-"}
              </code>
            </div>

            <div className="flex flex-col gap-2">
              {row.levels.map((level) => (
                <label key={level} className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs">{level}</span>
                  <NumberInput
                    className="w-32"
                    value={policy.salesSeatsPerAccount[level] ?? ""}
                    onChange={(raw) => setSalesSeats(row.product, level, raw)}
                    disabled={disabled}
                    placeholder="10"
                    suffix="席"
                    aria-label={`${row.product} ${level} 每账号可售席位`}
                  />
                </label>
              ))}
            </div>

            {row.product === "antigravity" ? (
              <AntigravityFixedQuotaEditor
                policy={policy}
                disabled={disabled}
                onChange={(bucket, field, raw) =>
                  setFixedQuota(row.product, bucket, field, raw)
                }
              />
            ) : (
              <QuotaSourceSummary policy={policy} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function AntigravityFixedQuotaEditor({
  policy,
  disabled,
  onChange,
}: {
  policy: SupplyPolicyForm;
  disabled?: boolean;
  onChange: (bucket: string, field: FixedQuotaField, raw: string) => void;
}) {
  return (
    <div className="mt-3 border-t pt-3">
      <div className="mb-2 text-xs font-medium text-muted-foreground">满额额度</div>
      <div className="flex flex-col gap-3">
        {Object.keys(ANTIGRAVITY_FIXED_QUOTA_DEFAULTS).map((bucket) => (
          <div key={bucket} className="flex flex-col gap-2">
            <div className="text-xs font-medium">{bucketLabel(bucket)}</div>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">5h 满额</span>
                <NumberInput
                  className="w-36"
                  value={fixedQuotaValue(policy, bucket, "window5h")}
                  onChange={(raw) => onChange(bucket, "window5h", raw)}
                  disabled={disabled}
                  suffix="tokens"
                  aria-label={`${bucketLabel(bucket)} 5h 满额`}
                />
              </label>
              <label className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">周满额</span>
                <NumberInput
                  className="w-36"
                  value={fixedQuotaValue(policy, bucket, "weekly")}
                  onChange={(raw) => onChange(bucket, "weekly", raw)}
                  disabled={disabled}
                  suffix="tokens"
                  aria-label={`${bucketLabel(bucket)} 周满额`}
                />
              </label>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function QuotaSourceSummary({ policy }: { policy: SupplyPolicyForm }) {
  return (
    <div className="mt-3 border-t pt-3">
      <div className="mb-1 text-xs font-medium text-muted-foreground">额度来源</div>
      <div className="flex flex-col gap-1">
        {Object.entries(policy.buckets).map(([bucket, source]) => (
          <div key={bucket} className="flex items-start justify-between gap-2 text-xs">
            <span className="text-muted-foreground">{bucketLabel(bucket)}</span>
            <code className="max-w-48 truncate text-[11px]">{JSON.stringify(source)}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

function defaultBucketsForProduct(
  product: string,
  defaultLevel: string,
): Record<string, unknown> {
  if (product === "antigravity") {
    return Object.fromEntries(
      Object.entries(ANTIGRAVITY_FIXED_QUOTA_DEFAULTS).map(([bucket, quota]) => [
        bucket,
        { source: "fixed", ...quota },
      ]),
    );
  }

  return Object.fromEntries(
    bucketsForProducts([product]).map((bucket) => {
      const family = bucket.includes("-") ? bucket.split("-").slice(1).join("-") : bucket;
      return [
        bucket,
        {
          source: "learned",
          provider: product,
          planType: defaultLevel,
          family,
        },
      ];
    }),
  );
}

function fixedQuotaValue(
  policy: SupplyPolicyForm,
  bucket: string,
  field: FixedQuotaField,
): string {
  const source = policy.buckets[bucket];
  if (isFixedQuotaSourceInput(source) && source[field] !== undefined) {
    return String(source[field]);
  }
  const fallback = ANTIGRAVITY_FIXED_QUOTA_DEFAULTS[bucket]?.[field];
  return fallback === undefined ? "" : String(fallback);
}

function isFixedQuotaSourceInput(value: unknown): value is FixedQuotaSourceInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as Record<string, unknown>).source === "fixed";
}
