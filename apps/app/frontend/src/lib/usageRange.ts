export type UsageRange = '3day' | 'week' | 'thisWeek' | 'lastWeek' | 'month'
export const USAGE_RANGES: { key: UsageRange; label: string }[] = [
  { key: '3day', label: '近 3 天' }, { key: 'week', label: '近 7 天' },
  { key: 'thisWeek', label: '本周' }, { key: 'lastWeek', label: '上周' }, { key: 'month', label: '本月' },
]
export function usageDateKey(date: Date, utc = false) {
  return utc ? date.toISOString().slice(0, 10) : `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
}
export function usageRangeBounds(range: UsageRange, now = new Date(), utc = false) {
  const today = usageDateKey(now, utc)
  const end = new Date(`${today}T00:00:00Z`)
  const start = new Date(end)
  if (range === '3day' || range === 'week') start.setUTCDate(start.getUTCDate() - (range === '3day' ? 2 : 6))
  else if (range === 'month') start.setUTCDate(1)
  else {
    start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7)
    if (range === 'lastWeek') { end.setTime(start.getTime() - 86400000); start.setUTCDate(start.getUTCDate() - 7) }
  }
  return { start: start.toISOString().slice(0,10), end: end.toISOString().slice(0,10) }
}
export function selectUsageDays<T extends { date: string }>(history: T[], range: UsageRange, utc = false, now = new Date()) {
  const { start, end } = usageRangeBounds(range, now, utc)
  return history.filter(d => d.date >= start && d.date <= end).sort((a,b) => a.date.localeCompare(b.date))
}

/** Compact display only; never round stored usage or billing values. */
export function formatUsageTokens(value: number) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value)
}
