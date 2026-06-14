"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { AccountEmpty, AccountSkeleton } from "@/components/account/account-ui";
import { getUsageStats } from "@/lib/account/user-api";
import type { UsageDays, UsageStats } from "@/lib/account/user-types";
import { formatTokens } from "@/lib/format";
import { useDict } from "@/lib/i18n/client";

/** 模型分布饼图的分类色板(固定色相,在深浅两套主题下都清晰)。 */
const MODEL_COLORS = [
  "oklch(0.65 0.18 41)",
  "oklch(0.6 0.13 245)",
  "oklch(0.62 0.15 150)",
  "oklch(0.72 0.15 75)",
  "oklch(0.6 0.2 27)",
  "oklch(0.58 0.16 300)",
  "oklch(0.6 0.1 200)",
];
const MODEL_TOP = 6;

type TipPayload = {
  name?: string | number;
  value?: number | string;
  color?: string;
  payload?: { fill?: string };
}[];

function ChartTip({
  active,
  payload,
  label,
  format = formatTokens,
}: {
  active?: boolean;
  payload?: TipPayload;
  label?: string | number;
  format?: (n: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="account-chart-tip">
      {label != null && label !== "" && (
        <div className="account-chart-tip__label">{label}</div>
      )}
      {payload.map((p, i) => (
        <div key={i} className="account-chart-tip__row">
          <span
            className="account-chart-tip__dot"
            style={{ background: p.color ?? p.payload?.fill ?? "var(--primary)" }}
          />
          <span className="account-chart-tip__name">{p.name}</span>
          <span className="account-chart-tip__val">{format(Number(p.value) || 0)}</span>
        </div>
      ))}
    </div>
  );
}

const AXIS_TICK = { fontSize: 11, fill: "var(--ink-faint)" } as const;

function ChartCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="account-chart-card">
      <h3 className="account-chart-card__title">{title}</h3>
      <div className="account-chart-card__body">{children}</div>
    </section>
  );
}

export function UsageCharts({ days }: { days: UsageDays }) {
  const dict = useDict();
  const u = dict.portalApp.usage;

  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async (d: UsageDays) => {
    try {
      setStats(await getUsageStats(d));
      setLoadError(false);
    } catch {
      setStats(null);
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    setStats(null);
    void load(days);
  }, [days, load]);

  if (loadError) {
    return <p className="account-form-error">{u.loadFailed}</p>;
  }

  if (stats === null) {
    return (
      <div className="account-charts">
        {[0, 1, 2, 3].map((i) => (
          <AccountSkeleton key={i} className="account-chart-skeleton" />
        ))}
      </div>
    );
  }

  if (stats.totals.requests === 0) {
    return <AccountEmpty title={u.chartsEmpty} description={u.emptyDesc} />;
  }

  const { totals, status } = stats;
  const successRate =
    status.success + status.failed > 0
      ? Math.round((status.success / (status.success + status.failed)) * 100)
      : 0;

  // 模型分布:取前 N,其余归并为「其他」。
  const top = stats.byModel.slice(0, MODEL_TOP);
  const restTotal = stats.byModel
    .slice(MODEL_TOP)
    .reduce((s, m) => s + m.totalTokens, 0);
  const modelData = [
    ...top.map((m, i) => ({
      name: m.modelKey,
      value: m.totalTokens,
      fill: MODEL_COLORS[i % MODEL_COLORS.length],
    })),
    ...(restTotal > 0
      ? [{ name: u.otherModels, value: restTotal, fill: MODEL_COLORS[MODEL_TOP % MODEL_COLORS.length] }]
      : []),
  ];

  const statusData = [
    { name: u.statusSuccess, value: status.success, fill: "var(--ok)" },
    { name: u.chartFailed, value: status.failed, fill: "var(--danger)" },
  ];
  const countFmt = (n: number) => n.toLocaleString();

  return (
    <div className="account-charts-wrap">
      <div className="account-chart-kpis" role="group" aria-label={u.chartsKpiAria}>
        <div className="account-chart-kpi account-chart-kpi--accent" title={u.kpiSavedHint}>
          <span className="account-chart-kpi__label">{u.kpiSaved}</span>
          <strong className="account-chart-kpi__value">{`$${totals.savedUSD.toFixed(2)}`}</strong>
        </div>
        <div className="account-chart-kpi">
          <span className="account-chart-kpi__label">{u.kpiTotalTokens}</span>
          <strong className="account-chart-kpi__value">{formatTokens(totals.totalTokens)}</strong>
        </div>
        <div className="account-chart-kpi">
          <span className="account-chart-kpi__label">{u.kpiRequests}</span>
          <strong className="account-chart-kpi__value">{totals.requests.toLocaleString()}</strong>
        </div>
        <div className="account-chart-kpi">
          <span className="account-chart-kpi__label">{u.kpiSuccessRate}</span>
          <strong className="account-chart-kpi__value">{successRate}%</strong>
        </div>
      </div>

      <div className="account-charts">
        {/* 每日 Token 趋势 */}
        <ChartCard title={u.chartTrendTitle}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={stats.points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="usageTrendFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="var(--primary)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="label"
                tick={AXIS_TICK}
                tickLine={false}
                axisLine={{ stroke: "var(--line)" }}
                interval="preserveStartEnd"
                minTickGap={20}
              />
              <YAxis
                tick={AXIS_TICK}
                tickLine={false}
                axisLine={false}
                width={44}
                tickFormatter={formatTokens}
              />
              <Tooltip
                cursor={{ stroke: "var(--line-strong)" }}
                content={<ChartTip />}
              />
              <Area
                type="monotone"
                dataKey="totalTokens"
                name={u.colTotal}
                stroke="var(--primary)"
                strokeWidth={2}
                fill="url(#usageTrendFill)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* 输入 vs 输出 */}
        <ChartCard title={u.chartIoTitle}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={stats.points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="label"
                tick={AXIS_TICK}
                tickLine={false}
                axisLine={{ stroke: "var(--line)" }}
                interval="preserveStartEnd"
                minTickGap={20}
              />
              <YAxis
                tick={AXIS_TICK}
                tickLine={false}
                axisLine={false}
                width={44}
                tickFormatter={formatTokens}
              />
              <Tooltip cursor={{ fill: "var(--surface-2)" }} content={<ChartTip />} />
              <Bar dataKey="inputTokens" name={u.colInput} fill="var(--primary)" radius={[3, 3, 0, 0]} />
              <Bar dataKey="outputTokens" name={u.colOutput} fill="var(--info)" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* 模型分布 */}
        <ChartCard title={u.chartModelsTitle}>
          <div className="account-chart-split">
            <div className="account-chart-split__plot">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={modelData}
                    dataKey="value"
                    nameKey="name"
                    innerRadius="55%"
                    outerRadius="85%"
                    paddingAngle={1.5}
                    stroke="var(--surface)"
                    strokeWidth={2}
                  />
                  <Tooltip content={<ChartTip />} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <ul className="account-chart-legend">
              {modelData.map((m) => (
                <li key={m.name}>
                  <span className="account-chart-legend__dot" style={{ background: m.fill }} />
                  <span className="account-chart-legend__name" title={m.name}>
                    {m.name}
                  </span>
                  <span className="account-chart-legend__val">{formatTokens(m.value)}</span>
                </li>
              ))}
            </ul>
          </div>
        </ChartCard>

        {/* 成功 / 失败 */}
        <ChartCard title={u.chartStatusTitle}>
          <div className="account-chart-split">
            <div className="account-chart-split__plot account-chart-donut">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={statusData}
                    dataKey="value"
                    nameKey="name"
                    innerRadius="62%"
                    outerRadius="88%"
                    paddingAngle={1.5}
                    stroke="var(--surface)"
                    strokeWidth={2}
                  />
                  <Tooltip content={<ChartTip format={countFmt} />} />
                </PieChart>
              </ResponsiveContainer>
              <div className="account-chart-donut__center" aria-hidden>
                <strong>{successRate}%</strong>
                <span>{u.kpiSuccessRate}</span>
              </div>
            </div>
            <ul className="account-chart-legend">
              {statusData.map((d) => (
                <li key={d.name}>
                  <span className="account-chart-legend__dot" style={{ background: d.fill }} />
                  <span className="account-chart-legend__name">{d.name}</span>
                  <span className="account-chart-legend__val">{d.value.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </div>
        </ChartCard>
      </div>
    </div>
  );
}
