export type Distribution = { exhausted: number; warn: number; low: number; healthy: number; noData: number };
export type BandKey = keyof Distribution;

// Water bands: worst → best, then no-data. Drives the supply donut slices + legend.
export const BANDS: { key: BandKey; label: string; color: string }[] = [
  { key: "exhausted", label: "耗尽", color: "#ef4444" },
  { key: "warn", label: "紧张", color: "#f59e0b" },
  { key: "low", label: "偏低", color: "#eab308" },
  { key: "healthy", label: "健康", color: "#22c55e" },
  { key: "noData", label: "无数据", color: "#cbd5e1" },
];
