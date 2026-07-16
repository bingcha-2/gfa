import { useAppStore } from '@/stores/useAppStore'
import { StatusPill } from '@/components/StatusPill'
import { NotificationBanner } from '@/components/NotificationBanner'
import { PromoCard } from '@/components/PromoCard'
import { SubscriptionUsageCarousel } from '@/components/SubscriptionUsageCarousel'
import { UsageTrendChart } from '@/components/UsageTrendChart'
import { buildModelUsageRows, buildUsageOverview, pricingQualityLabel, type ModelUsageRow } from '@/lib/usageSummary'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import * as api from '@/services/wails'
import { cn, formatTokens } from '@/lib/utils'
import { useT } from '@/i18n'
import { useState } from 'react'
import { BarChart3, RefreshCw } from 'lucide-react'

function formatUSD(value: number): string {
  const n = Math.max(0, Number(value) || 0)
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

function formatRatio(value: number): string {
  const n = Math.max(0, Number(value) || 0)
  if (n > 0 && n < 0.001) return '<0.1%'
  return `${(n * 100).toFixed(1)}%`
}

/** 顶部「今日概览」里的一格统计。数字大、标签小,克制单色,只有关键项点琥珀。 */
function Stat({ label, value, caption, tone }: { label: string; value: string; caption?: string; tone?: 'primary' | 'danger' }) {
  return (
    <div>
      <div
        className={cn(
          'font-mono-data text-[14px] font-semibold tracking-tight tabular-nums',
          tone === 'primary' ? 'text-[var(--primary)]'
            : tone === 'danger' ? 'text-[var(--danger)]'
            : 'text-[var(--text-primary)]',
        )}
      >
        {value}
      </div>
      <div className="mt-1 text-[9px] text-[var(--text-muted)]">{label}</div>
      {caption && <div className="mt-0.5 text-[9px] leading-snug text-[var(--text-muted)]">{caption}</div>}
    </div>
  )
}

function ModelUsageTable({ rows }: { rows: ModelUsageRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="flex h-[118px] items-center justify-center px-4 text-[12px] text-[var(--text-muted)]">
        暂无模型明细,有请求后会显示
      </div>
    )
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] border-collapse text-[11px]">
        <thead className="bg-[var(--bg-tertiary)]/60 text-[var(--text-muted)]">
          <tr className="[&>th]:whitespace-nowrap [&>th]:px-3 [&>th]:py-2 [&>th]:font-medium">
            <th className="text-left">模型</th>
            <th className="text-right">请求数</th>
            <th className="text-right">输入 Token</th>
            <th className="text-right">输出 Token</th>
            <th className="text-right">缓存读</th>
            <th className="text-right">缓存写</th>
            <th className="text-right">合计 Token</th>
            <th className="text-right">其中 fast</th>
            <th className="text-right">API 等价价值</th>
            <th className="text-right">占今日成本比例</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border-light)]">
          {rows.map((row) => (
            <tr key={row.modelKey} className="text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
              <td className="max-w-[190px] px-3 py-2.5">
                <div className="truncate text-[12px] font-semibold text-[var(--text-primary)]" title={row.displayName}>{row.displayName}</div>
                {row.modelKey !== row.displayName && (
                  <div className="truncate font-mono-data text-[10px] text-[var(--text-muted)]" title={row.modelKey}>{row.modelKey}</div>
                )}
              </td>
              <td className="px-3 py-2.5 text-right font-mono-data tabular-nums">{row.requests.toLocaleString()}</td>
              <td className="px-3 py-2.5 text-right font-mono-data tabular-nums">{formatTokens(row.inputTokens)}</td>
              <td className="px-3 py-2.5 text-right font-mono-data tabular-nums">{formatTokens(row.outputTokens)}</td>
              <td className="px-3 py-2.5 text-right font-mono-data tabular-nums">{formatTokens(row.cachedTokens)}</td>
              <td className="px-3 py-2.5 text-right font-mono-data tabular-nums">{formatTokens(row.cacheWriteTokens)}</td>
              <td className="px-3 py-2.5 text-right font-mono-data tabular-nums text-[var(--text-primary)]">{formatTokens(row.totalTokens)}</td>
              <td className="px-3 py-2.5 text-right font-mono-data tabular-nums" title="走快速档（Priority）的原始 Token，价值按该模型官方 Priority 价格计算">
                {row.fastTokens > 0
                  ? <span className="text-[var(--primary)]">{formatTokens(row.fastTokens)}</span>
                  : <span className="text-[var(--text-muted)]">—</span>}
              </td>
              <td className="px-3 py-2.5 text-right">
                <div className="font-mono-data tabular-nums text-[var(--text-primary)]">{formatUSD(row.estimatedCostUSD)}</div>
                <div className="mt-0.5 text-[9px] text-[var(--text-muted)]">{pricingQualityLabel(row.pricingQuality)}</div>
              </td>
              <td className="px-3 py-2.5">
                <div className="flex items-center justify-end gap-2">
                  <span className="w-11 text-right font-mono-data tabular-nums text-[var(--text-primary)]">{formatRatio(row.costShare)}</span>
                  <span className="h-1.5 w-14 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
                    <span className="block h-full rounded-full bg-[var(--primary)]" style={{ width: `${Math.min(100, row.costShare * 100)}%` }} />
                  </span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function DashboardPage() {
  const t = useT()
  const {
    account,
    leaserError, hasToken, autoLeaseRunning, accountId, cardUnusable,
    todayRequests, todayErrors, todayInputTokens, todayOutputTokens,
    todayCacheWriteTokens, todayCachedTokens, todayApiValueUSD, todayByModel, cumulativeSaving,
    localTodayTokens, localTodayApiValueUSD,
    fetchStats, heartbeat,
  } = useAppStore()

  // 个人美元额度来自 app heartbeat，而不是母号上游快照。
  const [refreshingQuota, setRefreshingQuota] = useState(false)
  const handleRefreshQuota = async () => {
    if (refreshingQuota) return
    setRefreshingQuota(true)
    try {
      try {
        await api.refreshQuota()
      } catch (err) {
        console.error('refresh upstream quota failed:', err)
      }
      try {
        await heartbeat(true)
      } catch (err) {
        console.error('refresh subscription quota failed:', err)
      }
      await fetchStats()
    } finally {
      setRefreshingQuota(false)
    }
  }

  const hasSubscriptions = !!(account?.subscriptions && account.subscriptions.length > 0)

  const overview = buildUsageOverview({
    today: {
      inputTokens: todayInputTokens,
      outputTokens: todayOutputTokens,
      cachedTokens: todayCachedTokens,
      cacheWriteTokens: todayCacheWriteTokens,
      savedMoneyUSD: todayApiValueUSD,
    },
    successfulCalls: todayRequests,
    errors: todayErrors,
    cumulativeApiValueUSD: cumulativeSaving,
  })
  const modelUsageRows = buildModelUsageRows(todayByModel, overview.apiValueUSD)

  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-4 pt-3">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-[19px] font-bold tracking-tight text-[var(--text-primary)]">用量看板</h2>
          <p className="mt-1 text-[11px] text-[var(--text-secondary)]">订阅余量与个人用量均以服务端为准，本机统计单独标注</p>
        </div>
        <Button size="sm" variant="secondary" disabled={refreshingQuota} onClick={handleRefreshQuota}>
          <RefreshCw size={13} className={cn(refreshingQuota && 'animate-spin')} />{t('account.refresh')}
        </Button>
      </div>

      <StatusPill />
      <NotificationBanner />

      {cardUnusable && (
        <div className="rounded-[12px] border border-[var(--danger)] bg-[var(--danger)]/5 px-4 py-3">
          <div className="text-sm font-medium text-[var(--danger)]">{t('dashboard.cardUnusableTitle')}</div>
          <div className="mt-1 text-[12px] text-[var(--text-secondary)]">{t('dashboard.cardUnusableBody')}</div>
          <div className="mt-1.5 text-[12px] text-[var(--text-muted)]">{t('dashboard.cardUnusableHelp')}</div>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => api.openURL(api.PORTAL_URLS.billing)}>{t('dashboard.cardUnusableBilling')}</Button>
            <Button size="sm" variant="secondary" onClick={() => api.openURL(api.PORTAL_URLS.tickets)}>{t('dashboard.cardUnusableContact')}</Button>
            <Button size="sm" variant="ghost" onClick={() => useAppStore.getState().logout()}>{t('dashboard.cardUnusableRelogin')}</Button>
          </div>
        </div>
      )}

      <section className="overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-card)]">
        <div className="grid grid-cols-[1.35fr_.85fr]">
          <div className="border-r border-[var(--border-light)] px-5 py-5">
            <p className="text-[10px] font-medium text-[var(--text-muted)]">个人今日总 Token · 服务端</p>
            <div className="mt-1 font-mono-data text-[30px] font-bold tracking-[-0.04em] text-[var(--text-primary)]">{formatTokens(overview.totalTokens)}</div>
            <div className="mt-4 grid grid-cols-3 gap-5 border-t border-[var(--border-light)] pt-4">
              <Stat label="成功调用" value={overview.successfulCalls.toLocaleString()} />
              <Stat label="错误 / 错误率" value={`${overview.errors.toLocaleString()} · ${formatRatio(overview.errorRate)}`} tone={overview.errors > 0 ? 'danger' : undefined} />
              <Stat label="缓存读 / 写" value={`${formatTokens(todayCachedTokens)} / ${formatTokens(todayCacheWriteTokens)}`} />
            </div>
          </div>
          <div className="grid grid-rows-2 divide-y divide-[var(--border-light)]">
            <div className="px-5 py-4">
              <p className="text-[10px] text-[var(--text-muted)]">今日 API 等价价值</p>
              <p className="mt-1 font-mono-data text-[22px] font-bold text-[var(--primary-strong)]">{formatUSD(overview.apiValueUSD)}</p>
              <p className="mt-1 text-[9px] text-[var(--text-muted)]">按模型、上下文档位、缓存读写和 Priority 官方价格折算</p>
            </div>
            <div className="px-5 py-4">
              <p className="text-[10px] text-[var(--text-muted)]">累计 API 等价价值</p>
              <p className="mt-1 font-mono-data text-[22px] font-bold text-[var(--text-primary)]">{formatUSD(overview.cumulativeApiValueUSD)}</p>
              <p className="mt-1 text-[9px] text-[var(--text-muted)]">从首次服务端计量起，按 CardUsageHourly 累计</p>
            </div>
          </div>
        </div>
      </section>

      <section className="flex items-center justify-between gap-6 rounded-[12px] border border-[var(--border-light)] bg-[var(--bg-card)] px-4 py-3">
        <div>
          <p className="text-[11px] font-semibold text-[var(--text-primary)]">本机用量</p>
          <p className="mt-0.5 text-[9px] text-[var(--text-muted)]">仅当前登录用户在此设备上的调用，不参与服务端额度扣减</p>
        </div>
        <div className="flex shrink-0 gap-8 text-right">
          <Stat label="本机今日 Token" value={formatTokens(localTodayTokens)} />
          <Stat label="本机今日 API 等价价值" value={formatUSD(localTodayApiValueUSD)} />
        </div>
      </section>

      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <div>
            <CardTitle><BarChart3 size={15} />{t('dashboard.usageTitle')}</CardTitle>
            <p className="mt-0.5 text-[10px] text-[var(--text-muted)]">显示你的订阅 5 小时与每周剩余比例</p>
          </div>
        </CardHeader>
        <CardContent>
          {hasSubscriptions ? (
            <SubscriptionUsageCarousel subscriptions={account!.subscriptions} />
          ) : (
            <div className="py-1 text-[12px] text-[var(--text-muted)]">{t('dashboard.noUsageData')}</div>
          )}
        </CardContent>
      </Card>

      <UsageTrendChart />

      <Card className="overflow-hidden">
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <div><CardTitle><BarChart3 size={15} />今日模型明细</CardTitle><p className="mt-0.5 text-[10px] text-[var(--text-muted)]">输入、输出、缓存、Priority 与计价质量完整保留</p></div>
          <div className="text-[10px] text-[var(--text-muted)]">服务端汇总 · API 等价价值（含缓存）</div>
        </CardHeader>
        <CardContent className="p-0"><ModelUsageTable rows={modelUsageRows} /></CardContent>
      </Card>

      <PromoCard />

      <div className="flex items-center gap-2 px-1 pb-2 font-mono-data text-[9px] text-[var(--text-muted)]">
        <span>{t('dashboard.footActive')}: {accountId ? `#${accountId}` : t('common.none')}</span><span>·</span>
        <span>{t('dashboard.footToken')}: {autoLeaseRunning ? (hasToken ? t('dashboard.footTokenOk') : t('dashboard.footTokenFetching')) : t('dashboard.footTokenIdle')}</span>
        {leaserError && <><span>·</span><span className="max-w-[280px] truncate text-[var(--danger)]">{leaserError}</span></>}
      </div>
    </div>
  )
}
