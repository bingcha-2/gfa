/**
 * 统一 token 显示:阶梯 K → M → B,最小单位 K(小于 1K 也显示为 0.xxK)。
 * 整数不带小数,非整数保留两位小数;0 → "0"。
 * 与客户端 apps/app(frontend lib/utils.ts 与 Go leaser_status.go)口径一致。
 * 例:842→"0.84K" · 1200→"1.20K" · 12000→"12K" · 1M · 1.50M · 3.45B
 */
export function formatTokens(n: number | null | undefined): string {
  const x = Math.max(0, Math.floor(Number(n) || 0));
  if (x === 0) return "0";
  let v: number, unit: string;
  if (x >= 1_000_000_000) { v = x / 1_000_000_000; unit = "B"; }
  else if (x >= 1_000_000) { v = x / 1_000_000; unit = "M"; }
  else { v = x / 1_000; unit = "K"; }
  return (Number.isInteger(v) ? String(v) : v.toFixed(2)) + unit;
}

export function formatDateTime(value?: string | null) {
  if (!value) {
    return "N/A";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}
