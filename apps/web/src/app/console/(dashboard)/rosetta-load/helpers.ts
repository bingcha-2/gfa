// ── Formatting helpers for rosetta-load dashboard ──

export function formatMs(ms: number | undefined | null): string {
  const n = Number(ms || 0);
  if (!n) return "-";
  if (n < 60000) return `${Math.round(n / 1000)} 秒`;
  const mins = Math.round(n / 60000);
  if (mins < 60) return `${mins} 分钟`;
  const hrs = Math.round((mins / 60) * 10) / 10;
  return `${hrs} 小时`;
}

export function formatTokenCount(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

export function formatDateTime(iso: string | undefined | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(iso);
  }
}

export function successRateColor(rate: number | null | undefined): string {
  if (rate == null) return "text-muted-foreground";
  if (rate >= 70) return "text-green-500";
  if (rate >= 50) return "text-yellow-500";
  return "text-red-500";
}

export function pressureColor(pct: number): string {
  if (pct > 60) return "bg-red-500";
  if (pct > 30) return "bg-yellow-500";
  return "bg-green-500";
}
