"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  Area,
  AreaChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";

// ── Types ──

type QuotaAccount = {
  id: number | string;
  email?: string;
  enabled?: boolean;
  credits?: {
    known?: boolean;
    available?: boolean;
    creditAmount?: number;
  };
  modelQuotaFractions?: Record<string, number>;
};

type CreditStatsResponse = {
  current: {
    totalCredits: number;
    accountsWithCredits: number;
    totalAccounts: number;
  };
  today: {
    consumed: number;
    events: number;
  };
  dailyConsumption: { date: string; consumed: number }[];
};

type CreditSnapshotsResponse = {
  snapshots: {
    timestamp: string;
    totalCredits: number;
    accountCount: number;
    totalAccounts: number;
  }[];
};

// ── Model definitions (must match rosetta-load page) ──

interface CanonicalModel {
  id: string;
  displayName: string;
  aliases: string[];
}

const CANONICAL_MODELS: CanonicalModel[] = [
  {
    id: "gemini-3.1-pro-high",
    displayName: "Gemini 3.1 Pro (High)",
    aliases: ["gemini-3-pro-high", "MODEL_PLACEHOLDER_M37", "MODEL_PLACEHOLDER_M8"],
  },
  {
    id: "gemini-3.1-pro-low",
    displayName: "Gemini 3.1 Pro (Low)",
    aliases: ["gemini-3-pro-low", "MODEL_PLACEHOLDER_M36", "MODEL_PLACEHOLDER_M7"],
  },
  {
    id: "gemini-3-flash",
    displayName: "Gemini 3 Flash",
    aliases: ["MODEL_PLACEHOLDER_M18"],
  },
  {
    id: "gemini-3.5-flash-low",
    displayName: "Gemini 3.5 Flash (Low)",
    aliases: [],
  },
  {
    id: "gemini-3.5-flash-extra-low",
    displayName: "Gemini 3.5 Flash (Extra Low)",
    aliases: [],
  },
  {
    id: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    aliases: ["claude-sonnet-4-6-thinking", "claude-sonnet-4-5", "claude-sonnet-4-5-thinking", "MODEL_PLACEHOLDER_M35"],
  },
  {
    id: "claude-opus-4-6-thinking",
    displayName: "Claude Opus 4.6",
    aliases: ["claude-opus-4-6", "claude-opus-4-5-thinking", "MODEL_PLACEHOLDER_M26", "MODEL_PLACEHOLDER_M12"],
  },
];

const _normalizeKey = (v: string) => (v || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

const CANONICAL_ALIAS_MAP = (() => {
  const map = new Map<string, CanonicalModel>();
  for (const item of CANONICAL_MODELS) {
    for (const v of [item.id, item.displayName, ...item.aliases]) {
      const key = _normalizeKey(v);
      if (key && !map.has(key)) map.set(key, item);
    }
  }
  return map;
})();

function resolveCanonicalModel(name: string): CanonicalModel | undefined {
  const key = _normalizeKey(name);
  return key ? CANONICAL_ALIAS_MAP.get(key) : undefined;
}

// ── Helpers ──

function quotaBarColor(pct: number): string {
  if (pct > 60) return "bg-emerald-500";
  if (pct > 25) return "bg-amber-500";
  return "bg-red-500";
}

// ── Quota Overview Card ──

function QuotaOverviewCard({ accounts }: { accounts: QuotaAccount[] }) {
  const stats = useMemo(() => {
    const enabledAccounts = accounts.filter((a) => a.enabled !== false);
    const total = enabledAccounts.length;

    // Overall: has ANY model fraction > 0
    let withQuota = 0;
    let exhausted = 0;
    let unknown = 0;

    for (const a of enabledAccounts) {
      const fracs = a.modelQuotaFractions;
      if (!fracs || Object.keys(fracs).length === 0) {
        unknown++;
        continue;
      }
      const hasAny = Object.values(fracs).some((f) => f > 0);
      if (hasAny) withQuota++;
      else exhausted++;
    }

    // Per-model breakdown
    const modelMap = new Map<string, { id: string; displayName: string; withQuota: number; total: number }>();

    for (const a of enabledAccounts) {
      const fracs = a.modelQuotaFractions;
      if (!fracs) continue;
      for (const [modelKey, fraction] of Object.entries(fracs)) {
        const canonical = resolveCanonicalModel(modelKey);
        if (!canonical) continue;
        let entry = modelMap.get(canonical.id);
        if (!entry) {
          entry = { id: canonical.id, displayName: canonical.displayName, withQuota: 0, total: 0 };
          modelMap.set(canonical.id, entry);
        }
        entry.total++;
        if (fraction > 0) entry.withQuota++;
      }
    }

    const models = Array.from(modelMap.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));

    return { total, withQuota, exhausted, unknown, models };
  }, [accounts]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">5h 模型额度</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* Summary */}
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="secondary" className="tabular-nums">
            <span className="font-bold text-emerald-500">{stats.withQuota}</span>
            &nbsp;有额度
          </Badge>
          <Badge variant="secondary" className="tabular-nums">
            <span className="font-bold text-red-400">{stats.exhausted}</span>
            &nbsp;已耗尽
          </Badge>
          {stats.unknown > 0 && (
            <Badge variant="secondary" className="tabular-nums">
              <span className="font-bold text-muted-foreground">{stats.unknown}</span>
              &nbsp;未知
            </Badge>
          )}
        </div>

        {/* Per-model breakdown */}
        {stats.models.length > 0 && (
          <>
            <Separator />
            <div className="flex flex-col gap-1.5">
              {stats.models.map((m) => {
                const pct = m.total > 0 ? Math.round((m.withQuota / m.total) * 100) : 0;
                return (
                  <Tooltip key={m.id}>
                    <TooltipTrigger className="flex items-center gap-2 text-xs text-left">
                      <span className="min-w-[130px] text-muted-foreground truncate">
                        {m.displayName}
                      </span>
                      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                        <div
                          className={cn(
                            "h-full rounded-full transition-all duration-500",
                            quotaBarColor(pct),
                          )}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="min-w-[50px] text-right tabular-nums">
                        {m.withQuota}/{m.total}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {m.displayName}: {m.withQuota} 个有额度 / {m.total} 个账号 ({pct}%)
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Credits Overview Card ──

const chartConfig = {
  consumed: {
    label: "消耗",
    color: "var(--color-primary)",
  },
};

function CreditsOverviewCard() {
  const [stats, setStats] = useState<CreditStatsResponse | null>(null);
  const [snapshots, setSnapshots] = useState<CreditSnapshotsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [statsRes, snapshotsRes] = await Promise.all([
        fetch("/api/rosetta/credit-stats?days=7"),
        fetch("/api/rosetta/credit-snapshots?days=7"),
      ]);
      if (statsRes.ok) setStats(await statsRes.json());
      if (snapshotsRes.ok) setSnapshots(await snapshotsRes.json());
    } catch {
      // non-critical
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5 * 60 * 1000); // refresh every 5 min
    return () => clearInterval(interval);
  }, [fetchData]);

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">AI 积分</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-center py-8">
          <Spinner size={16} />
        </CardContent>
      </Card>
    );
  }

  const current = stats?.current;
  const today = stats?.today;
  const dailyData = stats?.dailyConsumption || [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">AI 积分</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* Summary stats */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <div className="text-2xl font-bold text-primary tabular-nums">
              {current?.totalCredits?.toLocaleString() ?? "-"}
            </div>
            <div className="text-xs text-muted-foreground">总积分</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-primary tabular-nums">
              {current?.accountsWithCredits ?? "-"}
              <span className="text-sm font-normal text-muted-foreground">
                /{current?.totalAccounts ?? "-"}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">有积分账号</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-amber-500 tabular-nums">
              {today?.consumed?.toLocaleString() ?? "-"}
            </div>
            <div className="text-xs text-muted-foreground">今日消耗</div>
          </div>
        </div>
        <div className="text-[10px] text-muted-foreground text-right">
          * 低于 50 积分的账号不计入统计
        </div>

        {/* Trend chart */}
        {dailyData.length > 1 && (
          <>
            <Separator />
            <div className="text-xs font-semibold text-muted-foreground mb-1">
              最近 7 天消耗
            </div>
            <ChartContainer config={chartConfig} className="h-[80px] w-full">
              <AreaChart data={dailyData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="creditFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-primary)" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="var(--color-primary)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => v.slice(5)} // "05-28" format
                  tick={{ fontSize: 10 }}
                />
                <YAxis hide />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      labelFormatter={(v) => `日期: ${v}`}
                    />
                  }
                />
                <Area
                  dataKey="consumed"
                  type="monotone"
                  fill="url(#creditFill)"
                  stroke="var(--color-primary)"
                  strokeWidth={1.5}
                />
              </AreaChart>
            </ChartContainer>
          </>
        )}

        {/* Balance trend (from snapshots) */}
        {snapshots && snapshots.snapshots.length > 2 && (
          <>
            <div className="text-xs font-semibold text-muted-foreground mb-1">
              余额趋势
            </div>
            <ChartContainer
              config={{ totalCredits: { label: "余额", color: "var(--color-primary)" } }}
              className="h-[60px] w-full"
            >
              <AreaChart
                data={snapshots.snapshots.map((s) => ({
                  time: new Date(s.timestamp).toLocaleString("zh-CN", {
                    timeZone: "Asia/Shanghai",
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                  totalCredits: s.totalCredits,
                }))}
                margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
              >
                <defs>
                  <linearGradient id="balanceFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-primary)" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="var(--color-primary)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="time"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 9 }}
                  interval="preserveStartEnd"
                />
                <YAxis hide />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      labelFormatter={(v) => `时间: ${v}`}
                    />
                  }
                />
                <Area
                  dataKey="totalCredits"
                  type="monotone"
                  fill="url(#balanceFill)"
                  stroke="var(--color-primary)"
                  strokeWidth={1.5}
                />
              </AreaChart>
            </ChartContainer>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Exported composite component ──

export function CreditQuotaDashboard({ accounts }: { accounts: QuotaAccount[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <QuotaOverviewCard accounts={accounts} />
      <CreditsOverviewCard />
    </div>
  );
}
