"use client";

// 统一绑定线的供给策略区块。

import { NumberInput } from "./form-bits";
import { bucketLabel, bucketsForProducts } from "./catalog-defaults";
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
    const buckets = Object.fromEntries(
      bucketsForProducts([row.product]).map((bucket) => {
        const family = bucket.includes("-") ? bucket.split("-").slice(1).join("-") : bucket;
        return [
          bucket,
          {
            source: "learned",
            provider: row.product,
            planType: defaultLevel,
            family,
          },
        ];
      }),
    );
    return { defaultLevel, salesSeatsPerAccount, buckets };
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
              <span className="text-sm font-medium">{row.product}</span>
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

            <div className="mt-3 border-t pt-3">
              <div className="mb-1 text-xs font-medium text-muted-foreground">额度来源</div>
              <div className="flex flex-col gap-1">
                {Object.entries(policy.buckets).map(([bucket, source]) => (
                  <div key={bucket} className="flex items-start justify-between gap-2 text-xs">
                    <span className="text-muted-foreground">{bucketLabel(bucket)}</span>
                    <code className="max-w-48 truncate text-[11px]">
                      {JSON.stringify(source)}
                    </code>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
