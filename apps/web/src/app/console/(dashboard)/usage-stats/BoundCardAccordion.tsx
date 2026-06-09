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
type FamilyQuota = {
  family: string; // gemini | claude | gpt
  hourlyPercent: number | null;
  weeklyPercent: number | null;
  hourlyResetAt: string | null;
  weeklyResetAt: string | null;
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
  // 按模型族(gemini/claude/gpt)拆开的真实剩余 —— 用来回答"到底哪个模型耗尽"。
  families?: FamilyQuota[];
  activeLeases?: number;
  // 水位快照是 on-change 写入的,最后一条时间戳≈账号最近一次被用(配额变动)。
  waterHistory?: { timestamp: string }[];
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
/** 账号"还有额度"的代表值:有 per-family 时取最好的那个族(只要一个模型能用就算有额度,
 *  封禁是按模型族生效的);否则回落到账号级 5h。null = 额度未知。 */
function bestFamilyPct(a: Account): number | null {
  if (a.families && a.families.length) {
    const vals = a.families
      .map((f) => {
        const w = [f.hourlyPercent, f.weeklyPercent].filter((v): v is number => typeof v === "number");
        return w.length ? Math.min(...w) : null;
      })
      .filter((v): v is number => v !== null);
    return vals.length ? Math.max(...vals) : null;
  }
  return a.hourlyPercent;
}
/** 现在能用吗:状态 ok 且至少一个模型族还有额度(未知额度视为可用)。 */
function isUsable(a: Account): boolean {
  if ((a.quotaStatus || "ok") !== "ok") return false;
  const best = bestFamilyPct(a);
  return best === null || best > 0;
}
/** 账号最近一次活动时间(ms):取水位快照最后一条;无则按绑定卡最近有用量的那天兜底,再无则 0。 */
function lastActivityAt(a: Account): number {
  let t = 0;
  for (const h of a.waterHistory || []) {
    const ms = Date.parse(h.timestamp);
    if (Number.isFinite(ms) && ms > t) t = ms;
  }
  if (t === 0) {
    for (const c of a.boundCards) {
      for (const p of c.usageTrend || []) {
        if (p.totalTokens > 0) { const ms = Date.parse(p.date); if (Number.isFinite(ms) && ms > t) t = ms; }
      }
    }
  }
  return t;
}
function barColor(pct: number) {
  return pct >= 50 ? "#22c55e" : pct >= 20 ? "#f59e0b" : "#ef4444";
}
const FAMILY_LABEL: Record<string, string> = { gemini: "Gemini", claude: "Claude", gpt: "GPT" };
function familyLabel(f: string): string {
  return FAMILY_LABEL[f] || f;
}
/** A family counts as exhausted when any of its windows reads exactly 0% remaining. */
function exhaustedFamilies(a: Account): string[] {
  return (a.families || [])
    .filter((f) => f.hourlyPercent === 0 || f.weeklyPercent === 0)
    .map((f) => familyLabel(f.family));
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
    // 账号级 quotaStatus 只要任一模型族 429 就翻成 exhausted。有 per-family 数据时点名
    // 到底哪个族耗尽(部分耗尽);全部耗尽或无 per-family 数据则沿用账号级"额度耗尽"。
    const ex = exhaustedFamilies(a);
    const famCount = a.families?.length ?? 0;
    label = ex.length > 0 && ex.length < famCount ? `${ex.join("/")} 耗尽` : "额度耗尽";
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

/** Per-family upstream remaining: one pill per model family (Gemini / Claude / GPT),
 *  so a half-exhausted account shows *which* side is dry instead of one blended %. */
function FamilyPills({ families }: { families: FamilyQuota[] }) {
  return (
    <span className="flex items-center gap-1.5">
      {families.map((f) => {
        const windows = [f.hourlyPercent, f.weeklyPercent].filter((v): v is number => typeof v === "number");
        const worst = windows.length ? Math.min(...windows) : null;
        return (
          <span
            key={f.family}
            className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px]"
            title={formatReset(f.hourlyResetAt || f.weeklyResetAt)}
          >
            <span className="size-1.5 rounded-full" style={{ background: worst === null ? "#94a3b8" : barColor(worst) }} />
            {familyLabel(f.family)}
            {f.hourlyPercent !== null && ` 5h ${Math.round(f.hourlyPercent)}%`}
            {f.weeklyPercent !== null && ` · 周 ${Math.round(f.weeklyPercent)}%`}
          </span>
        );
      })}
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
  // "useful"(默认):可用号优先 + 最近使用在前(把能用、活跃的号顶上来)。
  // "triage":老口径,告警/份额最紧优先(排障时找最危险的号)。
  const [sortMode, setSortMode] = useState<"useful" | "triage">("useful");
  const shown = useMemo(() => {
    const filtered = accounts.filter(
      (a) =>
        !warnOnly ||
        (a.quotaStatus || "ok") !== "ok" || // 需验证/冷却/异常的号也算告警
        a.boundCards.some((c) => { const f = minFraction(c.fairShare); return f !== null && f < 0.2; }),
    );
    if (sortMode === "triage") {
      // 告警优先:非正常状态在前,再按份额最紧。
      return [...filtered].sort((x, y) => {
        const s = statusRank(x) - statusRank(y);
        if (s !== 0) return s;
        return accountWorstFraction(x) - accountWorstFraction(y);
      });
    }
    // 可用优先:① 现在能用的(状态ok且5h>0)整体置顶;② 5h 剩余% 高的在前;
    // ③ 同档按最近使用时间倒序(最近被用的在前)。
    return [...filtered].sort((x, y) => {
      const u = Number(isUsable(y)) - Number(isUsable(x));
      if (u !== 0) return u;
      const px = bestFamilyPct(x) ?? 100, py = bestFamilyPct(y) ?? 100;
      if (px !== py) return py - px;
      return lastActivityAt(y) - lastActivityAt(x);
    });
  }, [accounts, warnOnly, sortMode]);

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
            title="可用优先:能用的号(状态ok且5h有额度)+最近使用的排在前;点击切到告警优先(排障:最危险的号在前)"
            onClick={() => { setSortMode((v) => (v === "useful" ? "triage" : "useful")); setPage(1); }}
          >
            <ArrowDownUpIcon className="size-3.5" /> {sortMode === "useful" ? "可用优先" : "告警优先"}
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
                  {a.families && a.families.length > 0 ? <FamilyPills families={a.families} /> : <QuotaPills a={a} />}
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
