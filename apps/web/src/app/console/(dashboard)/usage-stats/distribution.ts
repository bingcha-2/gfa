export type Distribution = { exhausted: number; warn: number; low: number; healthy: number; noData: number };
export type BandKey = keyof Distribution;

export const BANDS: { key: BandKey; label: string; color: string }[] = [
  { key: "exhausted", label: "耗尽", color: "#ef4444" },
  { key: "warn", label: "紧张", color: "#f59e0b" },
  { key: "low", label: "偏低", color: "#eab308" },
  { key: "healthy", label: "健康", color: "#22c55e" },
  { key: "noData", label: "无数据", color: "#cbd5e1" },
];

export function visibleBars(d: Distribution, hidden: Set<BandKey>) {
  const shown = BANDS.filter((b) => !hidden.has(b.key));
  const max = Math.max(1, ...shown.map((b) => d[b.key]));
  return shown.map((b) => ({ key: b.key, label: b.label, color: b.color, count: d[b.key], max }));
}
