"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BotIcon, KeyRoundIcon, RefreshCwIcon, ServerIcon } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type CodexAccountStatus = {
  id: number;
  email: string;
  enabled: boolean;
  planType: string;
  activeLeases: number;
  blockedUntil: number;
  quotaStatus: string;
  codexHourlyPercent: number | null;
  codexWeeklyPercent: number | null;
  codexHourlyResetTime: string;
  codexWeeklyResetTime: string;
  modelQuotaRefreshedAt: number;
};

type CodexAccountStats = {
  totalTokensUsed?: number;
};

type CodexStatus = {
  running: boolean;
  mode: string;
  totalLeases: number;
  totalReports: number;
  totalErrors: number;
  lastError: string;
  activeLeases: number;
  accounts: { total: number; enabled: number };
  accessKeys: { total: number; active: number };
  quota: { accounts: CodexAccountStatus[] };
  scheduler?: { accountStats?: Record<string, CodexAccountStats> };
};

function formatTime(value: string | number) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function formatTokenCount(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function quotaBarColor(pct: number): string {
  if (pct > 60) return "bg-emerald-500";
  if (pct > 25) return "bg-amber-500";
  return "bg-red-500";
}

function quotaTextColor(pct: number): string {
  if (pct > 60) return "text-emerald-500";
  if (pct > 25) return "text-amber-500";
  return "text-red-500";
}

function formatRefreshedAt(ts: number | undefined | null): string {
  const n = Number(ts || 0);
  if (!n) return "";
  try {
    return new Date(n).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function formatResetTime(rt: string): string {
  if (!rt) return "";
  try {
    const diff = new Date(rt).getTime() - Date.now();
    if (Number.isNaN(diff)) return "";
    if (diff <= 0) return "已重置";
    const dayMs = 24 * 3600000;
    if (diff >= dayMs) {
      const days = Math.floor(diff / dayMs);
      const hours = Math.floor((diff % dayMs) / 3600000);
      return hours > 0 ? `${days}天 ${hours}小时` : `${days}天`;
    }
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  } catch {
    return "";
  }
}

/** 5h / weekly remaining-quota progress bar. `percent` is the remaining %. */
function QuotaBar({
  percent,
  resetTime,
  refreshedAt,
}: {
  percent: number | null;
  resetTime: string;
  refreshedAt: number;
}) {
  if (percent == null) {
    return <span className="text-xs text-muted-foreground">暂无</span>;
  }
  const reset = formatResetTime(resetTime);
  const refreshed = formatRefreshedAt(refreshedAt);
  return (
    <Tooltip>
      <TooltipTrigger className="flex min-w-[120px] flex-col gap-1 text-left">
        <div className="flex items-center justify-between gap-2">
          <span className={cn("text-xs font-semibold tabular-nums", quotaTextColor(percent))}>
            {Math.round(percent)}%
          </span>
          <span className="text-[10px] text-muted-foreground">{reset || "未记录重置"}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full transition-all duration-500", quotaBarColor(percent))}
            style={{ width: `${percent}%` }}
          />
        </div>
      </TooltipTrigger>
      <TooltipContent>
        剩余 {Math.round(percent)}%
        <br />
        重置: {reset || "未记录"}
        <br />
        更新: {refreshed || "未刷新"}
      </TooltipContent>
    </Tooltip>
  );
}

export default function CodexProxyPage() {
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const res = await fetch("/api/app/lease/codex/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(await res.json());
    } catch (error) {
      if (!silent) toast.error(`获取 Codex 状态失败: ${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      if (!silent) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    async function init() {
      setLoading(true);
      await fetchStatus(true);
      setLoading(false);
    }
    init();
    intervalRef.current = setInterval(() => fetchStatus(true), 30_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchStatus]);

  async function reloadAccessKeys() {
    setRefreshing(true);
    try {
      const res = await fetch("/api/app/lease/codex/reload-access-keys", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // The reload endpoint returns { ok, reloaded }, not a status payload —
      // re-fetch the real status instead of blanking the dashboard with undefined.
      await fetchStatus(true);
      toast.success("共享卡密已重载");
    } catch (error) {
      toast.error(`重载失败: ${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setRefreshing(false);
    }
  }

  const cards = useMemo(() => {
    return [
      { title: "账号池", value: `${status?.accounts.enabled ?? 0}/${status?.accounts.total ?? 0}`, icon: <BotIcon className="size-4" /> },
      { title: "共享卡密", value: `${status?.accessKeys.active ?? 0}/${status?.accessKeys.total ?? 0}`, icon: <KeyRoundIcon className="size-4" /> },
      { title: "活跃租约", value: `${status?.activeLeases ?? 0}`, icon: <ServerIcon className="size-4" /> },
      { title: "累计上报", value: `${status?.totalReports ?? 0}`, icon: <RefreshCwIcon className="size-4" /> },
    ];
  }, [status]);

  if (loading) {
    return (
      <div className="flex min-h-[360px] items-center justify-center">
        <Spinner size={24} />
      </div>
    );
  }

  return (
    <TooltipProvider>
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">Codex 负载看板</h1>
          <p className="mt-1 text-sm text-muted-foreground">Codex 远程租约服务运行态:账号健康、活跃租约与本地 /v1/* 网关状态。</p>
        </div>
        <Button variant="outline" onClick={() => fetchStatus()} disabled={refreshing}>
          {refreshing ? <Spinner size={14} /> : <RefreshCwIcon className="size-4" />}
          刷新
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        {cards.map((item) => (
          <Card key={item.title}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{item.title}</CardTitle>
              <span className="text-muted-foreground">{item.icon}</span>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold">{item.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>服务状态</CardTitle>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <Badge variant={status?.running ? "default" : "destructive"}>{status?.running ? "运行中" : "异常"}</Badge>
              <span>{status?.mode || "remote-codex-server"}</span>
              <span>错误 {status?.totalErrors ?? 0}</span>
            </div>
          </div>
          <Button variant="outline" onClick={reloadAccessKeys} disabled={refreshing}>
            重载卡密
          </Button>
        </CardHeader>
        {status?.lastError ? (
          <CardContent>
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {status.lastError}
            </div>
          </CardContent>
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Codex 账号池</CardTitle>
        </CardHeader>
        <CardContent>
          {!status?.quota?.accounts?.length ? (
            <div className="py-8 text-center text-sm text-muted-foreground">暂无 Codex 账号</div>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[60px]">#</TableHead>
                    <TableHead>账号</TableHead>
                    <TableHead className="w-[110px]">套餐</TableHead>
                    <TableHead className="w-[150px]">5h 剩余</TableHead>
                    <TableHead className="w-[150px]">周剩余</TableHead>
                    <TableHead className="w-[90px] text-right">Token</TableHead>
                    <TableHead className="w-[160px]">状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {status.quota.accounts.map((account) => {
                    const tokensUsed = Number(
                      status.scheduler?.accountStats?.[String(account.id)]?.totalTokensUsed || 0,
                    );
                    return (
                      <TableRow key={account.id}>
                        <TableCell className="font-medium">#{account.id}</TableCell>
                        <TableCell>{account.email}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{account.planType || "unknown"}</Badge>
                        </TableCell>
                        <TableCell>
                          <QuotaBar
                            percent={account.codexHourlyPercent}
                            resetTime={account.codexHourlyResetTime}
                            refreshedAt={account.modelQuotaRefreshedAt}
                          />
                        </TableCell>
                        <TableCell>
                          <QuotaBar
                            percent={account.codexWeeklyPercent}
                            resetTime={account.codexWeeklyResetTime}
                            refreshedAt={account.modelQuotaRefreshedAt}
                          />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatTokenCount(tokensUsed)}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          <div className="flex items-center gap-2">
                            <Badge variant={account.enabled ? "default" : "secondary"}>
                              {account.enabled ? "启用" : "禁用"}
                            </Badge>
                            <span>租约 {account.activeLeases}</span>
                          </div>
                          <div>状态 {account.quotaStatus || "ok"}</div>
                          {account.blockedUntil ? <div>冷却至 {formatTime(account.blockedUntil)}</div> : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
          <Separator className="my-4" />
          <div className="text-sm text-muted-foreground">
            服务端读取独立的 codex-accounts.json 作为 Codex OAuth 账号池；卡密与用量记录复用 access-keys.json。
          </div>
        </CardContent>
      </Card>
    </div>
    </TooltipProvider>
  );
}
