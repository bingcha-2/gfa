"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIcon, BotIcon, DatabaseIcon, GaugeIcon, RefreshCwIcon, SparklesIcon } from "lucide-react";
import { toast } from "sonner";
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatTokens } from "@/lib/format";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Spinner } from "@/components/ui/spinner";
import { ProviderSupplyOverview } from "./ProviderSupplyOverview";
import { BoundCardAccordion } from "./BoundCardAccordion";

type ModelStat = {
  key: string;
  displayName: string;
  bucket: string;
  poolSize: number;
  available: number;
  withData: number;
  lowestRemaining: number | null;
  medianRemaining: number | null;
  bestRemaining: number | null;
  lowCount: number;
  distribution: import("./distribution").Distribution;
};

type ProviderStats = {
  id: string;
  mode: string;
  accounts: { total: number; enabled: number; ok: number; cooling: number; exhausted: number; error: number };
  usage: { dailyTokensUsed: number; activeLeases: number; totalLeases: number; totalReports: number };
  models: ModelStat[];
};

const PROVIDER_LABEL: Record<string, string> = { antigravity: "Antigravity", codex: "Codex", anthropic: "Anthropic" };
const PROVIDER_ICON: Record<string, React.ReactNode> = {
  antigravity: <DatabaseIcon className="size-4" />,
  codex: <BotIcon className="size-4" />,
  anthropic: <SparklesIcon className="size-4" />,
};

const trendConfig = {
  antigravity: { label: "Antigravity", color: "var(--chart-1)" },
  codex: { label: "Codex", color: "var(--chart-2)" },
  anthropic: { label: "Anthropic", color: "var(--chart-3)" },
};

type TrendDay = {
  date: string;
  antigravity: number;
  codex: number;
  anthropic: number;
  totalTokens: number;
  requests: number;
};

// `tokens`/`totalTokens` 是计费口径(billable,缓存读已 1/10 折);其余字段是拆分,
// 解释"为什么计费 token 比净对话大"(cacheWrite = prompt-cache 写入,按全价计入)。
type ProviderUsage = {
  tokens: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
};

type TodayUsage = {
  date: string;
  totalTokens: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  byProvider: Record<string, ProviderUsage>;
};

// ── /api/remote-stats/dashboard shapes ──────────────────────────────────────
type FairShareEntry = { fraction: number; resetAt: number };
type DashboardCard = {
  id: string;
  name: string;
  weight: number;
  windowWeightedUsed: number;
  totalTokensUsed: number;
  totalRequests: number;
  fairShare: Record<string, FairShareEntry>;
  usageTrend: { date: string; totalTokens: number; requests: number }[];
  usageTotals: { totalTokens: number; requests: number };
  hourlyFrequency: { hour: number; requests: number; totalTokens: number }[];
};
type WaterPoint = {
  modelKey: string;
  hourlyPercent: number | null;
  weeklyPercent: number | null;
  hourlyResetAt: string | null;
  weeklyResetAt: string | null;
};
type DashboardAccount = {
  id: number;
  email: string;
  planType: string;
  quotaStatus: string;
  activeLeases: number;
  hourlyPercent: number | null;
  weeklyPercent: number | null;
  hourlyResetAt: string | null;
  weeklyResetAt: string | null;
  water: WaterPoint[];
  waterHistory: { timestamp: string; modelKey: string; hourlyPercent: number | null; weeklyPercent: number | null }[];
  boundCards: DashboardCard[];
};
type DashboardProduct = {
  id: string;
  mode: string;
  accounts: DashboardAccount[];
  totalAccounts?: number;
};

export default function UsageStatsPage() {
  const [providers, setProviders] = useState<ProviderStats[]>([]);
  const [today, setToday] = useState<TodayUsage | null>(null);
  const [trend, setTrend] = useState<TrendDay[]>([]);
  const [trendDays, setTrendDays] = useState(7);
  const [dashboard, setDashboard] = useState<DashboardProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchStats = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const [statsRes, todayRes] = await Promise.all([
        fetch("/api/remote-stats", { cache: "no-store" }),
        fetch("/api/rosetta/token-usage-today", { cache: "no-store" }),
      ]);
      if (!statsRes.ok) throw new Error(`HTTP ${statsRes.status}`);
      const data = await statsRes.json();
      setProviders(Array.isArray(data.providers) ? data.providers : []);
      if (todayRes.ok) setToday(await todayRes.json());
    } catch (error) {
      if (!silent) toast.error(`获取统计失败: ${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      if (!silent) setRefreshing(false);
    }
  }, []);

  const fetchTrend = useCallback(async (days: number) => {
    try {
      const res = await fetch(`/api/rosetta/token-usage-trend?days=${days}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setTrend(Array.isArray(data.daily) ? data.daily : []);
      }
    } catch {
      /* non-critical */
    }
  }, []);

  // Heavier per-account/per-card detail. Fetched on load + manual refresh only
  // (kept out of the 30s poll so the cheap supply rollup stays snappy).
  const fetchDashboard = useCallback(async () => {
    try {
      const res = await fetch("/api/remote-stats/dashboard", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setDashboard(Array.isArray(data.products) ? data.products : []);
      }
    } catch {
      /* non-critical */
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([fetchStats(true), fetchDashboard()]);
      setLoading(false);
    })();
    const t = setInterval(() => fetchStats(true), 30_000);
    return () => clearInterval(t);
  }, [fetchStats, fetchDashboard]);

  useEffect(() => {
    fetchTrend(trendDays);
  }, [fetchTrend, trendDays]);

  const totals = useMemo(() => {
    return providers.reduce(
      (acc, p) => {
        acc.accountsTotal += p.accounts.total;
        acc.accountsEnabled += p.accounts.enabled;
        acc.accountsOk += p.accounts.ok;
        acc.activeLeases += p.usage.activeLeases;
        acc.dailyTokens += p.usage.dailyTokensUsed;
        return acc;
      },
      { accountsTotal: 0, accountsEnabled: 0, accountsOk: 0, activeLeases: 0, dailyTokens: 0 },
    );
  }, [providers]);

  if (loading) {
    return (
      <div className="flex min-h-[360px] items-center justify-center">
        <Spinner size={24} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">用量与剩余</h1>
          <p className="mt-1 text-sm text-muted-foreground">跨 Provider 看板:账号健康、使用总量、各模型剩余配额。</p>
        </div>
        <Button variant="outline" onClick={() => { fetchStats(); fetchDashboard(); }} disabled={refreshing} className="cursor-pointer">
          {refreshing ? <Spinner size={14} /> : <RefreshCwIcon className="size-4" />}
          刷新
        </Button>
      </div>

      {/* Cross-provider KPI strip */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile icon={<DatabaseIcon className="size-4" />} label="启用账号" value={`${totals.accountsEnabled}/${totals.accountsTotal}`} sub={`健康 ${totals.accountsOk}`} />
        <KpiTile
          icon={<GaugeIcon className="size-4" />}
          label="在租租约"
          value={String(totals.activeLeases)}
          sub="未过期租约 · 非实时在飞"
        />
        <KpiTile
          icon={<ActivityIcon className="size-4" />}
          label="今日计费 Token"
          value={formatTokens(today?.totalTokens ?? totals.dailyTokens)}
          sub={today ? `北京时间 ${today.date} · ${today.requests.toLocaleString()} 次 · 缓写 ${formatTokens(today.cacheWriteTokens ?? 0)}` : undefined}
        />
        <KpiTile icon={<BotIcon className="size-4" />} label="Provider" value={String(providers.length)} sub={providers.map((p) => PROVIDER_LABEL[p.id] || p.id).join(" · ")} />
      </div>

      <UsageTrendCard trend={trend} days={trendDays} onDaysChange={setTrendDays} />

      {providers.map((p) => {
        const dp = dashboard.find((d) => d.id === p.id);
        return (
          <ProviderBoard
            key={p.id}
            provider={p}
            today={today?.byProvider?.[p.id]}
            accounts={dp?.accounts ?? []}
            totalAccounts={dp?.totalAccounts}
          />
        );
      })}
    </div>
  );
}

function formatDayLabel(date: string): string {
  // date is "YYYY-MM-DD" already in Beijing time — format without re-parsing as UTC.
  const [, m, d] = date.split("-");
  return `${Number(m)}月${Number(d)}日`;
}

function UsageTrendCard({
  trend,
  days,
  onDaysChange,
}: {
  trend: TrendDay[];
  days: number;
  onDaysChange: (days: number) => void;
}) {
  const total = trend.reduce((a, d) => a + d.totalTokens, 0);
  const hasData = trend.some((d) => d.totalTokens > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Token 用量趋势</CardTitle>
        <CardDescription>
          全部卡密 · 北京时间 · 近 {days} 天合计 {formatTokens(total)} token
        </CardDescription>
        <CardAction>
          <ToggleGroup
            multiple={false}
            value={[String(days)]}
            onValueChange={(value) => {
              const next = value[0];
              if (next) onDaysChange(Number(next));
            }}
            variant="outline"
            size="sm"
          >
            <ToggleGroupItem value="7" className="px-4">
              7 天
            </ToggleGroupItem>
            <ToggleGroupItem value="30" className="px-4">
              30 天
            </ToggleGroupItem>
          </ToggleGroup>
        </CardAction>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        {!hasData ? (
          <div className="py-10 text-center text-sm text-muted-foreground">所选范围内暂无用量数据</div>
        ) : (
          <ChartContainer config={trendConfig} className="aspect-auto h-[260px] w-full">
            <AreaChart data={trend} margin={{ left: 12, right: 12 }}>
              <defs>
                <linearGradient id="fillAntigravity" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-antigravity)" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="var(--color-antigravity)" stopOpacity={0.1} />
                </linearGradient>
                <linearGradient id="fillCodex" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-codex)" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="var(--color-codex)" stopOpacity={0.1} />
                </linearGradient>
                <linearGradient id="fillAnthropic" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-anthropic)" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="var(--color-anthropic)" stopOpacity={0.1} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={28}
                tickFormatter={formatDayLabel}
              />
              <ChartTooltip
                cursor={false}
                content={<ChartTooltipContent labelFormatter={(v) => formatDayLabel(String(v))} formatter={(v) => formatTokens(Number(v))} indicator="dot" />}
              />
              <Area
                dataKey="antigravity"
                type="natural"
                fill="url(#fillAntigravity)"
                stroke="var(--color-antigravity)"
                stackId="t"
              />
              <Area
                dataKey="codex"
                type="natural"
                fill="url(#fillCodex)"
                stroke="var(--color-codex)"
                stackId="t"
              />
              <Area
                dataKey="anthropic"
                type="natural"
                fill="url(#fillAnthropic)"
                stroke="var(--color-anthropic)"
                stackId="t"
              />
              <ChartLegend content={<ChartLegendContent />} />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

function KpiTile({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        <span className="text-muted-foreground">{icon}</span>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        {sub ? <div className="mt-1 text-xs text-muted-foreground">{sub}</div> : null}
      </CardContent>
    </Card>
  );
}

function ProviderBoard({
  provider: p,
  today,
  accounts = [],
  totalAccounts,
}: {
  provider: ProviderStats;
  today?: ProviderUsage;
  accounts?: DashboardAccount[];
  totalAccounts?: number;
}) {
  // Most-constrained models first: fewest available accounts, then lowest water level.
  const models = useMemo(
    () =>
      [...p.models].sort((a, b) => {
        if (a.available !== b.available) return a.available - b.available;
        return (a.lowestRemaining ?? 1) - (b.lowestRemaining ?? 1);
      }),
    [p.models],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {PROVIDER_ICON[p.id]}
          {PROVIDER_LABEL[p.id] || p.id}
          <span className="text-xs font-normal text-muted-foreground">{p.mode}</span>
        </CardTitle>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="secondary">账号 {p.accounts.enabled}/{p.accounts.total}</Badge>
          <Badge variant="default">正常 {p.accounts.ok}</Badge>
          {p.accounts.cooling > 0 && <Badge variant="outline">冷却 {p.accounts.cooling}</Badge>}
          {p.accounts.exhausted > 0 && <Badge variant="outline">耗尽 {p.accounts.exhausted}</Badge>}
          {p.accounts.error > 0 && <Badge variant="destructive">异常 {p.accounts.error}</Badge>}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <MiniStat
            label="今日计费 Token"
            value={formatTokens(today?.tokens ?? 0)}
            hint={`净入 ${formatTokens(today?.inputTokens ?? 0)} · 出 ${formatTokens(today?.outputTokens ?? 0)} · 缓写 ${formatTokens(today?.cacheWriteTokens ?? 0)} · 缓读 ${formatTokens(today?.cacheReadTokens ?? 0)}`}
          />
          <MiniStat label="今日请求" value={(today?.requests ?? 0).toLocaleString()} hint="产生用量的成功调用" />
          <MiniStat label="在租租约" value={String(p.usage.activeLeases)} hint="未过期租约 · 非实时在飞" />
        </div>

        {models.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">暂无模型数据</div>
        ) : (
          <ProviderSupplyOverview models={models} />
        )}

        {accounts.length > 0 ? (
          <div>
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-sm font-medium">账号绑定卡明细</span>
              <span className="text-xs text-muted-foreground">
                有数据 {accounts.length}
                {typeof totalAccounts === "number" ? ` / 共 ${totalAccounts}` : ""} 账号
              </span>
            </div>
            <BoundCardAccordion accounts={accounts} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function MiniStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      {hint ? <div className="mt-0.5 text-[10px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}
