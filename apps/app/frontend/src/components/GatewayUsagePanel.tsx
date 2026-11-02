import { useState } from 'react'
import { USAGE_RANGES, selectUsageDays, formatUsageTokens, type UsageRange } from '@/lib/usageRange'
import { formatUsageMoney } from '@/lib/formatUsageMoney'
import { formatResetDuration, quotaColor } from '@/lib/quotaDisplay'
import type { GatewaySummary, GatewayModelUsage } from '@/services/wails'
import { AlertCircle } from 'lucide-react'
import { UsageTrendChart } from './UsageTrendChart'
import { Progress } from '@/components/ui/progress'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'


export function GatewayUsagePanel({ summary: s }: { summary: GatewaySummary | null }) {
  const [range, setRange] = useState<UsageRange>('week')
  const days = selectUsageDays(s?.dailyHistory ?? [], range, true)
  const grouped = new Map<string, GatewayModelUsage>()
  for (const day of days) for (const model of Object.values(day.byModel ?? {})) {
    const sum = grouped.get(model.model) ?? { model: model.model, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5m: 0, cacheWrite1h: 0, costUsd: 0 }
    for (const key of ['requests', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWrite5m', 'cacheWrite1h', 'costUsd'] as const) sum[key] = (sum[key] ?? 0) + (model[key] ?? 0)
    grouped.set(model.model, sum)
  }
  const models = [...grouped.values()].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))
  const tokens = (value: number) => <span title={`${value.toLocaleString()} Token`}>{formatUsageTokens(value)}</span>
  const windows = (s?.windows ?? []).filter(w => w.state !== "unlimited" && ["5h", "7d"].includes(w.period))
  const issue = !s?.subscriptionValid ? '需要有效的 Claude 订阅' : !s?.configured ? '尚未分配使用额度' : !s.enabled ? '你的服务已停用' : !s.upstreamEnabled ? '服务暂不可用' : windows.some(w => w.exhausted) ? '额度已用完，等待恢复' : null
  const explanation = !s?.subscriptionValid ? '请先开通或续费 Claude 套餐。' : '请联系管理员检查订阅、额度或账号状态。'
  return <div className="flex flex-col gap-4"><Card>
    <CardHeader><CardTitle>Claude</CardTitle></CardHeader>
    <CardContent className="text-[13px] leading-6">
      {!s || s.loading ? <p>正在读取用量…</p> : s.error ? <p role="alert">{s.error}</p> : <>
        {issue && <div role="alert" className="mb-6 flex items-start gap-3 rounded-lg bg-[var(--bg-tertiary)] p-4">
          <AlertCircle size={17} className="mt-0.5 shrink-0 text-[var(--warning)]" />
          <div><p className="font-semibold text-[var(--text-primary)]">{issue}</p><p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">{explanation}</p></div>
        </div>}
        {s.configured && <>
          <div className="grid gap-5 py-2 sm:grid-cols-2">
            {windows.map(w => {
              const label = w.period === '5h' ? '5 小时' : '每周'
              const percent = w.state === 'limited' && w.remaining != null && Number.isFinite(w.remaining) ? Math.max(0, Math.min(100, w.remaining * 100)) : null
              const reset = w.resetAt ? formatResetDuration(w.resetAt - Date.now()) : ''
              return <section key={w.period} className="flex flex-col gap-2">
                <div className="flex items-center justify-between"><span className="font-medium">{label}剩余额度</span><span className="text-[var(--text-secondary)]">{percent === null ? '暂未获取' : `${percent.toFixed(1)}%`}</span></div>
                <Progress value={percent} aria-label={`Claude ${label}剩余额度`} indicatorClassName="bg-[var(--quota-color)]" style={{ '--quota-color': quotaColor(percent ?? 100) } as React.CSSProperties} />
                {percent !== null && reset && <p className="text-xs text-[var(--text-muted)]">{reset} 后恢复</p>}
              </section>
            })}
          </div>
          <p className="mt-3 text-xs text-[var(--text-secondary)]">本周期已用 <span className="font-mono-data">{formatUsageMoney(s.usedUsd)}</span></p>
          <div className="mt-6 divide-y divide-[var(--border-light)] border-y border-[var(--border-light)]">
            <section>
              <h3 className="py-4 font-semibold">模型用量 <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">累计 {s.totalRequests ?? 0} 次请求</span></h3>
              <div className="pb-4">
                <div className="mb-4 flex flex-wrap gap-1" role="group" aria-label="用量时间范围">{USAGE_RANGES.map(r => <button key={r.key} type="button" aria-pressed={range === r.key} onClick={() => setRange(r.key)} className={`rounded-md px-3 py-1.5 text-xs focus-visible:outline focus-visible:outline-2 ${range === r.key ? 'bg-[var(--bg-tertiary)] font-semibold text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'}`}>{r.label}</button>)}</div>
                <p className="mb-2 text-sm font-medium">所选时段 · {days.reduce((n, d) => n + d.requests, 0)} 次请求 · {formatUsageMoney(days.reduce((n, d) => n + d.costUsd, 0))}</p>
                <p className="mb-3 text-xs text-[var(--text-secondary)]">累计折算金额 {formatUsageMoney(s.totalUsedUsd)} · 用量单位：Token</p>
                {models.length ? <div className="overflow-x-auto"><table className="w-full min-w-[520px] text-xs [&_th]:px-2 [&_th]:py-2 [&_th]:text-right [&_th]:font-medium [&_th]:text-[var(--text-muted)] [&_td]:px-2 [&_td]:py-3 [&_td]:text-right [&_td]:font-mono-data [&_tr>*:first-child]:text-left [&_tbody_tr]:border-t [&_tbody_tr]:border-[var(--border-light)]">
                  <thead><tr><th>模型</th><th>请求</th><th>输入</th><th>输出</th><th>缓存读 / 写</th><th>折算金额</th></tr></thead><tbody>{models.map(m => <tr key={m.model}><td>{m.model}</td><td>{m.requests}</td><td>{tokens(m.inputTokens ?? 0)}</td><td>{tokens(m.outputTokens ?? 0)}</td><td>{tokens(m.cacheReadTokens ?? 0)} / {tokens((m.cacheWrite5m ?? 0) + (m.cacheWrite1h ?? 0))}</td><td>{formatUsageMoney(m.costUsd)}</td></tr>)}</tbody>
                </table></div> : <p className="text-xs text-[var(--text-muted)]">所选时段暂无用量记录。</p>}
              </div>
            </section>

          </div>
        </>}
      </>}
    </CardContent>
  </Card>
    {s?.configured && !s.error && <UsageTrendChart utc selectedRange={range} history={s.dailyHistory ?? []} />}
  </div>
}
