"use client";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BANDS, visibleBars, type BandKey, type Distribution } from "./distribution";

export function ModelDistributionChart({ title, distribution }: { title: string; distribution: Distribution }) {
  const [hidden, setHidden] = useState<Set<BandKey>>(new Set(["noData"]));
  const bars = visibleBars(distribution, hidden);
  const toggle = (k: BandKey) => setHidden((prev) => {
    const next = new Set(prev); next.has(k) ? next.delete(k) : next.add(k); return next;
  });
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">{title} · 账号水位分布</CardTitle></CardHeader>
      <CardContent>
        <div className="mb-3 flex flex-wrap gap-2">
          {BANDS.map((b) => (
            <button key={b.key} onClick={() => toggle(b.key)}
              className={`cursor-pointer rounded-full px-2.5 py-1 text-xs font-medium transition ${hidden.has(b.key) ? "opacity-40 line-through" : ""}`}
              style={{ background: `${b.color}22`, color: b.color }}>
              ● {b.label} {distribution[b.key]}
            </button>
          ))}
        </div>
        <div className="flex h-36 items-end gap-3 border-b pb-1">
          {bars.map((b) => (
            <div key={b.key} className="flex flex-1 flex-col items-center justify-end gap-1">
              <span className="text-sm font-bold tabular-nums" style={{ color: b.color }}>{b.count}</span>
              <div className="w-full rounded-t" style={{ height: `${(b.count / b.max) * 100}%`, minHeight: 4, background: b.color }} />
              <span className="text-[10px] text-muted-foreground">{b.label}</span>
            </div>
          ))}
          {bars.length === 0 && <div className="flex-1 py-8 text-center text-xs text-muted-foreground">所有档已隐藏</div>}
        </div>
        <div className="mt-2 text-[10px] text-muted-foreground">
          点上方标签开关档。<Badge variant="outline" className="ml-1">默认隐藏无数据</Badge>
        </div>
      </CardContent>
    </Card>
  );
}
