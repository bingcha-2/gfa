"use client";

// 「产品与等级」区块(spec §7 表单②)。
//   每产品一张卡:启用开关 + 等级 pill 列表(可加 / 删)。等级 = 绑定线可选档。
//   停用产品仍保留其等级与价(便于重新启用),只是不进 config.products。
// 受控:value = ProductRow[],onChange 回传整张新数组(上层合并进表单)。

import { useState } from "react";
import { XIcon, PlusIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";

import type { ProductRow } from "@/lib/console/plan-catalog-form";
import { productLabel } from "./catalog-defaults";

export interface ProductsSectionProps {
  value: ProductRow[];
  onChange: (next: ProductRow[]) => void;
  disabled?: boolean;
}

export function ProductsSection({ value, onChange, disabled }: ProductsSectionProps) {
  const setRow = (index: number, patch: Partial<ProductRow>) => {
    onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  return (
    <div className="flex flex-col gap-3">
      {value.map((row, index) => (
        <ProductCard
          key={row.product}
          row={row}
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
  disabled,
  onToggle,
  onLevelsChange,
}: {
  row: ProductRow;
  disabled?: boolean;
  onToggle: (enabled: boolean) => void;
  onLevelsChange: (levels: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  const addLevel = () => {
    const next = draft.trim();
    if (!next || row.levels.includes(next)) {
      setDraft("");
      return;
    }
    onLevelsChange([...row.levels, next]);
    setDraft("");
  };

  const removeLevel = (level: string) => {
    onLevelsChange(row.levels.filter((l) => l !== level));
  };

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

      {/* 等级 pill 列表(绑定线档)。 */}
      <div className="mt-3">
        <div className="mb-1.5 text-xs text-muted-foreground">
          绑定线等级(可加 / 删)
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {row.levels.map((level) => (
            <span
              key={level}
              className="inline-flex items-center gap-1 rounded-full border bg-muted/50 py-0.5 pl-2.5 pr-1 text-xs"
            >
              {level}
              <button
                type="button"
                className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                onClick={() => removeLevel(level)}
                disabled={disabled}
                aria-label={`删除等级 ${level}`}
              >
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
          {row.levels.length === 0 && (
            <span className="text-xs text-amber-600 dark:text-amber-500">
              无等级(绑定线需至少一档)
            </span>
          )}
        </div>

        {/* 新增等级输入。 */}
        <div className="mt-2 flex items-center gap-1.5">
          <Input
            className="h-8 w-40 text-sm"
            placeholder="新增等级,如 pro"
            value={draft}
            disabled={disabled}
            aria-label={`为 ${productLabel(row.product)} 新增等级`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addLevel();
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addLevel}
            disabled={disabled || !draft.trim()}
          >
            <PlusIcon data-icon className="size-3.5" />
            添加
          </Button>
        </div>
      </div>
    </div>
  );
}
