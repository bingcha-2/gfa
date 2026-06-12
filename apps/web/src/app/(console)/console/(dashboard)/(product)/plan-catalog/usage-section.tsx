"use client";

// 「用量档」区块(spec §7 表单④,号池线)。
//   每个档(small / large)一张卡:逐桶 token 上限 + 周 token 上限。
//   桶键随「启用产品」实时推导(bucketsForProducts);号池线据此卖小 / 大用量。
// 受控:value = UsageTierRow[],onChange 回传整张新数组。enabledProducts 决定列哪些桶。

import { NumberInput } from "./form-bits";
import { bucketLabel, bucketsForProducts } from "./catalog-defaults";
import type { UsageTierRow } from "@/lib/console/plan-catalog-form";

/** 档 key 的展示名(small/large 有中文,其余回退 key)。 */
function tierLabel(key: string): string {
  if (key === "small") return "小用量";
  if (key === "large") return "大用量";
  return key;
}

export interface UsageSectionProps {
  value: UsageTierRow[];
  onChange: (next: UsageTierRow[]) => void;
  /** 当前启用的产品 keys —— 决定每档要列哪些桶。 */
  enabledProducts: string[];
  disabled?: boolean;
}

export function UsageSection({ value, onChange, enabledProducts, disabled }: UsageSectionProps) {
  const buckets = bucketsForProducts(enabledProducts);

  const setTier = (index: number, patch: Partial<UsageTierRow>) => {
    onChange(value.map((tier, i) => (i === index ? { ...tier, ...patch } : tier)));
  };

  const setBucket = (index: number, bucket: string, raw: string) => {
    const tier = value[index];
    setTier(index, { bucketLimits: { ...tier.bucketLimits, [bucket]: raw } });
  };

  if (value.length === 0) {
    return <p className="text-sm text-muted-foreground">暂无用量档。</p>;
  }

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {value.map((tier, index) => (
        <div key={tier.key} className="rounded-lg border p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">{tierLabel(tier.key)}</span>
            <code className="text-[11px] text-muted-foreground">{tier.key}</code>
          </div>

          {/* 逐桶 token 上限。 */}
          {buckets.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              请先在「产品与等级」启用至少一个产品。
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {buckets.map((bucket) => (
                <label key={bucket} className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">{bucketLabel(bucket)}</span>
                  <NumberInput
                    className="w-40"
                    value={tier.bucketLimits[bucket] ?? ""}
                    onChange={(raw) => setBucket(index, bucket, raw)}
                    disabled={disabled}
                    placeholder="留空=0"
                    suffix="tok"
                    aria-label={`${tierLabel(tier.key)} · ${bucketLabel(bucket)} 上限`}
                  />
                </label>
              ))}
            </div>
          )}

          {/* 周 token 上限。 */}
          <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3">
            <span className="text-xs font-medium">周 token 上限</span>
            <NumberInput
              className="w-40"
              value={tier.weeklyTokenLimit}
              onChange={(raw) => setTier(index, { weeklyTokenLimit: raw })}
              disabled={disabled}
              placeholder="留空=0"
              suffix="tok"
              aria-label={`${tierLabel(tier.key)} 周上限`}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
