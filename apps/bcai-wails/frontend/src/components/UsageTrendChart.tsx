import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAppStore } from '@/stores/useAppStore'
import { formatTokens } from '@/lib/utils'

type Range = 'day' | '3day' | 'week' | 'month'

const RANGES: { key: Range; label: string }[] = [
  { key: 'day', label: '日' },
  { key: '3day', label: '3 日' },
  { key: 'week', label: '周' },
  { key: 'month', label: '月' },
]

// 日=按小时(今日),其余=按天;近 N 天从 dailyHistory(倒序,今天在前)切片再反转成正序
const DAYS: Record<Exclude<Range, 'day'>, number> = { '3day': 3, week: 7, month: 30 }
const TITLE: Record<Range, string> = { day: '今日(小时)', '3day': '近 3 天', week: '近 7 天', month: '近 30 天' }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function TrendTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const val = (k: string) => Number(payload.find((p: any) => p.dataKey === k)?.value || 0)
  return (
    <div className="rounded-[6px] border border-[var(--border)] bg-[var(--bg-card)] px-2.5 py-1.5 text-[11px] shadow-md">
      <div className="mb-0.5 font-semibold text-[var(--text-primary)]">{label}</div>
      <div className="text-[var(--text-secondary)]"><i className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: '#60a5fa' }} />输入 {formatTokens(val('input'))}</div>
      <div className="text-[var(--text-secondary)]"><i className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: '#a78bfa' }} />输出 {formatTokens(val('output'))}</div>
    </div>
  )
}

export function UsageTrendChart() {
  const { dailyHistory, hourlyHistory, chartMode } = useAppStore()
  // 默认档:只有今天有数据时落在「日」,否则「周」(对齐旧版 chartMode 自动判定)
  const [range, setRange] = useState<Range>(chartMode === 'hourly' ? 'day' : 'week')

  const rows = range === 'day'
    ? hourlyHistory.map((h) => ({ label: h.hour, input: h.inputTokens, output: h.outputTokens }))
    : [...dailyHistory].slice(0, DAYS[range]).reverse().map((d) => ({ label: d.date.slice(5), input: d.inputTokens, output: d.outputTokens }))
  const hasData = rows.some((r) => r.input + r.output > 0)
  // 标签密度:小时(24)隔 3 个、月(30)隔 2 个,其余全显
  const interval = range === 'day' ? 3 : range === 'month' ? 2 : 0

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>用量趋势 · {TITLE[range]}</CardTitle>
        <div className="flex gap-0.5 rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRange(r.key)}
              className={`rounded-[6px] px-2 py-0.5 text-[11px] font-semibold transition-colors ${
                range === r.key
                  ? 'bg-[var(--primary)] text-white'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
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
              <Tooltip cursor={{ fill: 'rgba(99,102,241,0.06)' }} content={<TrendTooltip />} />
              <Bar dataKey="input" stackId="t" fill="#60a5fa" maxBarSize={28} />
              <Bar dataKey="output" stackId="t" fill="#a78bfa" maxBarSize={28} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-[132px] items-center justify-center text-[12px] text-[var(--text-muted)]">近期无用量</div>
        )}
        <div className="mt-2 flex gap-4 text-[11px] text-[var(--text-muted)]">
          <span><i className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: '#60a5fa' }} />输入</span>
          <span><i className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: '#a78bfa' }} />输出</span>
        </div>
      </CardContent>
    </Card>
  )
}
