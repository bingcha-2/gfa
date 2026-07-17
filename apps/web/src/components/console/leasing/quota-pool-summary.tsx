"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  confidenceLabel,
  formatCoverage,
  formatQuotaPercent,
  formatQuotaUsd,
  type QuotaPoolScope,
  type QuotaPoolSummary,
} from "./quota-pool-types";

export function QuotaPoolScopeCell({
  scope,
  onOpen,
}: {
  scope?: QuotaPoolScope | null;
  onOpen?: () => void;
}) {
  if (!scope) return <span className="text-muted-foreground">—</span>;
  const hasEstimate = scope.inferredTotalUsd !== null && scope.inferredRemainingUsd !== null;
  const content = (
    <>
      <span className="font-medium tabular-nums">{formatQuotaPercent(scope.remainingPercent)}</span>
      <span className="text-[11px] text-muted-foreground tabular-nums">
        {hasEstimate
          ? `≈ ${formatQuotaUsd(scope.inferredRemainingUsd)} / ${formatQuotaUsd(scope.inferredTotalUsd)}`
          : confidenceLabel(scope.confidence)}
      </span>
    </>
  );

  return (
    <Tooltip>
      <TooltipTrigger
        render={onOpen
          ? <Button variant="ghost" size="sm" className="h-auto min-w-24 flex-col items-start gap-0.5 px-1 py-1" onClick={onOpen} />
          : undefined}
        className={onOpen ? undefined : "flex min-w-24 flex-col items-start gap-0.5 text-left"}
      >
        {content}
      </TooltipTrigger>
      <TooltipContent className="flex max-w-72 flex-col items-start gap-1">
        <span>{confidenceLabel(scope.confidence)} · API 原价等价估算</span>
        <span>已追踪 {formatQuotaUsd(scope.trackedUsedUsd)} · 已售 {formatQuotaUsd(scope.soldLimitUsd)}</span>
        {scope.reasons[0] ? <span>{scope.reasons[0]}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}

export function QuotaPoolCoverageBadge({ pool }: { pool?: QuotaPoolSummary | null }) {
  if (!pool || pool.minCoverageRatio === null) {
    return <Badge variant="outline">采样不足</Badge>;
  }
  const variant = pool.alert === "danger" ? "destructive" : pool.alert === "ok" ? "secondary" : "outline";
  return <Badge variant={variant}>最低覆盖 {formatCoverage(pool.minCoverageRatio)}</Badge>;
}
