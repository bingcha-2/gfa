"use client";

// 额度可视化单元(表格「额度」列)—— 完全受控,只吃 listAccessKeys 下发的每卡摘要。
// 万能卡(pool):逐模型进度条「<模型> 已用/上限」——
//   - 设了上限:绿 <80% / 黄 80–100% / 红超额;
//   - 未设上限的模型:显示 ∞(无封顶,不画条);
//   - 一个模型都没设上限 → 「无封顶」红色警示 chip(全卡无 token 封顶)。
// 绑定卡(bound):只显示静态「份额 n/N」(这张卡占该账号几份)+(若设了模型封顶)逐模型条。
//   - 故意不画「公平额度%」血条:真实剩余是运行时值(服务端 FairShareTracker),列表接口
//     拿不到;用 weight/capacity 近似会误导(不随用量下降)。真实剩余看客户端 App / 「用量」弹窗。
// 沿用本目录现有进度条写法(裸 div + bg-* 颜色),与 model-limits-editor 保持一致。

import { Badge } from "@/components/ui/badge";
import { TriangleAlertIcon } from "lucide-react";
import type { AccessKeyBucket } from "./types";
import { formatTokens } from "@/lib/format";

/** 已用占比(0..100);limit<=0 视为无上限返回 0(不画条)。 */
function usedPercent(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(100, (used / limit) * 100);
}

/** 进度条颜色:超额红 / >80% 黄 / 否则主色绿(与 model-limits-editor 阈值一致)。 */
function barColorClass(used: number, limit: number): string {
  if (limit > 0 && used >= limit) return "bg-destructive";
  if (usedPercent(used, limit) > 80) return "bg-yellow-500";
  return "bg-primary";
}

/** 单条模型进度条行:「<标签> 已用/上限」+ 条(未设上限则显示 ∞,不画条)。 */
function BucketBar({ bucket }: { bucket: AccessKeyBucket }) {
  const limit = Number(bucket.limit || 0);
  const used = Number(bucket.used || 0);
  const hasLimit = limit > 0;
  const isOver = hasLimit && used >= limit;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="truncate text-muted-foreground" title={bucket.label}>
          {bucket.label}
        </span>
        <span
          className={`whitespace-nowrap tabular-nums ${
            isOver ? "font-medium text-destructive" : "text-muted-foreground"
          }`}
        >
          {formatTokens(used)} / {hasLimit ? formatTokens(limit) : "∞"}
        </span>
      </div>
      {hasLimit && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full transition-all ${barColorClass(used, limit)}`}
            style={{ width: `${usedPercent(used, limit)}%` }}
          />
        </div>
      )}
    </div>
  );
}

export interface QuotaCellProps {
  /** 卡类型:pool = 万能卡;bound = 绑定卡。 */
  cardType: "pool" | "bound";
  /** 模型桶摘要(pool 卡列全部产品桶;bound 卡仅列已绑产品桶)。 */
  buckets: AccessKeyBucket[];
  /** 卡级份额(份)。 */
  weight: number;
  /** 该卡所绑账号的份额容量(份);用于「份额 n/N」展示。默认 8。 */
  shareCapacity?: number;
}

export function QuotaCell({
  cardType,
  buckets,
  weight,
  shareCapacity = 8,
}: QuotaCellProps) {
  // 已设上限的桶(>0);用于万能卡「无封顶」警示判定。
  const cappedBuckets = buckets.filter((b) => Number(b.limit || 0) > 0);

  // ── 万能卡:逐模型条;一个都没设 = 无封顶警示 ──
  if (cardType === "pool") {
    if (buckets.length === 0) {
      return <span className="text-xs text-muted-foreground">-</span>;
    }
    if (cappedBuckets.length === 0) {
      // 完全无封顶:红色警示 chip(对齐 model-limits-editor 的告警语义)。
      return (
        <Badge
          variant="destructive"
          className="gap-1 text-[10px] font-medium"
        >
          <TriangleAlertIcon data-icon className="size-3" />
          无封顶
        </Badge>
      );
    }
    return (
      <div className="flex min-w-[160px] flex-col gap-1.5">
        {buckets.map((b) => (
          <BucketBar key={b.bucket} bucket={b} />
        ))}
      </div>
    );
  }

  // ── 绑定卡:只显示静态「份额 n/N」;若设了模型封顶再附逐模型条(绝对封顶)──
  const cardWeight = Math.max(1, Number(weight) || 1);
  const capacity = Math.max(cardWeight, Number(shareCapacity) || 8);

  return (
    <div className="flex min-w-[160px] flex-col gap-1.5">
      <span className="whitespace-nowrap text-[11px] text-muted-foreground">
        份额 {cardWeight}/{capacity}
      </span>

      {/* 若设了模型封顶,再附逐模型条(绝对封顶) */}
      {cappedBuckets.length > 0 &&
        cappedBuckets.map((b) => <BucketBar key={b.bucket} bucket={b} />)}
    </div>
  );
}
