"use client";

// 「产品与等级」区块(spec §7 表单②)。
//   每产品一张卡:启用开关 + 等级选择(绑定线可选档)。
//   等级 = 绑定线可选档,从该产品账号池里实际存在的 planType 里选(GET
//   /api/console/account-levels),账号池里没有的等级选不了 —— 这样 console 档名 ↔
//   account.planType ↔ 绑定匹配天然一致,根除"档名对不上→绑定失败"(spec §3 line 111
//   「等级档名以实际可绑的号为准」)。
//   停用产品仍保留其等级与价(便于重新启用),只是不进 config.products。
// 受控:value = ProductRow[],onChange 回传整张新数组(上层合并进表单)。

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
  disabled,
  onToggle,
  onLevelsChange,
}: {
  row: ProductRow;
  poolLevels: string[];
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

  // 候选 = 账号池里的等级 ∪ 当前已选(后者可能含池里已不存在的「孤儿」老配置 —— 仍展示
  // 并允许移除,避免静默丢失;保序:先池里档,再补孤儿)。
  const orphanLevels = row.levels.filter((l) => !poolLevels.includes(l));
  const options = [...poolLevels, ...orphanLevels];

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

      {/* 等级选择(绑定线档):从账号池实际 planType 里点选,不可手填。 */}
      <div className="mt-3">
        <div className="mb-1.5 text-xs text-muted-foreground">
          绑定线等级(从账号池实际等级里选)
        </div>

        {options.length === 0 ? (
          <p className="text-xs text-amber-600 dark:text-amber-500">
            该产品账号池里没有可选等级,请先到账号管理录入对应等级的号。
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {options.map((level) => {
              const selected = row.levels.includes(level);
              const orphan = !poolLevels.includes(level);
              return (
                <button
                  key={level}
                  type="button"
                  onClick={() => toggleLevel(level)}
                  disabled={disabled}
                  aria-pressed={selected}
                  title={orphan ? "账号池里已无此等级(老配置),点击移除" : undefined}
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
                  {level}
                  {orphan && <span className="text-[10px]">(已移除)</span>}
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
