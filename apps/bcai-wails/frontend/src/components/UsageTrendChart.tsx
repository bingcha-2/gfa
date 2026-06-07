import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAppStore } from '@/stores/useAppStore'
import { formatTokens } from '@/lib/utils'

export function UsageTrendChart() {
  const { dailyHistory, hourlyHistory, chartMode } = useAppStore()
  const rows = chartMode === 'hourly'
    ? hourlyHistory.map((h) => ({ label: h.hour, input: h.inputTokens, output: h.outputTokens }))
    : [...dailyHistory].reverse().map((d) => ({ label: d.date.slice(5), input: d.inputTokens, output: d.outputTokens }))
  const max = Math.max(1, ...rows.map((r) => r.input + r.output))
  return (
    <Card>
      <CardHeader><CardTitle>用量趋势 · {chartMode === 'hourly' ? '今日(小时)' : '近 7 天'}</CardTitle></CardHeader>
      <CardContent>
        <div className="flex h-28 items-end gap-1.5">
          {rows.map((r, i) => (
            <div key={i} className="flex flex-1 flex-col items-center justify-end gap-1" title={`输入 ${formatTokens(r.input)} · 输出 ${formatTokens(r.output)}`}>
              <div className="flex w-3/5 flex-col justify-end" style={{ height: '100%' }}>
                <div style={{ height: `${(r.input / max) * 100}%`, background: '#60a5fa', borderRadius: '2px 2px 0 0' }} />
                <div style={{ height: `${(r.output / max) * 100}%`, background: '#a78bfa' }} />
              </div>
              <span className="text-[9px] text-[var(--text-muted)]">{r.label}</span>
            </div>
          ))}
        </div>
        <div className="mt-2 flex gap-4 text-[11px] text-[var(--text-muted)]">
          <span><i className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: '#60a5fa' }} />输入</span>
          <span><i className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: '#a78bfa' }} />输出</span>
        </div>
      </CardContent>
    </Card>
  )
}
