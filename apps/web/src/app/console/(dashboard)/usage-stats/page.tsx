"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIcon, AlertTriangleIcon, BotIcon, DatabaseIcon, GaugeIcon, RefreshCwIcon, SparklesIcon, CreditCardIcon } from "lucide-react";
import { toast } from "sonner";
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Spinner } from "@/components/ui/spinner";

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

// remaining fraction → bar color (green healthy / amber low / red depleted)
function barColor(remaining: number) {
  if (remaining >= 50) return "var(--chart-2, #22c55e)";
  if (remaining >= 20) return "var(--chart-4, #f59e0b)";
  return "var(--destructive, #ef4444)";
}

type ProviderUsage = { tokens: number; requests: number };

type TodayUsage = {
  date: string;
  totalTokens: number;
  requests: number;
  byProvider: Record<string, ProviderUsage>;
};

// ── /api/remote-stats/dashboard shapes ──────────────────────────────────────
type FairShareEntry = { fraction: number; resetAt: number };
type DashboardCard = {
  id: string;
  name: string;
  weight: number;
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
          label="当前并发"
          value={String(totals.activeLeases)}
          sub="实时取号 · 重启清零"
        />
        <KpiTile
          icon={<ActivityIcon className="size-4" />}
          label="今日 Token"
          value={(today?.totalTokens ?? totals.dailyTokens).toLocaleString()}
          sub={today ? `北京时间 ${today.date} · ${today.requests.toLocaleString()} 次` : undefined}
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
          全部卡密 · 北京时间 · 近 {days} 天合计 {total.toLocaleString()} token
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
                content={<ChartTooltipContent labelFormatter={(v) => formatDayLabel(String(v))} indicator="dot" />}
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
  const models = [...p.models].sort((a, b) => {
    if (a.available !== b.available) return a.available - b.available;
    return (a.lowestRemaining ?? 1) - (b.lowestRemaining ?? 1);
  });
  const warnModels = p.models.filter((m) => m.available === 0 || m.lowCount > 0).length;

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
          <MiniStat label="今日 Token" value={(today?.tokens ?? 0).toLocaleString()} />
          <MiniStat label="今日请求" value={(today?.requests ?? 0).toLocaleString()} />
          <MiniStat label="当前并发" value={String(p.usage.activeLeases)} hint="实时·重启清零" />
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">各模型供给(可用账号 / 余量水位)</span>
            {warnModels > 0 ? (
              <span className="flex items-center gap-1 text-xs text-destructive">
                <AlertTriangleIcon className="size-3" />
                {warnModels} 个模型紧张
              </span>
            ) : null}
          </div>
          {models.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">暂无模型数据</div>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>模型</TableHead>
                    <TableHead className="w-24 text-center">可用账号</TableHead>
                    <TableHead className="w-44">余量水位(最低)</TableHead>
                    <TableHead className="w-20 text-right">中位</TableHead>
                    <TableHead className="w-24 text-right">预警</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {models.map((m) => (
                    <ModelSupplyRow key={m.key} model={m} />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        {accounts.length > 0 ? (
          <div>
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-sm font-medium">账号水位与绑定卡明细</span>
              <span className="text-xs text-muted-foreground">
                有数据 {accounts.length}
                {typeof totalAccounts === "number" ? ` / 共 ${totalAccounts}` : ""} 账号
              </span>
            </div>
            <div className="grid gap-3">
              {accounts.map((a) => (
                <AccountDetailCard key={a.id} account={a} />
              ))}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

const QUOTA_STATUS_LABEL: Record<string, string> = {
  ok: "正常",
  cooling: "冷却",
  exhausted: "耗尽",
  error: "异常",
};

function AccountDetailCard({ account: a }: { account: DashboardAccount }) {
  const statusVariant: "default" | "outline" | "destructive" =
    a.quotaStatus === "ok" ? "default" : a.quotaStatus === "error" ? "destructive" : "outline";
  // 5h water sparkline series (chronological hourlyPercent across snapshots).
  const spark = a.waterHistory
    .map((h) => (typeof h.hourlyPercent === "number" ? h.hourlyPercent : null))
    .filter((v): v is number => v !== null);

  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="truncate text-sm font-medium">{a.email || `账号 #${a.id}`}</span>
        {a.planType ? <Badge variant="secondary">{a.planType}</Badge> : null}
        <Badge variant={statusVariant}>{QUOTA_STATUS_LABEL[a.quotaStatus] || a.quotaStatus}</Badge>
        {a.activeLeases > 0 ? <Badge variant="outline">并发 {a.activeLeases}</Badge> : null}
        {spark.length > 1 ? (
          <span className="ml-auto">
            <Sparkline values={spark} />
          </span>
        ) : null}
      </div>

      {/* Per-model 5h / 周 water bars */}
      {a.water.length > 0 ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {a.water.map((w) => (
            <div key={w.modelKey} className="rounded-md bg-muted/40 p-2">
              <div className="mb-1 truncate text-xs font-medium text-muted-foreground">{w.modelKey}</div>
              <WaterBar label="5h" pct={w.hourlyPercent} resetAt={w.hourlyResetAt} />
              {typeof w.weeklyPercent === "number" ? (
                <div className="mt-1">
                  <WaterBar label="周" pct={w.weeklyPercent} resetAt={w.weeklyResetAt} />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-2 text-xs text-muted-foreground">暂无水位快照(账号有调用后开始累积)</div>
      )}

      {/* Bound cards */}
      {a.boundCards.length > 0 ? (
        <div className="mt-3 overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>绑定卡</TableHead>
                <TableHead className="w-16 text-center">权重</TableHead>
                <TableHead className="w-28 text-right">累计 Token</TableHead>
                <TableHead className="w-20 text-right">请求</TableHead>
                <TableHead className="w-36">份额剩余</TableHead>
                <TableHead className="w-40">调用频率(24h 北京)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {a.boundCards.map((c) => (
                <BoundCardRow key={c.id} card={c} />
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <CreditCardIcon className="size-3" />
          无绑定卡(走动态池)
        </div>
      )}
    </div>
  );
}

function BoundCardRow({ card: c }: { card: DashboardCard }) {
  // Fair-share remaining = the most-constrained bucket for this card.
  const fractions = Object.values(c.fairShare).map((f) => f.fraction);
  const minFrac = fractions.length ? Math.min(...fractions) : null;
  const pct = minFrac === null ? null : Math.round(minFrac * 100);
  return (
    <TableRow>
      <TableCell className="max-w-[160px] truncate font-medium">{c.name || c.id}</TableCell>
      <TableCell className="text-center">
        <Badge variant="secondary">×{c.weight}</Badge>
      </TableCell>
      <TableCell className="text-right text-sm tabular-nums">{c.totalTokensUsed.toLocaleString()}</TableCell>
      <TableCell className="text-right text-sm tabular-nums">{c.totalRequests.toLocaleString()}</TableCell>
      <TableCell>
        {pct === null ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <div className="flex items-center gap-2">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full" style={{ width: `${Math.max(2, pct)}%`, backgroundColor: barColor(pct) }} />
            </div>
            <span className="w-9 text-right text-xs tabular-nums">{pct}%</span>
          </div>
        )}
      </TableCell>
      <TableCell>
        <FrequencyBars data={c.hourlyFrequency} />
      </TableCell>
    </TableRow>
  );
}

/** Compact 24-bar hour-of-day call-frequency histogram (no chart lib). */
function FrequencyBars({ data }: { data: { hour: number; requests: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.requests));
  const total = data.reduce((a, d) => a + d.requests, 0);
  if (total === 0) return <span className="text-xs text-muted-foreground">无</span>;
  return (
    <div className="flex h-7 items-end gap-px" title={`${total} 次 / 近期`}>
      {Array.from({ length: 24 }, (_, h) => {
        const reqs = data.find((d) => d.hour === h)?.requests ?? 0;
        return (
          <div
            key={h}
            className="w-[3px] rounded-sm bg-primary/70"
            style={{ height: `${reqs === 0 ? 6 : Math.max(12, (reqs / max) * 100)}%`, opacity: reqs === 0 ? 0.25 : 1 }}
          />
        );
      })}
    </div>
  );
}

/** Tiny inline SVG sparkline (0–100 water level over time). */
function Sparkline({ values }: { values: number[] }) {
  const w = 96;
  const h = 22;
  const n = values.length;
  const pts = values
    .map((v, i) => {
      const x = (i / (n - 1)) * w;
      const y = h - (Math.max(0, Math.min(100, v)) / 100) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = values[n - 1];
  return (
    <svg width={w} height={h} className="overflow-visible" aria-label="5h 水位历史">
      <polyline points={pts} fill="none" stroke={barColor(last)} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function WaterBar({ label, pct, resetAt }: { label: string; pct: number | null; resetAt: string | null }) {
  const v = pct === null ? null : Math.round(pct);
  const resetLabel = resetAt ? formatReset(resetAt) : null;
  return (
    <div className="flex items-center gap-2">
      <span className="w-6 shrink-0 text-[10px] text-muted-foreground">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        {v === null ? null : (
          <div className="h-full rounded-full" style={{ width: `${Math.max(2, v)}%`, backgroundColor: barColor(v) }} />
        )}
      </div>
      <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
        {v === null ? "—" : `${v}%`}
      </span>
      {resetLabel ? <span className="w-16 shrink-0 text-right text-[10px] text-muted-foreground">{resetLabel}</span> : null}
    </div>
  );
}

/** "重置 6/7 23:00" — local short reset time. */
function formatReset(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const mm = d.getMonth() + 1;
  const dd = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `重置 ${mm}/${dd} ${hh}:${mi}`;
}

function ModelSupplyRow({ model: m }: { model: ModelStat }) {
  const availVariant: "secondary" | "destructive" | "outline" =
    m.available === 0 ? "destructive" : m.available * 2 < m.poolSize ? "outline" : "secondary";
  const lowestPct = m.lowestRemaining === null ? null : Math.round(m.lowestRemaining * 100);
  const medianPct = m.medianRemaining === null ? null : Math.round(m.medianRemaining * 100);

  return (
    <TableRow>
      <TableCell className="max-w-[180px] truncate font-medium">{m.displayName}</TableCell>
      <TableCell className="text-center">
        <Badge variant={availVariant}>
          {m.available}/{m.poolSize}
        </Badge>
      </TableCell>
      <TableCell>
        {lowestPct === null ? (
          <span className="text-xs text-muted-foreground">暂无数据</span>
        ) : (
          <div className="flex items-center gap-2">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.max(2, lowestPct)}%`, backgroundColor: barColor(lowestPct) }}
              />
            </div>
            <span className="w-9 text-right text-xs tabular-nums">{lowestPct}%</span>
          </div>
        )}
      </TableCell>
      <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
        {medianPct === null ? "—" : `${medianPct}%`}
      </TableCell>
      <TableCell className="text-right">
        {m.lowCount > 0 ? (
          <span className="text-xs text-destructive">{m.lowCount} 个&lt;20%</span>
        ) : (
          <span className="text-xs text-muted-foreground">-</span>
        )}
      </TableCell>
    </TableRow>
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
