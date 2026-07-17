"use client";

import { useMemo, useState } from "react";
import { TriangleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AccountQuotaPoolSheet } from "./account-quota-pool-sheet";
import {
  confidenceLabel,
  formatCoverage,
  formatQuotaPercent,
  formatQuotaUsd,
  type QuotaPoolConfidence,
  type QuotaPoolSummary,
  type QuotaPoolTarget,
} from "./quota-pool-types";

type ProviderFilter = "all" | "codex" | "anthropic";
type RiskFilter = "all" | "risk" | "insufficient";

function worstConfidence(pool: QuotaPoolSummary): QuotaPoolConfidence {
  const rank: Record<QuotaPoolConfidence, number> = {
    unavailable: 0,
    insufficient: 1,
    low: 2,
    medium: 3,
    high: 4,
  };
  const reported = [pool.fiveHour.confidence, pool.weekly.confidence]
    .filter((confidence) => confidence !== "unavailable");
  if (!reported.length) return "unavailable";
  return reported.reduce((worst, confidence) => (
    rank[confidence] < rank[worst] ? confidence : worst
  ));
}

function refreshedAgo(value: number): string {
  if (!value) return "从未";
  const diff = Math.max(0, Date.now() - value);
  if (diff < 60_000) return "刚刚";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} 分前`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))} 时前`;
  return `${Math.floor(diff / (24 * 60 * 60_000))} 天前`;
}

function scopeValue(pool: QuotaPoolSummary, scope: "fiveHour" | "weekly") {
  const value = pool[scope];
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-medium tabular-nums">{formatQuotaPercent(value.remainingPercent)}</span>
      <span className="text-xs text-muted-foreground tabular-nums">≈ {formatQuotaUsd(value.inferredRemainingUsd)}</span>
    </div>
  );
}

export function QuotaPoolOverview({
  pools,
  onChanged,
}: {
  pools: QuotaPoolSummary[];
  onChanged?: () => void | Promise<void>;
}) {
  const [provider, setProvider] = useState<ProviderFilter>("all");
  const [risk, setRisk] = useState<RiskFilter>("all");
  const [target, setTarget] = useState<QuotaPoolTarget | null>(null);

  const visible = useMemo(() => pools
    .filter((pool) => provider === "all" || pool.provider === provider)
    .filter((pool) => {
      if (risk === "risk") return pool.alert === "danger" || pool.alert === "warning";
      if (risk === "insufficient") return pool.alert === "insufficient";
      return true;
    })
    .sort((a, b) => {
      if (a.minCoverageRatio === null && b.minCoverageRatio === null) return a.accountId - b.accountId;
      if (a.minCoverageRatio === null) return 1;
      if (b.minCoverageRatio === null) return -1;
      return a.minCoverageRatio - b.minCoverageRatio;
    }), [pools, provider, risk]);

  const dangerCount = pools.filter((pool) => pool.alert === "danger").length;
  const warningCount = pools.filter((pool) => pool.alert === "warning").length;
  const insufficientCount = pools.filter((pool) => pool.alert === "insufficient").length;

  return (
    <div className="flex flex-col gap-4">
      {dangerCount || warningCount ? (
        <Alert variant={dangerCount ? "destructive" : "default"}>
          <TriangleAlertIcon />
          <AlertTitle>额度池需要关注</AlertTitle>
          <AlertDescription>
            覆盖不足 {dangerCount} 个，接近边界 {warningCount} 个，采样不足 {insufficientCount} 个。列表已按最低覆盖率排序。
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <ToggleGroup
          multiple={false}
          value={[provider]}
          onValueChange={(value) => setProvider((value[0] as ProviderFilter) || "all")}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="all">全部</ToggleGroupItem>
          <ToggleGroupItem value="codex">Codex</ToggleGroupItem>
          <ToggleGroupItem value="anthropic">Anthropic</ToggleGroupItem>
        </ToggleGroup>
        <ToggleGroup
          multiple={false}
          value={[risk]}
          onValueChange={(value) => setRisk((value[0] as RiskFilter) || "all")}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="all">全部状态</ToggleGroupItem>
          <ToggleGroupItem value="risk">覆盖风险</ToggleGroupItem>
          <ToggleGroupItem value="insufficient">采样不足</ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <Table className="min-w-[1060px]">
          <TableHeader>
            <TableRow>
              <TableHead>母号</TableHead>
              <TableHead>产品 / 套餐</TableHead>
              <TableHead>5h 剩余</TableHead>
              <TableHead>周剩余</TableHead>
              <TableHead>推算整池 5h / 周</TableHead>
              <TableHead>已售额度 5h / 周</TableHead>
              <TableHead>最低覆盖</TableHead>
              <TableHead>可信度</TableHead>
              <TableHead>刷新</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length ? visible.map((pool) => (
              <TableRow key={`${pool.provider}:${pool.accountId}`}>
                <TableCell>
                  <Button
                    variant="link"
                    className="h-auto max-w-64 justify-start px-0 py-0 text-left"
                    onClick={() => setTarget({ provider: pool.provider, id: pool.accountId, email: pool.email })}
                  >
                    <span className="truncate">#{pool.accountId} · {pool.email || "未知邮箱"}</span>
                  </Button>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    <span>{pool.provider === "codex" ? "Codex" : "Anthropic"}</span>
                    <span className="text-xs text-muted-foreground">{pool.planType || "未知套餐"}</span>
                  </div>
                </TableCell>
                <TableCell>{scopeValue(pool, "fiveHour")}</TableCell>
                <TableCell>{scopeValue(pool, "weekly")}</TableCell>
                <TableCell className="font-mono text-xs tabular-nums">
                  {formatQuotaUsd(pool.fiveHour.inferredTotalUsd)} / {formatQuotaUsd(pool.weekly.inferredTotalUsd)}
                </TableCell>
                <TableCell className="font-mono text-xs tabular-nums">
                  {formatQuotaUsd(pool.fiveHour.soldLimitUsd)} / {formatQuotaUsd(pool.weekly.soldLimitUsd)}
                </TableCell>
                <TableCell>
                  <Badge variant={pool.alert === "danger" ? "destructive" : pool.alert === "ok" ? "secondary" : "outline"}>
                    {formatCoverage(pool.minCoverageRatio)}
                  </Badge>
                </TableCell>
                <TableCell><Badge variant="outline">{confidenceLabel(worstConfidence(pool))}</Badge></TableCell>
                <TableCell className="text-xs text-muted-foreground">{refreshedAgo(pool.refreshedAt)}</TableCell>
              </TableRow>
            )) : (
              <TableRow>
                <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">当前筛选没有母号额度池</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <AccountQuotaPoolSheet
        target={target}
        onOpenChange={(open) => !open && setTarget(null)}
        onChanged={onChanged}
      />
    </div>
  );
}
