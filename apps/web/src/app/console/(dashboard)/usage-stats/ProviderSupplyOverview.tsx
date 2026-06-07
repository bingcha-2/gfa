"use client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BANDS, type Distribution } from "./distribution";

type ModelLike = { key: string; displayName: string; available: number; poolSize: number; distribution: Distribution };

function Donut({ d }: { d: Distribution }) {
  const total = BANDS.reduce((a, b) => a + d[b.key], 0) || 1;
  let acc = 0;
  const stops = BANDS.map((b) => {
    const start = (acc / total) * 360; acc += d[b.key];
    const end = (acc / total) * 360;
    return `${b.color} ${start}deg ${end}deg`;
  }).join(",");
  return <div className="size-14 rounded-full" style={{ background: `conic-gradient(${stops})` }} />;
}

export function ProviderSupplyOverview({ models }: { models: ModelLike[] }) {
  const sorted = [...models].sort((a, b) => a.available - b.available);
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">各模型供给(账号水位分布)</CardTitle></CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sorted.map((m) => (
          <div key={m.key} className="flex items-center gap-3 rounded-lg border p-3">
            <div className="relative shrink-0">
              <Donut d={m.distribution} />
              <span className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold tabular-nums">
                {m.available}/{m.poolSize}
              </span>
            </div>
            <div className="min-w-0">
              <div className="truncate text-xs font-medium">{m.displayName}</div>
              <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                {BANDS.filter((b) => b.key !== "noData" && m.distribution[b.key] > 0).map((b) => (
                  <span key={b.key}><span className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: b.color }} />{m.distribution[b.key]}</span>
                ))}
              </div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
