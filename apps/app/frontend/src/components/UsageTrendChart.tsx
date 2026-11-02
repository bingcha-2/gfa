import { USAGE_RANGES, selectUsageDays, formatUsageTokens, type UsageRange } from '@/lib/usageRange'
import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAppStore } from '@/stores/useAppStore'
import { useT, t as tr } from '@/i18n'

type Range = 'day' | UsageRange

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function TrendTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const val = (k: string) => Number(payload.find((p: any) => p.dataKey === k)?.value || 0)
  return (
    <div className="rounded-[6px] border border-[var(--border)] bg-[var(--bg-card)] px-2.5 py-1.5 text-[11px] shadow-md">
      <div className="mb-0.5 font-semibold text-[var(--text-primary)]">{label}</div>
      <div className="text-[var(--text-secondary)]"><i className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: 'var(--chart-2)' }} />{tr('trend.input')} {val('input').toLocaleString()}</div>
      <div className="text-[var(--text-secondary)]"><i className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: 'var(--chart-1)' }} />{tr('trend.output')} {val('output').toLocaleString()}</div>
      <div className="text-[var(--text-secondary)]"><i className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: 'var(--chart-4)' }} />{tr('trend.cacheWrite')} {val('cacheWrite').toLocaleString()}</div>
      <div className="text-[var(--text-secondary)]"><i className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: 'var(--chart-3)' }} />{tr('trend.cacheRead')} {val('cacheRead').toLocaleString()}</div>
    </div>
  )
}

export function UsageTrendChart({ history, utc = false, selectedRange }: { selectedRange?: UsageRange; utc?: boolean; history?: { date: string; inputTokens: number; outputTokens: number; cachedTokens?: number; cacheWriteTokens?: number }[] } = {}) {
  const t = useT()
  const { dailyHistory, hourlyHistory, chartMode } = useAppStore()
  // 默认档:只有今天有数据时落在「日」,否则「周」(对齐旧版 chartMode 自动判定)
  const [internalRange, setRange] = useState<Range>(history ? 'week' : chartMode === 'hourly' ? 'day' : 'week')

  const range = selectedRange ?? internalRange
  const RANGES: { key: Range; label: string }[] = [{ key: 'day', label: '今天' }, ...USAGE_RANGES]
  const rows = range === 'day'
    ? hourlyHistory.map((h) => ({ label: h.hour, input: h.inputTokens, output: h.outputTokens, cacheWrite: h.cacheWriteTokens || 0, cacheRead: h.cachedTokens || 0 }))
    : selectUsageDays(history ?? dailyHistory, range, utc).map((d) => ({ label: d.date, input: d.inputTokens, output: d.outputTokens, cacheWrite: d.cacheWriteTokens || 0, cacheRead: d.cachedTokens || 0 }))
  const hasData = rows.some((r) => r.input + r.output + r.cacheWrite + r.cacheRead > 0)
  // 标签密度:小时(24)隔 3 个、月(30)隔 2 个,其余全显
  const interval = range === 'day' ? 3 : range === 'month' ? 2 : 0

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>{`用量趋势 · ${RANGES.find(r => r.key === range)?.label}`}{utc && <span className="ml-2 text-[10px] font-normal text-[var(--text-muted)]">UTC</span>}</CardTitle>
        {!selectedRange && <div className="flex flex-wrap gap-0.5 rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] p-0.5">
          {RANGES.filter(r => !history || r.key !== 'day').map((r) => (
            <button
              key={r.key}
              type="button"
              aria-pressed={range === r.key} onClick={() => setRange(r.key)}
              className={`rounded-[6px] px-2 py-0.5 text-[11px] font-semibold transition-colors ${
                range === r.key
                  ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-[var(--shadow-sm)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>}
      </CardHeader>
      <CardContent>
        {hasData ? (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={rows} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--border-light)" strokeOpacity={0.6} />
              <XAxis dataKey="label" tickFormatter={v => range === 'day' ? v : v.slice(5)} interval={interval} tickLine={false} axisLine={false} tick={{ fontSize: 9, fill: 'var(--text-muted)' }} />
              <YAxis width={52} tickFormatter={formatUsageTokens} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
              <Tooltip cursor={{ fill: 'var(--bg-hover)' }} content={<TrendTooltip />} />
              <Bar dataKey="input" stackId="t" fill="var(--chart-2)" maxBarSize={28} />
              <Bar dataKey="output" stackId="t" fill="var(--chart-1)" maxBarSize={28} />
              <Bar dataKey="cacheWrite" stackId="t" fill="var(--chart-4)" maxBarSize={28} />
              <Bar dataKey="cacheRead" stackId="t" fill="var(--chart-3)" maxBarSize={28} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-[200px] items-center justify-center text-[12px] text-[var(--text-muted)]">{t('trend.noData')}</div>
        )}
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-[11px] text-[var(--text-muted)]">
          <span><i className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: 'var(--chart-2)' }} />{t('trend.input')}</span>
          <span><i className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: 'var(--chart-1)' }} />{t('trend.output')}</span>
          <span><i className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: 'var(--chart-4)' }} />{t('trend.cacheWrite')}</span>
          <span><i className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: 'var(--chart-3)' }} />{t('trend.cacheRead')}</span>
        </div>
      </CardContent>
    </Card>
  )
}
