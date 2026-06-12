"use client";
import { Label, Pie, PieChart } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { BANDS, type Distribution } from "./distribution";

type ModelLike = { key: string; displayName: string; available: number; poolSize: number; distribution: Distribution };

// shadcn chart config: band key → label + color (drives legend + tooltip).
const chartConfig: ChartConfig = Object.fromEntries(
  BANDS.map((b) => [b.key, { label: b.label, color: b.color }]),
) as ChartConfig;

function DonutCard({ m }: { m: ModelLike }) {
  // Donut slices = account counts per water band; drop empty bands so the ring
  // shows only what's present. (noData kept so a never-used pool still renders.)
  const data = BANDS.map((b) => ({ key: b.key, label: b.label, value: m.distribution[b.key], fill: b.color })).filter(
    (d) => d.value > 0,
  );
  const hasData = data.length > 0;

  return (
    <div className="rounded-lg border p-3">
      <div className="mb-1 truncate text-xs font-medium">{m.displayName}</div>
      <ChartContainer config={chartConfig} className="mx-auto aspect-square h-[150px]">
        <PieChart>
          <ChartTooltip cursor={false} content={<ChartTooltipContent nameKey="label" hideLabel />} />
          <Pie data={hasData ? data : [{ key: "empty", label: "无", value: 1, fill: "#e5e7eb" }]} dataKey="value" nameKey="label" innerRadius={48} outerRadius={68} strokeWidth={2} paddingAngle={hasData ? 2 : 0}>
            <Label
              content={({ viewBox }) => {
                if (viewBox && "cx" in viewBox && viewBox.cx != null && viewBox.cy != null) {
                  return (
                    <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                      <tspan x={viewBox.cx} y={viewBox.cy} className="fill-foreground text-lg font-bold tabular-nums">
                        {m.available}/{m.poolSize}
                      </tspan>
                      <tspan x={viewBox.cx} y={(viewBox.cy as number) + 18} className="fill-muted-foreground text-[10px]">
                        可用
                      </tspan>
                    </text>
                  );
                }
                return null;
              }}
            />
          </Pie>
        </PieChart>
      </ChartContainer>
      {/* Legend: only non-zero bands, problem bands first */}
      <div className="mt-1 flex flex-wrap justify-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        {BANDS.filter((b) => m.distribution[b.key] > 0).map((b) => (
          <span key={b.key} className="inline-flex items-center gap-1">
            <span className="inline-block size-2 rounded-sm" style={{ background: b.color }} />
            {b.label} {m.distribution[b.key]}
          </span>
        ))}
      </div>
    </div>
  );
}

export function ProviderSupplyOverview({ models }: { models: ModelLike[] }) {
  // Most-constrained first: fewest available accounts.
  const sorted = [...models].sort((a, b) => a.available - b.available);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">各模型供给 · 账号水位分布</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sorted.map((m) => (
          <DonutCard key={m.key} m={m} />
        ))}
      </CardContent>
    </Card>
  );
}
