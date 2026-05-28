import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import type { QuotaDisplayItem } from "./types";
import { quotaBarColor, quotaTextColor, formatResetTime, formatQuotaRefreshedAt } from "./constants";

export function ModelQuotaCell({
  item,
  refreshedAt,
}: {
  item: QuotaDisplayItem | null;
  refreshedAt?: number;
}) {
  if (!item) {
    return <span className="text-xs text-muted-foreground">暂无</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger className="flex min-w-[140px] flex-col gap-1 text-left">
        <div className="flex items-center justify-between gap-2">
          <span className={cn("text-xs font-semibold tabular-nums", quotaTextColor(item.percentage))}>
            {item.percentage}%
          </span>
          <span className="text-[10px] text-muted-foreground">
            {item.resetTime ? formatResetTime(item.resetTime) : "未记录重置"}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500",
              quotaBarColor(item.percentage),
            )}
            style={{ width: `${item.percentage}%` }}
          />
        </div>
      </TooltipTrigger>
      <TooltipContent>
        {item.label}
        <br />
        重置: {item.resetTime ? formatResetTime(item.resetTime) : "未记录"}
        <br />
        更新: {formatQuotaRefreshedAt(refreshedAt) || "未刷新"}
      </TooltipContent>
    </Tooltip>
  );
}
