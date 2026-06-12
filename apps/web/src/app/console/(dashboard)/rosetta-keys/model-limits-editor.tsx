"use client";

// 模型限额编辑器(逐模型 token 上限)—— card-config-form 的「模型限额」区块,亦可独立复用。
// 取代旧 card-limits-dialog 的逐桶编辑逻辑。完全受控:
//   - buckets:当前可用模型桶(含 label / used);pool 卡列全部桶,bound 卡只列已绑产品的桶。
//   - value:每桶上限映射 { bucket: number };缺省/0 = 该模型无限。
//   - onChange:整张映射回传(只含 >0 的覆盖项,0/留空表示移除该桶的覆盖)。
// 行内显示每桶「已用 / 上限」与进度条;支持「一键全部设为 X」。

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { WandSparklesIcon } from "lucide-react";
import type { AccessKeyBucket } from "./types";
import { formatTokens } from "@/lib/format";

/** 把受控 value 映射转成每桶的输入框字符串("" = 无限/未设)。 */
function toInputString(limit: number | undefined): string {
  const n = Number(limit || 0);
  return n > 0 ? String(n) : "";
}

export interface ModelLimitsEditorProps {
  /** 当前可用模型桶(含 label / used)。 */
  buckets: AccessKeyBucket[];
  /** 受控值:每桶 token 上限 { bucket: number };缺省/0 = 无限。 */
  value: Record<string, number>;
  /** 变更回传整张映射(已剔除 <=0 的项)。 */
  onChange: (next: Record<string, number>) => void;
  /** 是否禁用(保存/加载中)。 */
  disabled?: boolean;
  blankLimitBehavior?: "unlimited" | "disabled";
}

export function ModelLimitsEditor({
  buckets,
  value,
  onChange,
  disabled,
  blankLimitBehavior = "unlimited",
}: ModelLimitsEditorProps) {
  // 「一键全部设为 X」输入框的本地值(不进父 value,仅作批量动作来源)。
  const [bulkValue, setBulkValue] = useState("");

  // 设定单个桶的上限:>0 写入,否则从映射中删除(回到无限)。
  const setBucketLimit = (bucket: string, raw: string) => {
    const num = Number(raw);
    const next = { ...value };
    if (raw.trim() !== "" && Number.isFinite(num) && num > 0) {
      next[bucket] = Math.floor(num);
    } else {
      delete next[bucket];
    }
    onChange(next);
  };

  // 「一键全部设为 X」:X>0 时给每个桶都写上同一上限;X 留空/<=0 时清空全部(全部回到无限)。
  const applyBulk = () => {
    const num = Number(bulkValue);
    if (bulkValue.trim() !== "" && Number.isFinite(num) && num > 0) {
      const next: Record<string, number> = {};
      for (const b of buckets) next[b.bucket] = Math.floor(num);
      onChange(next);
    } else {
      onChange({});
    }
  };

  // 已设上限的桶数,用于「无封顶」警示(一个都没设 = 完全无封顶)。
  const setCount = buckets.filter((b) => Number(value[b.bucket] || 0) > 0).length;
  const blankMeansDisabled = blankLimitBehavior === "disabled";
  const blankHint = blankMeansDisabled
    ? "留空 = 1, 代表该模型不可用"
    : "留空 = 该模型无限制";
  const emptyWarning = blankMeansDisabled
    ? "新增万能卡提交时, 未填写的模型会自动写入 1, 代表不可用。"
    : "当前未设任何模型限额 - 该卡无任何 token 封顶(万能卡尤其需谨慎)。";
  const rowPlaceholder = blankMeansDisabled ? "留空 = 1 / 不可用" : "留空 = 无限";

  if (buckets.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        暂无可设额度的模型(请先在「产品与绑定」中开通产品)。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 说明 + 一键全部 */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          为每个模型设置每窗口 token 上限,<strong>{blankHint}</strong>。这是绝对封顶。
        </p>
        <div className="flex items-center gap-1.5">
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            全部设为
          </span>
          <Input
            type="number"
            min={0}
            className="h-8 w-28 text-sm"
            placeholder="留空=清空"
            value={bulkValue}
            disabled={disabled}
            onChange={(e) => setBulkValue(e.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={applyBulk}
            disabled={disabled}
          >
            <WandSparklesIcon data-icon className="size-3.5" />
            应用
          </Button>
        </div>
      </div>

      {/* 一个都没设的警示(完全无封顶)。 */}
      {setCount === 0 && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {emptyWarning}
        </div>
      )}

      <Separator />

      {/* 逐桶编辑行 */}
      <div className="space-y-3">
        {buckets.map((b) => {
          const editVal = toInputString(value[b.bucket]);
          const limit = Number(value[b.bucket] || 0);
          const hasLimit = limit > 0;
          const usedPercent =
            hasLimit && limit > 0
              ? Math.min(100, (b.used / limit) * 100)
              : 0;
          const isOver = hasLimit && b.used >= limit;

          return (
            <div key={b.bucket} className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge
                    variant={isOver ? "destructive" : "secondary"}
                    className="text-xs"
                  >
                    {b.label}
                  </Badge>
                  {hasLimit && (
                    <span className="text-[10px] font-medium text-blue-500">
                      已设上限
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  已用{" "}
                  <span className="font-medium text-foreground">
                    {formatTokens(b.used)}
                  </span>{" "}
                  / {hasLimit ? formatTokens(limit) : "∞"}
                </div>
              </div>

              {/* 进度条(仅在设了上限时显示) */}
              {hasLimit && (
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full transition-all ${
                      isOver
                        ? "bg-destructive"
                        : usedPercent > 80
                          ? "bg-yellow-500"
                          : "bg-primary"
                    }`}
                    style={{ width: `${Math.min(100, usedPercent)}%` }}
                  />
                </div>
              )}

              {/* 编辑行 */}
              <div className="flex items-center gap-2">
                <span className="min-w-[40px] whitespace-nowrap text-xs text-muted-foreground">
                  限额:
                </span>
                <Input
                  type="number"
                  min={0}
                  className="h-8 text-sm"
                  placeholder={rowPlaceholder}
                  value={editVal}
                  disabled={disabled}
                  onChange={(e) => setBucketLimit(b.bucket, e.target.value)}
                />
                <span className="whitespace-nowrap text-xs text-muted-foreground">
                  tokens
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
