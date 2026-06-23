"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRightIcon, RefreshCwIcon, ShieldAlertIcon, SkullIcon } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatTokens } from "@/lib/format";

// ── API shapes(对齐 token-usage-stats.service.getBanAnalysis)─────────────────
type SubStatus = "ACTIVE" | "EXPIRED" | "CANCELLED" | "";
type CustomerRisk = { customerId: string; requests: number; reverseProxyHits: number; reverseProxyRate: number; distinctCards: number; peakReqPerMin: number; distinctSourceIps: number; subStatus: SubStatus };
type AccountHealthTone = "ok" | "amber" | "destructive" | "muted";
type AccountHealth = { label: string; tone: AccountHealthTone; reason: string };
type AccountRisk = {
  product: string;
  accountEmail: string;
  requests: number;
  failedRequests: number;
  failRate: number;
  reverseProxyHits: number;
  reverseProxyRate: number;
  distinctCards: number;
  distinctCustomers: number;
  totalTokens: number;
  peakReqPerMin: number;
  distinctSourceIps: number;
  distinctUsers: number;
  status?: AccountHealth;
  customers: CustomerRisk[];
};
type BanEvent = {
  id: string;
  createdAt: string;
  provider: string;
  accountId: number;
  accountEmail: string;
  reason: string;
  upstreamStatus: number;
  upstreamBody: string;
  modelKey: string;
  deathStrikes: number;
  requestCount: number;
  peakReqPerMin: number;
};
type BanReq = {
  id: string;
  seq: number;
  at: string;
  accessKeyId: string;
  customerId: string;
  modelKey: string;
  status: number;
  totalTokens: number;
  reverseProxy: boolean;
};
type CompMetric = { key: string; label: string; pct: boolean; bannedAvg: number; healthyAvg: number; ratio: number };
type BanComparison = { days: number; bannedCount: number; healthyCount: number; metrics: CompMetric[] };
type Window3d = {
  requests: number;
  reverseProxyHits: number;
  reverseProxyRate: number;
  distinctSourceIps: number;
  distinctDevices: number;
  distinctUsers: number;
  peakReqPerMin: number;
  totalTokens: number;
};
type BanEventCtx = { requests: BanReq[]; window3d: Window3d | null };
type BanAnalysis = { days: number; comparison: BanComparison; accounts: AccountRisk[]; banEvents: BanEvent[] };
type RequestLogRow = {
  id: string;
  at: string;
  provider: string;
  accountEmail: string;
  accessKeyId: string;
  customerId: string;
  deviceId: string;
  modelKey: string;
  status: number;
  totalTokens: number;
  reverseProxy: boolean;
  surface: string;
  sourceIp: string;
  exitIp: string;
  headers: string;
};
const SURFACE_OPTIONS = ["", "cli", "desktop", "ide"] as const;

const DAY_OPTIONS = ["3", "7", "14", "30"] as const;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const PRODUCT_LABEL: Record<string, string> = { codex: "Codex", anthropic: "Claude" };

/** 反代率配色:≥30% 红(基本实锤反代)/ ≥10% 黄(可疑)/ 否则静默。 */
function reverseProxyTone(rate: number, hits: number): "destructive" | "amber" | "muted" {
  if (hits <= 0) return "muted";
  if (rate >= 0.3) return "destructive";
  if (rate >= 0.1) return "amber";
  return "muted";
}

function RateBadge({ rate, hits }: { rate: number; hits: number }) {
  const tone = reverseProxyTone(rate, hits);
  if (tone === "muted") return <span className="text-muted-foreground tabular-nums">{pct(rate)}</span>;
  return (
    <Badge
      variant={tone === "destructive" ? "destructive" : "secondary"}
      className={tone === "amber" ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : ""}
    >
      {pct(rate)} · {hits}
    </Badge>
  );
}

function RpmBadge({ rpm }: { rpm: number }) {
  if (rpm >= 30) return <Badge variant="destructive">{rpm}</Badge>;
  if (rpm >= 10) return <Badge variant="secondary" className="bg-amber-500/15 text-amber-600 dark:text-amber-400">{rpm}</Badge>;
  if (rpm > 0) return <span className="tabular-nums">{rpm}</span>;
  return <span className="text-muted-foreground">—</span>;
}

function UsersBadge({ n }: { n: number }) {
  // 一个订阅号正常 = 1 个真实用户。多了就是共享/转卖。
  if (n >= 5) return <Badge variant="destructive">{n}</Badge>;
  if (n >= 2) return <Badge variant="secondary" className="bg-amber-500/15 text-amber-600 dark:text-amber-400">{n}</Badge>;
  if (n > 0) return <span className="tabular-nums">{n}</span>;
  return <span className="text-muted-foreground">—</span>;
}

function CustomersBadge({ n }: { n: number }) {
  // 扇出客户 = 几个真实买家在共用这个母号。>1 即共享,越多越像转卖。
  if (n >= 5) return <Badge variant="destructive">{n}</Badge>;
  if (n >= 2) return <Badge variant="secondary" className="bg-amber-500/15 text-amber-600 dark:text-amber-400">{n}</Badge>;
  if (n > 0) return <span className="tabular-nums">{n}</span>;
  return <span className="text-muted-foreground">—</span>;
}

function SubStatusBadge({ s }: { s: SubStatus }) {
  // 订阅已取消/过期却仍在这个母号下发请求 = 泄漏/盗用信号。ACTIVE/无订阅不标。
  if (s === "CANCELLED") return <Badge variant="destructive">订阅已取消</Badge>;
  if (s === "EXPIRED") return <Badge variant="secondary" className="bg-amber-500/15 text-amber-600 dark:text-amber-400">已过期</Badge>;
  return null;
}

function StatusBadge({ status }: { status?: AccountHealth }) {
  if (!status) return <span className="text-muted-foreground">—</span>;
  const title = status.reason || undefined;
  if (status.tone === "ok") return <span className="text-muted-foreground" title={title}>{status.label}</span>;
  if (status.tone === "muted") return <Badge variant="outline" title={title}>{status.label}</Badge>;
  if (status.tone === "amber")
    return <Badge variant="secondary" className="bg-amber-500/15 text-amber-600 dark:text-amber-400" title={title}>{status.label}</Badge>;
  return <Badge variant="destructive" title={title}>{status.label}</Badge>;
}

function fmtMetric(v: number, pct: boolean): string {
  if (pct) return `${(v * 100).toFixed(1)}%`;
  if (v >= 1000) return formatTokens(Math.round(v));
  return v.toFixed(1);
}

function RatioBadge({ ratio }: { ratio: number }) {
  if (ratio >= 999) return <Badge variant="destructive">仅已封</Badge>;
  const txt = `${ratio.toFixed(1)}×`;
  if (ratio >= 3) return <Badge variant="destructive">{txt}</Badge>;
  if (ratio >= 1.5) return <Badge variant="secondary" className="bg-amber-500/15 text-amber-600 dark:text-amber-400">{txt}</Badge>;
  return <span className="text-muted-foreground tabular-nums">{txt}</span>;
}

function prettyHeaders(s: string): string {
  if (!s) return "(无头)";
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function fmtTime(iso: string) {
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

export default function BanAnalysisPage() {
  const [days, setDays] = useState<string>("3");
  const [data, setData] = useState<BanAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [openEvent, setOpenEvent] = useState<string | null>(null);
  const [eventCtx, setEventCtx] = useState<Record<string, BanEventCtx>>({});
  const [openAcct, setOpenAcct] = useState<string | null>(null);
  const [acctProduct, setAcctProduct] = useState<string>(""); // 风险榜产品筛选:""=全部

  // 请求明细(per-request 热表)
  const [logs, setLogs] = useState<RequestLogRow[]>([]);
  const [logEmail, setLogEmail] = useState("");
  const [logSurface, setLogSurface] = useState<string>("");
  const [logRpOnly, setLogRpOnly] = useState(false);
  const [logLoading, setLogLoading] = useState(false);
  const [openLog, setOpenLog] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/console/rosetta/ban-analysis?days=${days}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as BanAnalysis);
    } catch (err) {
      toast.error(`加载封号分析失败:${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleEvent = useCallback(async (id: string) => {
    setOpenEvent((cur) => (cur === id ? null : id));
    if (eventCtx[id]) return;
    try {
      const res = await fetch(`/api/console/rosetta/ban-event-requests?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const json = await res.json();
      setEventCtx((m) => ({ ...m, [id]: { requests: (json?.requests ?? []) as BanReq[], window3d: (json?.window3d ?? null) as Window3d | null } }));
    } catch {
      setEventCtx((m) => ({ ...m, [id]: { requests: [], window3d: null } }));
    }
  }, [eventCtx]);

  const loadLogs = useCallback(async () => {
    setLogLoading(true);
    try {
      const qs = new URLSearchParams();
      if (logEmail.trim()) qs.set("accountEmail", logEmail.trim());
      if (logSurface) qs.set("surface", logSurface);
      if (logRpOnly) qs.set("reverseProxy", "1");
      const res = await fetch(`/api/console/rosetta/request-logs?${qs.toString()}`, { cache: "no-store" });
      const json = await res.json();
      setLogs((json?.logs ?? []) as RequestLogRow[]);
    } catch (err) {
      toast.error(`加载请求明细失败:${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLogLoading(false);
    }
  }, [logEmail, logSurface, logRpOnly]);

  const banCount = data?.banEvents.length ?? 0;
  const highRiskCount = useMemo(
    () => (data?.accounts ?? []).filter((a) => a.reverseProxyHits > 0 && a.reverseProxyRate >= 0.3).length,
    [data],
  );
  const riskAccounts = useMemo(
    () => (data?.accounts ?? []).filter((a) => !acctProduct || a.product === acctProduct),
    [data, acctProduct],
  );

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <ShieldAlertIcon className="size-5 text-destructive" /> 封号分析
            <span className="text-sm font-normal text-muted-foreground">Codex · Claude 母号</span>
          </h1>
          <p className="text-sm text-muted-foreground">封号事件 + 母号反代/扇出风险,定位"为什么被封"。</p>
        </div>
        <div className="flex items-center gap-2">
          <ToggleGroup
            multiple={false}
            value={[days]}
            onValueChange={(value) => { const next = value[0]; if (next) setDays(next); }}
            variant="outline"
            size="sm"
          >
            {DAY_OPTIONS.map((d) => (
              <ToggleGroupItem key={d} value={d}>{d}天</ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Spinner className="size-4" /> : <RefreshCwIcon className="size-4" />}
          </Button>
        </div>
      </div>

      {/* Summary chips */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2"><CardDescription>近 {data?.days ?? days} 天封号</CardDescription>
            <CardTitle className="text-2xl text-destructive tabular-nums">{banCount}</CardTitle></CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>高反代母号(≥30%)</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{highRiskCount}</CardTitle></CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>在册母号</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{data?.accounts.length ?? 0}</CardTitle></CardHeader>
        </Card>
      </div>

      {/* 定因对比:已封 vs 健康 */}
      <Card>
        <CardHeader>
          <CardTitle>定因对比 <span className="text-sm font-normal text-muted-foreground">已封 {data?.comparison.bannedCount ?? 0} · 健康 {data?.comparison.healthyCount ?? 0}</span></CardTitle>
          <CardDescription>两组母号在各信号上的均值对比,按差异倍数降序 —— 置顶行就是封号主因候选。</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>指标</TableHead>
                <TableHead className="text-right">已封母号(均值)</TableHead>
                <TableHead className="text-right">健康母号(均值)</TableHead>
                <TableHead className="text-right">差异</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.comparison.metrics ?? []).length === 0 && (
                <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">数据不足(需要既有已封、也有健康母号)</TableCell></TableRow>
              )}
              {(data?.comparison.metrics ?? []).map((m) => (
                <TableRow key={m.key} className={m.ratio >= 3 ? "bg-destructive/5" : ""}>
                  <TableCell>{m.label}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{fmtMetric(m.bannedAvg, m.pct)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{fmtMetric(m.healthyAvg, m.pct)}</TableCell>
                  <TableCell className="text-right"><RatioBadge ratio={m.ratio} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Ban events */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><SkullIcon className="size-4 text-destructive" /> 封号事件</CardTitle>
          <CardDescription>每个被永久封禁的母号一行;点开看封号前的请求时间线。</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>时间</TableHead>
                <TableHead>产品</TableHead>
                <TableHead>母号</TableHead>
                <TableHead>原因</TableHead>
                <TableHead className="text-right">上游</TableHead>
                <TableHead>模型</TableHead>
                <TableHead className="text-right">封号前峰值/分</TableHead>
                <TableHead className="text-right">连击</TableHead>
                <TableHead className="text-right">前置请求</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.banEvents ?? []).length === 0 && (
                <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground">近 {days} 天无封号</TableCell></TableRow>
              )}
              {(data?.banEvents ?? []).map((e) => (
                <Fragment key={e.id}>
                  <TableRow className="cursor-pointer" onClick={() => void toggleEvent(e.id)}>
                    <TableCell><ChevronRightIcon className={`size-4 transition-transform ${openEvent === e.id ? "rotate-90" : ""}`} /></TableCell>
                    <TableCell className="whitespace-nowrap text-sm">{fmtTime(e.createdAt)}</TableCell>
                    <TableCell>{PRODUCT_LABEL[e.provider] ?? e.provider}</TableCell>
                    <TableCell className="font-mono text-xs">{e.accountEmail || `#${e.accountId}`}</TableCell>
                    <TableCell><Badge variant="destructive">{e.reason || "—"}</Badge></TableCell>
                    <TableCell className="text-right tabular-nums">{e.upstreamStatus || "—"}</TableCell>
                    <TableCell className="text-xs">{e.modelKey || "—"}</TableCell>
                    <TableCell className="text-right"><RpmBadge rpm={e.peakReqPerMin} /></TableCell>
                    <TableCell className="text-right tabular-nums">{e.deathStrikes}</TableCell>
                    <TableCell className="text-right tabular-nums">{e.requestCount}</TableCell>
                  </TableRow>
                  {openEvent === e.id && (
                    <TableRow>
                      <TableCell colSpan={10} className="bg-muted/30">
                        {e.upstreamBody && (
                          <p className="mb-2 break-all rounded bg-background p-2 font-mono text-xs text-muted-foreground">{e.upstreamBody}</p>
                        )}
                        <Window3dStrip w={eventCtx[e.id]?.window3d} />
                        <BanReqTimeline reqs={eventCtx[e.id]?.requests} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Account risk */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>母号风险榜</CardTitle>
              <CardDescription>按反代命中降序。反代率高 = 这个母号很可能被反代/转卖;扇出客户多 = 被多个买家共用。点开看是哪张卡。</CardDescription>
            </div>
            <ToggleGroup
              multiple={false}
              value={[acctProduct]}
              onValueChange={(value) => setAcctProduct(value[0] ?? "")}
              variant="outline"
              size="sm"
            >
              <ToggleGroupItem value="">全部</ToggleGroupItem>
              <ToggleGroupItem value="anthropic">Claude</ToggleGroupItem>
              <ToggleGroupItem value="codex">Codex</ToggleGroupItem>
            </ToggleGroup>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>产品</TableHead>
                <TableHead>母号</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">请求</TableHead>
                <TableHead className="text-right">失败率</TableHead>
                <TableHead className="text-right">反代率·命中</TableHead>
                <TableHead className="text-right">用户</TableHead>
                <TableHead className="text-right">峰值/分</TableHead>
                <TableHead className="text-right">来源IP</TableHead>
                <TableHead className="text-right">扇出卡</TableHead>
                <TableHead className="text-right">扇出客户</TableHead>
                <TableHead className="text-right">Token</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {riskAccounts.length === 0 && (
                <TableRow><TableCell colSpan={13} className="text-center text-muted-foreground">无数据</TableCell></TableRow>
              )}
              {riskAccounts.map((a) => {
                const key = `${a.product} ${a.accountEmail}`;
                return (
                  <Fragment key={key}>
                    <TableRow className="cursor-pointer" onClick={() => setOpenAcct((c) => (c === key ? null : key))}>
                      <TableCell><ChevronRightIcon className={`size-4 transition-transform ${openAcct === key ? "rotate-90" : ""}`} /></TableCell>
                      <TableCell>{PRODUCT_LABEL[a.product] ?? a.product}</TableCell>
                      <TableCell className="font-mono text-xs">{a.accountEmail}</TableCell>
                      <TableCell><StatusBadge status={a.status} /></TableCell>
                      <TableCell className="text-right tabular-nums">{a.requests}</TableCell>
                      <TableCell className="text-right tabular-nums">{pct(a.failRate)}</TableCell>
                      <TableCell className="text-right"><RateBadge rate={a.reverseProxyRate} hits={a.reverseProxyHits} /></TableCell>
                      <TableCell className="text-right"><UsersBadge n={a.distinctUsers} /></TableCell>
                      <TableCell className="text-right"><RpmBadge rpm={a.peakReqPerMin} /></TableCell>
                      <TableCell className="text-right tabular-nums">{a.distinctSourceIps || "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{a.distinctCards}</TableCell>
                      <TableCell className="text-right"><CustomersBadge n={a.distinctCustomers} /></TableCell>
                      <TableCell className="text-right tabular-nums">{formatTokens(a.totalTokens)}</TableCell>
                    </TableRow>
                    {openAcct === key && (
                      <TableRow key={`${key}-cards`}>
                        <TableCell colSpan={13} className="bg-muted/30">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>客户</TableHead>
                                <TableHead className="text-right">请求</TableHead>
                                <TableHead className="text-right">反代率·命中</TableHead>
                                <TableHead className="text-right">持卡数</TableHead>
                                <TableHead className="text-right">峰值/分</TableHead>
                                <TableHead className="text-right">来源IP</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {a.customers.map((c) => (
                                <TableRow key={c.customerId}>
                                  <TableCell className="font-mono text-xs">
                                    <span className="inline-flex items-center gap-1.5">{c.customerId}<SubStatusBadge s={c.subStatus} /></span>
                                  </TableCell>
                                  <TableCell className="text-right tabular-nums">{c.requests}</TableCell>
                                  <TableCell className="text-right"><RateBadge rate={c.reverseProxyRate} hits={c.reverseProxyHits} /></TableCell>
                                  <TableCell className="text-right tabular-nums">{c.distinctCards}</TableCell>
                                  <TableCell className="text-right"><RpmBadge rpm={c.peakReqPerMin} /></TableCell>
                                  <TableCell className="text-right tabular-nums">{c.distinctSourceIps || "—"}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Request logs (per-request 热表,近 5 天) */}
      <Card>
        <CardHeader>
          <CardTitle>请求明细 <span className="text-sm font-normal text-muted-foreground">近 5 天 · per-request</span></CardTitle>
          <CardDescription>逐条请求:来源 IP / 出口 IP / 接管面 / 反代 / 请求头。按母号、接管面、是否反代筛选。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="母号 email 过滤"
              value={logEmail}
              onChange={(e) => setLogEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void loadLogs()}
              className="h-9 w-56"
            />
            <ToggleGroup
              multiple={false}
              value={[logSurface]}
              onValueChange={(value) => setLogSurface(value[0] ?? "")}
              variant="outline"
              size="sm"
            >
              {SURFACE_OPTIONS.map((s) => (
                <ToggleGroupItem key={s || "all"} value={s}>{s === "" ? "全部" : s}</ToggleGroupItem>
              ))}
            </ToggleGroup>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={logRpOnly} onCheckedChange={setLogRpOnly} /> 仅反代
            </label>
            <Button variant="outline" size="sm" onClick={() => void loadLogs()} disabled={logLoading}>
              {logLoading ? <Spinner className="size-4" /> : "查询"}
            </Button>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>时间</TableHead>
                <TableHead>产品</TableHead>
                <TableHead>母号</TableHead>
                <TableHead>客户</TableHead>
                <TableHead>接管面</TableHead>
                <TableHead>来源 IP</TableHead>
                <TableHead>出口 IP</TableHead>
                <TableHead>模型</TableHead>
                <TableHead className="text-right">状态</TableHead>
                <TableHead>反代</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.length === 0 && (
                <TableRow><TableCell colSpan={11} className="text-center text-muted-foreground">点「查询」加载请求明细</TableCell></TableRow>
              )}
              {logs.map((r) => (
                <Fragment key={r.id}>
                  <TableRow className={`cursor-pointer ${r.reverseProxy ? "bg-destructive/5" : ""}`} onClick={() => setOpenLog((c) => (c === r.id ? null : r.id))}>
                    <TableCell><ChevronRightIcon className={`size-4 transition-transform ${openLog === r.id ? "rotate-90" : ""}`} /></TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{fmtTime(r.at)}</TableCell>
                    <TableCell>{PRODUCT_LABEL[r.provider] ?? r.provider}</TableCell>
                    <TableCell className="font-mono text-xs">{r.accountEmail || "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{r.customerId || "—"}</TableCell>
                    <TableCell>{r.surface ? <Badge variant="secondary">{r.surface}</Badge> : "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{r.sourceIp || "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{r.exitIp || "—"}</TableCell>
                    <TableCell className="text-xs">{r.modelKey || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.status || "—"}</TableCell>
                    <TableCell>{r.reverseProxy ? <Badge variant="destructive">反代</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
                  </TableRow>
                  {openLog === r.id && (
                    <TableRow>
                      <TableCell colSpan={11} className="bg-muted/30">
                        <div className="text-xs text-muted-foreground">设备:<span className="font-mono">{r.deviceId || "—"}</span> · tokens:{r.totalTokens}</div>
                        <pre className="mt-2 max-h-48 overflow-auto rounded bg-background p-2 font-mono text-xs">{prettyHeaders(r.headers)}</pre>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function Window3dStrip({ w }: { w?: Window3d | null }) {
  if (w === undefined) return null; // still loading
  if (w === null) return null;
  const cell = (label: string, value: React.ReactNode) => (
    <div className="rounded bg-background px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-medium tabular-nums">{value}</div>
    </div>
  );
  return (
    <div className="mb-3">
      <div className="mb-1 text-xs font-medium text-muted-foreground">封号前 3 天</div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-7">
        {cell("请求", w.requests)}
        {cell("反代率", `${(w.reverseProxyRate * 100).toFixed(0)}%·${w.reverseProxyHits}`)}
        {cell("用户", <UsersBadge n={w.distinctUsers} />)}
        {cell("峰值/分", <RpmBadge rpm={w.peakReqPerMin} />)}
        {cell("来源IP", w.distinctSourceIps)}
        {cell("设备", w.distinctDevices)}
        {cell("Token", formatTokens(w.totalTokens))}
      </div>
    </div>
  );
}

function BanReqTimeline({ reqs }: { reqs?: BanReq[] }) {
  if (!reqs) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-4" /> 加载请求时间线…</div>;
  if (reqs.length === 0) return <p className="text-sm text-muted-foreground">无封号前请求记录(内存环重启后丢失,或该号封号时无在途请求)。</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="text-right">#</TableHead>
          <TableHead>时间</TableHead>
          <TableHead>卡</TableHead>
          <TableHead>模型</TableHead>
          <TableHead className="text-right">状态</TableHead>
          <TableHead className="text-right">Token</TableHead>
          <TableHead>反代</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {reqs.map((r) => (
          <TableRow key={r.id} className={r.reverseProxy ? "bg-destructive/5" : ""}>
            <TableCell className="text-right tabular-nums text-muted-foreground">{r.seq}</TableCell>
            <TableCell className="whitespace-nowrap text-xs">{fmtTime(r.at)}</TableCell>
            <TableCell className="font-mono text-xs">{r.accessKeyId || "—"}</TableCell>
            <TableCell className="text-xs">{r.modelKey || "—"}</TableCell>
            <TableCell className="text-right tabular-nums">{r.status || "—"}</TableCell>
            <TableCell className="text-right tabular-nums">{r.totalTokens}</TableCell>
            <TableCell>{r.reverseProxy ? <Badge variant="destructive">反代</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
