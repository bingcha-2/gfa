/** Display recorded usage money without recalculating prices in the client. */
export function formatUsageMoney(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `$${value.toFixed(value > 0 && value < 0.01 ? 6 : 2)}`
}
