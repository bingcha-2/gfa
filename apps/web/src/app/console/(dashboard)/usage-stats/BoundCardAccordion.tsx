"use client";
import { useEffect, useMemo, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis } from "recharts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ArrowDownUpIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { formatTokens } from "@/lib/format";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type FairShare = Record<string, { fraction: number; resetAt: number }>;
type TrendPoint = { date: string; totalTokens: number; requests: number };
type FreqPoint = { hour: number; requests: number; totalTokens: number };
type Card_ = {
  id: string;
  name: string;
  weight: number;
  windowWeightedUsed: number;
  totalTokensUsed: number;
  totalRequests: number;
  fairShare: FairShare;
  usageTrend: TrendPoint[];
  usageTotals: { totalTokens: number; requests: number };
  hourlyFrequency: FreqPoint[];
};
type Account = {
  id: number;
  email: string;
  planType: string;
  quotaStatus: string;
  quotaStatusReason?: string;
  hourlyPercent: number | null;
  weeklyPercent: number | null;
  hourlyResetAt: string | null;
  weeklyResetAt: string | null;
  boundCards: Card_[];
};

function minFraction(fs: FairShare): number | null {
  const v = Object.values(fs).map((f) => f.fraction);
  return v.length ? Math.min(...v) : null;
}
/** 账号最紧份额(0..1);无任何 fair-share 窗口视为 1(100% 剩余,与表头 worst 口径一致)。 */
function accountWorstFraction(a: Account): number {
  let min = 1;
  for (const c of a.boundCards) {
    const f = minFraction(c.fairShare);
    if (f !== null && f < min) min = f;
  }
  return min;
}
/** 非正常状态(需验证/冷却/异常)排在最前 → 0 比正常号的 1 小。 */
function statusRank(a: Account): number {
  return (a.quotaStatus || "ok") === "ok" ? 1 : 0;
}
function barColor(pct: number) {
  return pct >= 50 ? "#22c55e" : pct >= 20 ? "#f59e0b" : "#ef4444";
}
function formatDay(date: string): string {
  const [, m, d] = date.split("-");
  return m && d ? `${Number(m)}/${Number(d)}` : date;
}
function formatReset(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `重置 ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 账号当前可用性徽标:剩余%只是上次快照,被封禁的号要明确标出"现在用不了"。 */
function StatusBadge({ a }: { a: Account }) {
  const st = a.quotaStatus || "ok";
  if (st === "ok") return null;
  const reason = a.quotaStatusReason || "";
  let label = st;
  let variant: "destructive" | "secondary" = "secondary";
  if (reason.includes("verification")) {
    label = "需验证";
    variant = "destructive";
  } else if (st === "error") {
    variant = "destructive";
    if (reason.includes("invalid_grant")) label = "鉴权失效";
    else if (
      reason.includes("service_disabled") || reason.includes("forbidden") ||
      reason.includes("suspended") || reason.includes("restricted") ||
      reason.includes("permission_denied") || reason.includes("access_denied")
    ) label = "账号异常";
    else if (reason.includes("location")) label = "地区不支持";
    else label = "不可用";
  } else if (st === "cooling") {
    label = "冷却中";
  } else if (st === "exhausted") {
    label = "额度耗尽";
  }
  return (
    <Badge variant={variant} className="text-[10px]" title={reason || st}>
      {label}
    </Badge>
  );
}

/** Real upstream remaining for the account: "5h XX% · 周 YY%". */
function QuotaPills({ a }: { a: Account }) {
  const pill = (label: string, pct: number | null, reset: string | null) =>
    pct === null ? null : (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px]" title={formatReset(reset)}>
        <span className="size-1.5 rounded-full" style={{ background: barColor(pct) }} />
        {label} {Math.round(pct)}%
      </span>
    );
  return (
    <span className="flex items-center gap-1.5">
      {pill("5h", a.hourlyPercent, a.hourlyResetAt)}
      {pill("周", a.weeklyPercent, a.weeklyResetAt)}
    </span>
  );
}

const trendConfig: ChartConfig = { totalTokens: { label: "Token", color: "var(--chart-1)" } };
const freqConfig: ChartConfig = { requests: { label: "调用次数", color: "var(--chart-2)" } };

/** Daily token-usage trend for the account = sum of its cards' per-day usage. */
function AccountTrend({ cards }: { cards: Card_[] }) {
  const byDate = new Map<string, number>();
  for (const c of cards) for (const p of c.usageTrend || []) byDate.set(p.date, (byDate.get(p.date) || 0) + p.totalTokens);
  const data = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, totalTokens]) => ({ date, totalTokens }));
  const total = data.reduce((s, d) => s + d.totalTokens, 0);
  if (total === 0) return <div className="flex h-[110px] items-center justify-center text-[11px] text-muted-foreground">近期无用量</div>;
  return (
    <ChartContainer config={trendConfig} className="h-[110px] w-full">
      <AreaChart data={data} margin={{ left: 4, right: 4, top: 4 }}>
        <defs>
          <linearGradient id="fillCardTrend" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-totalTokens)" stopOpacity={0.7} />
            <stop offset="95%" stopColor="var(--color-totalTokens)" stopOpacity={0.08} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={6} minTickGap={24} tickFormatter={formatDay} />
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent labelFormatter={(v) => formatDay(String(v))} formatter={(v) => formatTokens(Number(v))} />}
        />
        <Area dataKey="totalTokens" type="natural" stroke="var(--color-totalTokens)" fill="url(#fillCardTrend)" />
      </AreaChart>
    </ChartContainer>
  );
}

/** Hour-of-day (Beijing) call frequency for the account = sum of its cards' hourly requests. */
function AccountFrequency({ cards }: { cards: Card_[] }) {
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, requests: 0 }));
  for (const c of cards) for (const p of c.hourlyFrequency || []) if (p.hour >= 0 && p.hour < 24) byHour[p.hour].requests += p.requests;
  const total = byHour.reduce((s, d) => s + d.requests, 0);
  if (total === 0) return <div className="flex h-[110px] items-center justify-center text-[11px] text-muted-foreground">近期无调用</div>;
  return (
    <ChartContainer config={freqConfig} className="h-[110px] w-full">
      <BarChart data={byHour} margin={{ left: 4, right: 4, top: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="hour" tickLine={false} axisLine={false} tickMargin={6} ticks={[0, 6, 12, 18]} tickFormatter={(h) => `${h}时`} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(v) => `${v}:00`} formatter={(v) => `${v} 次`} />} />
        <Bar dataKey="requests" fill="var(--color-requests)" radius={2} />
      </BarChart>
    </ChartContainer>
  );
}

const PAGE_SIZE = 20;

export function BoundCardAccordion({ accounts }: { accounts: Account[] }) {
  const [warnOnly, setWarnOnly] = useState(false);
  const [page, setPage] = useState(1);
  // true = 最紧/最危险优先(默认),false = 最松优先。
  const [tightFirst, setTightFirst] = useState(true);
  const shown = useMemo(() => {
    const filtered = accounts.filter(
      (a) =>
        !warnOnly ||
        (a.quotaStatus || "ok") !== "ok" || // 需验证/冷却/异常的号也算告警
        a.boundCards.some((c) => { const f = minFraction(c.fairShare); return f !== null && f < 0.2; }),
    );
    const dir = tightFirst ? 1 : -1;
    return [...filtered].sort((x, y) => {
      const s = statusRank(x) - statusRank(y); // 非正常状态优先
      if (s !== 0) return dir * s;
      return dir * (accountWorstFraction(x) - accountWorstFraction(y)); // 再按份额最紧
    });
  }, [accounts, warnOnly, tightFirst]);

  const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  // Clamp when the filtered set shrinks (e.g. toggling 只看告警 or data refresh).
  useEffect(() => { setPage((p) => Math.min(p, pageCount)); }, [pageCount]);
  const start = (page - 1) * PAGE_SIZE;
  const pageItems = shown.slice(start, start + PAGE_SIZE);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm">账号水位与绑定卡明细</CardTitle>
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground"
            title="按账号状态 + 份额最紧排序;点击切换最紧/最松优先"
            onClick={() => { setTightFirst((v) => !v); setPage(1); }}
          >
            <ArrowDownUpIcon className="size-3.5" /> {tightFirst ? "最紧优先" : "最松优先"}
          </Button>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            只看告警账号 <Switch checked={warnOnly} onCheckedChange={(v) => { setWarnOnly(v); setPage(1); }} />
          </label>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {shown.length === 0 && <div className="py-4 text-center text-xs text-muted-foreground">无符合条件的账号</div>}
        {pageItems.map((a) => {
          const worst = Math.min(100, ...a.boundCards.map((c) => { const f = minFraction(c.fairShare); return f === null ? 100 : Math.round(f * 100); }));
          return (
            <Collapsible key={a.id} className="rounded-lg border">
              <CollapsibleTrigger className="flex w-full items-center gap-2 p-3 text-sm [&[data-panel-open]>svg]:rotate-90">
                <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground transition" />
                <span className="truncate font-medium">{a.email || `账号 #${a.id}`}</span>
                {a.planType && <Badge variant="secondary">{a.planType}</Badge>}
                <StatusBadge a={a} />
                <span className="ml-auto flex items-center gap-2">
                  <QuotaPills a={a} />
                  <span className="text-xs text-muted-foreground">{a.boundCards.length} 卡 · 份额最紧 {worst}%</span>
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="space-y-3 border-t px-3 py-3">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <div className="mb-1 text-[11px] font-medium text-muted-foreground">用量趋势(按日)</div>
                      <AccountTrend cards={a.boundCards} />
                    </div>
                    <div>
                      <div className="mb-1 text-[11px] font-medium text-muted-foreground">调用频率(24h · 北京时)</div>
                      <AccountFrequency cards={a.boundCards} />
                    </div>
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>卡</TableHead>
                        <TableHead className="text-center">权重</TableHead>
                        <TableHead className="text-right">
                          本窗口已用{" "}
                          <Badge
                            variant="outline"
                            className="ml-1 text-[9px]"
                            title="fair-share 配额口径:净输入×1 + 输出×权重 + 缓存×权重 的『加权单元』(5h 窗口,给右侧份额剩余做注脚)。输出更贵被乘权重,故此值可能大于右侧原始 Token。"
                          >
                            加权·5h
                          </Badge>
                        </TableHead>
                        <TableHead className="text-right" title="近 7 天真实计费 token(原始口径,未加权)。">
                          近期 Token
                        </TableHead>
                        <TableHead className="w-32">
                          份额剩余{" "}
                          <Badge variant="outline" className="ml-1 text-[9px]" title="已用为实测;但账号总预算(分母)由上游 429 限流学习得来,非精确值,故标估算">
                            估算
                          </Badge>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {a.boundCards.map((c) => {
                        // No fair-share window yet = card hasn't used its slice → 100% remaining
                        // (consistent with the header's "份额最紧" summary, which treats null as 100).
                        const f = minFraction(c.fairShare);
                        const pct = f === null ? 100 : Math.round(f * 100);
                        return (
                          <TableRow key={c.id}>
                            <TableCell className="max-w-[140px] truncate font-medium">{c.name || c.id}</TableCell>
                            <TableCell className="text-center"><Badge variant="secondary">×{c.weight}</Badge></TableCell>
                            <TableCell className="text-right tabular-nums">{formatTokens(Math.round(c.windowWeightedUsed))}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatTokens(c.usageTotals?.totalTokens ?? 0)}</TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                                  <div className="h-full rounded-full" style={{ width: `${Math.max(2, pct)}%`, background: barColor(pct) }} />
                                </div>
                                <span className="w-8 text-right text-xs tabular-nums">{pct}%</span>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
        {pageCount > 1 && (
          <div className="flex items-center justify-between pt-1 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {start + 1}–{Math.min(start + PAGE_SIZE, shown.length)} / 共 {shown.length}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="h-7 px-2" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                <ChevronLeftIcon className="size-3.5" /> 上一页
              </Button>
              <span className="tabular-nums">{page} / {pageCount}</span>
              <Button variant="outline" size="sm" className="h-7 px-2" disabled={page >= pageCount} onClick={() => setPage((p) => Math.min(pageCount, p + 1))}>
                下一页 <ChevronRightIcon className="size-3.5" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
