import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAppStore } from '@/stores/useAppStore'
import { formatTokens } from '@/lib/utils'
import { useT, t as tr } from '@/i18n'

type Range = 'day' | '3day' | 'week' | 'month'

// 日=按小时(今日),其余=按天;近 N 天从 dailyHistory(倒序,今天在前)切片再反转成正序
const DAYS: Record<Exclude<Range, 'day'>, number> = { '3day': 3, week: 7, month: 30 }
const TITLE_KEY: Record<Range, string> = { day: 'trend.titleDay', '3day': 'trend.title3Day', week: 'trend.titleWeek', month: 'trend.titleMonth' }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function TrendTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const val = (k: string) => Number(payload.find((p: any) => p.dataKey === k)?.value || 0)
  return (
    <div className="rounded-[6px] border border-[var(--border)] bg-[var(--bg-card)] px-2.5 py-1.5 text-[11px] shadow-md">
      <div className="mb-0.5 font-semibold text-[var(--text-primary)]">{label}</div>
      <div className="text-[var(--text-secondary)]"><i className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: 'var(--chart-2)' }} />{tr('trend.input')} {formatTokens(val('input'))}</div>
      <div className="text-[var(--text-secondary)]"><i className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: 'var(--chart-1)' }} />{tr('trend.output')} {formatTokens(val('output'))}</div>
      <div className="text-[var(--text-secondary)]"><i className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: 'var(--chart-4)' }} />{tr('trend.cacheWrite')} {formatTokens(val('cacheWrite'))}</div>
      <div className="text-[var(--text-secondary)]"><i className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: 'var(--chart-3)' }} />{tr('trend.cacheRead')} {formatTokens(val('cacheRead'))}</div>
    </div>
  )
}

export function UsageTrendChart() {
  const t = useT()
  const { dailyHistory, hourlyHistory, chartMode } = useAppStore()
  // 默认档:只有今天有数据时落在「日」,否则「周」(对齐旧版 chartMode 自动判定)
  const [range, setRange] = useState<Range>(chartMode === 'hourly' ? 'day' : 'week')

  const RANGES: { key: Range; label: string }[] = [
    { key: 'day', label: t('trend.rangeDay') },
    { key: '3day', label: t('trend.range3Day') },
    { key: 'week', label: t('trend.rangeWeek') },
    { key: 'month', label: t('trend.rangeMonth') },
  ]

  const rows = range === 'day'
    ? hourlyHistory.map((h) => ({ label: h.hour, input: h.inputTokens, output: h.outputTokens, cacheWrite: h.cacheWriteTokens || 0, cacheRead: h.cachedTokens || 0 }))
    : [...dailyHistory].slice(0, DAYS[range]).reverse().map((d) => ({ label: d.date.slice(5), input: d.inputTokens, output: d.outputTokens, cacheWrite: d.cacheWriteTokens || 0, cacheRead: d.cachedTokens || 0 }))
  const hasData = rows.some((r) => r.input + r.output + r.cacheWrite + r.cacheRead > 0)
  // 标签密度:小时(24)隔 3 个、月(30)隔 2 个,其余全显
  const interval = range === 'day' ? 3 : range === 'month' ? 2 : 0

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>{t('trend.title', { range: t(TITLE_KEY[range]) })}</CardTitle>
        <div className="flex gap-0.5 rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRange(r.key)}
              className={`rounded-[6px] px-2 py-0.5 text-[11px] font-semibold transition-colors ${
                range === r.key
                  ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-[var(--shadow-sm)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {hasData ? (
          <ResponsiveContainer width="100%" height={132}>
            <BarChart data={rows} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--border-light)" strokeOpacity={0.6} />
              <XAxis dataKey="label" interval={interval} tickLine={false} axisLine={false} tick={{ fontSize: 9, fill: 'var(--text-muted)' }} />
              <Tooltip cursor={{ fill: 'var(--bg-hover)' }} content={<TrendTooltip />} />
              <Bar dataKey="input" stackId="t" fill="var(--chart-2)" maxBarSize={28} />
              <Bar dataKey="output" stackId="t" fill="var(--chart-1)" maxBarSize={28} />
              <Bar dataKey="cacheWrite" stackId="t" fill="var(--chart-4)" maxBarSize={28} />
              <Bar dataKey="cacheRead" stackId="t" fill="var(--chart-3)" maxBarSize={28} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-[132px] items-center justify-center text-[12px] text-[var(--text-muted)]">{t('trend.noData')}</div>
        )}
        <div className="mt-2 flex gap-4 text-[11px] text-[var(--text-muted)]">
          <span><i className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: 'var(--chart-2)' }} />{t('trend.input')}</span>
          <span><i className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: 'var(--chart-1)' }} />{t('trend.output')}</span>
          <span><i className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: 'var(--chart-4)' }} />{t('trend.cacheWrite')}</span>
          <span><i className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: 'var(--chart-3)' }} />{t('trend.cacheRead')}</span>
        </div>
      </CardContent>
    </Card>
  )
}
