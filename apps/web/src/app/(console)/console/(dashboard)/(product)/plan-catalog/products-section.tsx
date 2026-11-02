"use client";

import { catalogLevelLabel } from "@/lib/account/catalog-level-label";

// 套餐档位独立于当前库存；库存只作为母号产品的供给提示。

import { CheckIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";

import type { ProductRow } from "@/lib/console/plan-catalog-form";
import { productLabel } from "./catalog-defaults";

export interface ProductsSectionProps {
  value: ProductRow[];
  onChange: (next: ProductRow[]) => void;
  /** 各产品账号池里实际存在的等级(planType 去重)。缺省 = 该产品还没拉到/无号。 */
  availableLevels?: Record<string, string[]>;
  disabled?: boolean;
}

export function ProductsSection({ value, onChange, availableLevels, disabled }: ProductsSectionProps) {
  const setRow = (index: number, patch: Partial<ProductRow>) => {
    onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  return (
    <div className="flex flex-col gap-3">
      {value.map((row, index) => (
        <ProductCard
          key={row.product}
          row={row}
          poolLevels={availableLevels?.[row.product] ?? []}
          inventoryKnown={Array.isArray(availableLevels?.[row.product])}
          disabled={disabled}
          onToggle={(enabled) => setRow(index, { enabled })}
          onLevelsChange={(levels) => setRow(index, { levels })}
        />
      ))}
      {value.length === 0 && (
        <p className="text-sm text-muted-foreground">暂无产品。</p>
      )}
    </div>
  );
}

function ProductCard({
  row,
  poolLevels,
  inventoryKnown,
  disabled,
  onToggle,
  onLevelsChange,
}: {
  row: ProductRow;
  poolLevels: string[];
  inventoryKnown: boolean;
  disabled?: boolean;
  onToggle: (enabled: boolean) => void;
  onLevelsChange: (levels: string[]) => void;
}) {
  const toggleLevel = (level: string) => {
    onLevelsChange(
      row.levels.includes(level)
        ? row.levels.filter((l) => l !== level)
        : [...row.levels, level],
    );
  };

  const presets: Record<string, string[]> = { anthropic: ['pro', 'max-5x', row.levels.includes('ultra') && !row.levels.includes('max-20x') ? 'ultra' : 'max-20x'], codex: ['plus', 'pro'], antigravity: ['pro', 'ultra'] };
  const gateway = row.product === 'anthropic';
  const options = [...new Set([...(presets[row.product] ?? []), ...row.levels, ...(gateway ? [] : poolLevels)])];

  return (
    <div
      className="rounded-lg border p-3 transition-opacity data-[off=true]:opacity-60"
      data-off={!row.enabled}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Switch
            checked={row.enabled}
            onCheckedChange={onToggle}
            disabled={disabled}
            aria-label={`启用 ${productLabel(row.product)}`}
          />
          <span className="text-sm font-medium">{productLabel(row.product)}</span>
          <code className="text-[11px] text-muted-foreground">{row.product}</code>
        </div>
        <Badge variant={row.enabled ? "default" : "outline"} className="text-[10px]">
          {row.enabled ? "启用" : "停用"}
        </Badge>
      </div>

      {/* 等级选择与库存独立，缺货不会删除已有套餐。 */}
      <div className="mt-3">
        <div className="mb-1.5 text-xs text-muted-foreground">
          {gateway ? '套餐档位（不依赖旧账号池）' : '套餐档位（分配时检查母号库存）'}
        </div>

        {options.length === 0 ? (
          <p className="text-xs text-amber-600 dark:text-amber-500">
            暂无套餐档位。
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {options.map((level) => {
              const selected = row.levels.includes(level);
              const orphan = !gateway && inventoryKnown && !poolLevels.includes(level);
              return (
                <button
                  key={level}
                  type="button"
                  onClick={() => toggleLevel(level)}
                  disabled={disabled}
                  aria-pressed={selected}
                  title={orphan ? "暂无对应等级母号；可配置套餐，分配时仍需可用库存" : undefined}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                    "disabled:pointer-events-none disabled:opacity-50",
                    selected
                      ? "border-primary bg-primary/10 text-foreground"
                      : "bg-muted/40 text-muted-foreground hover:bg-muted",
                    orphan && "border-amber-500/60 text-amber-600 dark:text-amber-500",
                  )}
                >
                  {selected && <CheckIcon className="size-3" />}
                  {catalogLevelLabel(row.product, level)}
                  {orphan && <span className="text-[10px]">(暂无母号)</span>}
                </button>
              );
            })}
          </div>
        )}

        {options.length > 0 && row.levels.length === 0 && (
          <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-500">
            未选等级(绑定线需至少一档)
          </p>
        )}
      </div>
    </div>
  );
}
