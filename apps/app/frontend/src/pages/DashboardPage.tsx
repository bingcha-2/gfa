import { formatUsageMoney } from '@/lib/formatUsageMoney'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/stores/useAppStore'
import { GatewayUsagePanel } from '@/components/GatewayUsagePanel'
import { SubscriptionUsageCarousel } from '@/components/SubscriptionUsageCarousel'
import { UsageTrendChart } from '@/components/UsageTrendChart'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { activeProducts, PRODUCT_NAMES, productModels, sumModels } from '@/lib/productUsage'
import { formatTokens } from '@/lib/utils'

export function DashboardPage() {
  const { account, gateway, todayByModel, dailyHistory, heartbeat } = useAppStore()
  const [selection, setSelection] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const products = activeProducts(account?.subscriptions ?? [])
  const product = products.includes(selection) ? selection : products[0]
  const subscriptions = (account?.subscriptions ?? []).filter(sub => sub.status.toUpperCase() === 'ACTIVE' && (!sub.expiresAt || Date.parse(sub.expiresAt) > Date.now()) && sub.products.includes(product)).map(sub => ({ ...sub, products: [product] }))
  const models = productModels(todayByModel, product)
  const today = sumModels(models)
  // Legacy aggregate totals can contain several products; only attributed model rows may enter a product chart.
  const history = dailyHistory.map(day => ({ date: day.date, ...sumModels(productModels(day.byModel, product)) }))

  return <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-4 pt-3">
    <div className="flex items-center justify-between gap-3"><p className="text-[13px] leading-6 text-[var(--text-secondary)]">查看各产品的剩余额度和使用记录。</p><Button variant="secondary" size="sm" disabled={refreshing} onClick={async () => { setRefreshing(true); try { await heartbeat(true) } finally { setRefreshing(false) } }}>{refreshing ? '刷新中…' : '刷新'}</Button></div>
    {products.length > 1 && <div role="group" aria-label="选择产品" className="flex flex-wrap gap-2">
      {products.map(id => <button key={id} type="button" aria-pressed={id === product} onClick={() => setSelection(id)} className={`rounded-lg px-4 py-2 text-[13px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)] ${id === product ? 'bg-[var(--primary-light)] text-[var(--primary-strong)]' : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'}`}>{PRODUCT_NAMES[id]}</button>)}
    </div>}
    {!product ? <Card><CardContent className="py-8 text-sm text-[var(--text-secondary)]">暂无有效订阅，请先开通套餐。</CardContent></Card> : product === 'anthropic' ? <GatewayUsagePanel summary={gateway} /> : <>
      <Card><CardHeader><CardTitle>{PRODUCT_NAMES[product]} · 剩余额度</CardTitle></CardHeader><CardContent><SubscriptionUsageCarousel subscriptions={subscriptions} /></CardContent></Card>
      <Card><CardHeader><CardTitle>今日用量</CardTitle></CardHeader><CardContent>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 text-xs text-[var(--text-secondary)]">
          {[['请求数', today.requests], ['输入 Token', today.inputTokens], ['输出 Token', today.outputTokens], ['缓存 Token', today.cachedTokens + today.cacheWriteTokens]].map(([label, value]) => <div key={label}><p>{label}</p><p className="mt-2 font-mono-data text-lg text-[var(--text-primary)]">{formatTokens(Number(value))}</p></div>)}
        </div>
      </CardContent></Card>
      <p className="text-xs text-[var(--text-secondary)]">今日折算金额 {formatUsageMoney(models.reduce((sum, m) => sum + (m.estimatedCostUSD || 0), 0))}</p>
      <UsageTrendChart key={product} history={history} />
      <Card><CardHeader><CardTitle>今日模型用量</CardTitle></CardHeader><CardContent>
        {!models.length ? <p className="py-4 text-xs text-[var(--text-muted)]">暂无该产品的模型用量记录。</p> : <div className="overflow-x-auto"><table className="w-full min-w-[480px] text-xs [&_th]:px-2 [&_th]:py-2 [&_th]:text-right [&_th]:font-medium [&_th]:text-[var(--text-muted)] [&_td]:px-2 [&_td]:py-3 [&_td]:text-right [&_tr>*:first-child]:text-left [&_tbody_tr]:border-t [&_tbody_tr]:border-[var(--border-light)]">
          <thead><tr><th>模型</th><th>请求</th><th>输入</th><th>输出</th><th>缓存读 / 写</th><th>折算金额</th></tr></thead><tbody>{models.map(m => <tr key={m.modelKey}><td>{m.displayName || m.modelKey}</td><td>{m.requests || 0}</td><td>{m.inputTokens || 0}</td><td>{m.outputTokens || 0}</td><td>{m.cachedTokens || 0} / {m.cacheWriteTokens || 0}</td><td>{formatUsageMoney(m.estimatedCostUSD)}</td></tr>)}</tbody>
        </table></div>}
      </CardContent></Card>
    </>}
  </div>
}
