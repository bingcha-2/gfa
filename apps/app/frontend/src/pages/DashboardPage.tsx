import { useAppStore } from '@/stores/useAppStore'
import { StatusPill } from '@/components/StatusPill'
import { NotificationBanner } from '@/components/NotificationBanner'
import { UsageBar } from '@/components/UsageBar'
import { NestedShareBar } from '@/components/NestedShareBar'
import { PromoCard } from '@/components/PromoCard'
import { SubscriptionUsageCarousel } from '@/components/SubscriptionUsageCarousel'
import { ExclusiveBadge } from '@/components/ExclusiveBadge'
import { UsageTrendChart } from '@/components/UsageTrendChart'
import { ProviderLogo } from '@/components/ProviderLogo'
import { usageBarsForProducts } from '@/lib/usageBars'
import { buildQuotaSections, shouldUseExclusiveDisplay, type QuotaDisplayBar } from '@/lib/quotaDisplay'
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
    account, boundAccounts,
    leaserError, hasToken, autoLeaseRunning, accountId, cardUnusable, cardProducts, entitledProducts,
    accountFractions, accountResetMs, accountResetAt, myFractions, myResetMs, myResetAt, myShares, myWeeklyFractions, myWeeklyResetMs, myWeeklyResetAt,
    cardBuckets, cardWeeklyBuckets, cardShareSeats, cardShareCapacity, cardExclusive,
    codexQuota, claudeQuota,
    todayRequests, todayErrors, todayInputTokens, todayOutputTokens,
    todayCacheWriteTokens, todayCachedTokens, todayApiValueUSD, todayByModel, cumulativeSaving,
    fetchStats,
  } = useAppStore()

  // 就地刷新远端额度:GetStats 只读缓存快照,故先主动去上游强制拉一次最新余量(并上报服务端),
  // 再 fetchStats 才能看到新值并重渲染血条。上游刷新失败不致命,照常刷新本地状态。
  const [refreshingQuota, setRefreshingQuota] = useState(false)
  const handleRefreshQuota = async () => {
    if (refreshingQuota) return
    setRefreshingQuota(true)
    try {
      try {
        await api.refreshQuota()
      } catch (err) {
        console.error('refreshQuota failed:', err)
      }
      await fetchStats()
    } finally {
      setRefreshingQuota(false)
    }
  }

  // 显示「每个已订阅产品」一张用量卡:优先用订阅授权并集(跨所有生效订阅,故 codex+anthropic
  // 都显示);冷启动授权未知时回退到单卡 products(保持现有行为,不空屏)。
  // 注:同产品多订阅(如两个 anthropic)在客户端按产品键控会塌成一张卡 —— 那是更深的架构限制。
  const visibleBars = usageBarsForProducts(entitledProducts.length ? entitledProducts : cardProducts)
  // 绑定账号当前不可用(租号报错且非致命):额度数据不可信 → 血条显示「未知」+ 顶部提示,
  // 绝不把陈旧的「充足 100%」当真。lastError 在成功租号时会被清空,所以它=当前确有问题。
  // 仅对开通了 antigravity 的卡(opus/gemini 血条可见)成立 —— codex-only 卡不跑 antigravity,
  // 不该弹 antigravity 的账号异常提示。与后端"按 products 决定是否租号"是同一套逻辑。
  const isQuotaLikeError = /quota|limit|公平|额度|恢复|retry-after|token limit/i.test(leaserError)
  const accountProblem = !!leaserError && !cardUnusable && visibleBars.some((b) => b.family === 'claude') && !isQuotaLikeError
  // 多订阅时逐订阅走 carousel,每张卡自带「尊贵 · 独享」badge(跟 quota.exclusive,混档如实标注);
  // 顶部账户级 badge 仅在无订阅回退(单卡视图)时展示,避免用单卡口径误标整个账户。
  const hasSubscriptions = !!(account?.subscriptions && account.subscriptions.length > 0)
  // 独享卡:整号 100% 归你。展示「尊贵 · 独享」标识。优先用后端权威 cardExclusive;
  // 缺省(旧服务端)回退到 weight>=capacity 启发式。
  const exclusiveCard = !hasSubscriptions && shouldUseExclusiveDisplay({ cardWeight: cardShareSeats, cardShareCapacity, exclusive: cardExclusive, accountProblem })

  // 独享订阅(weight≥号总份数,即就你一个人用整个号):此时「号余量」就是「你的卡额度」,
  // 把号余量条映射成卡额度真实数值/窗口,而不是只给一个 fair-share 百分比。
  // 去席位:标题只用「产品 · 模型」,不再显示「X/Y 席」。份额几何由 myShares(e_i)承载。
  const quotaSections = buildQuotaSections({
    bars: visibleBars.map((bar) => ({ ...bar })),
    cardBuckets,
    cardWeeklyBuckets,
    myFractions,
    myResetMs,
    myResetAt,
    myWeeklyFractions,
    myWeeklyResetMs,
    myWeeklyResetAt,
    myShares,
    accountFractions,
    accountResetMs,
    accountResetAt,
    codexQuota,
    claudeQuota,
    accountProblem,
  })

  const renderQuotaBar = (bar: QuotaDisplayBar) => (
    <UsageBar
      key={`${bar.window}-${bar.label}`}
      label={bar.label}
      used={bar.hideValues ? null : (bar.used ?? null)}
      limit={bar.hideValues ? null : (bar.limit ?? null)}
      fraction={bar.fraction}
      resetMs={bar.resetMs}
    />
  )

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
          <p className="mt-1 text-[11px] text-[var(--text-secondary)]">订阅余量、本机调用和 API 等价价值放在同一视图</p>
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
            <p className="text-[10px] font-medium text-[var(--text-muted)]">今日总 Token</p>
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
              <p className="mt-1 text-[9px] text-[var(--text-muted)]">从首次使用起，按官方 API 定价累计</p>
            </div>
          </div>
        </div>
      </section>

      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <div>
            <CardTitle><BarChart3 size={15} />{t('dashboard.usageTitle')}</CardTitle>
            <p className="mt-0.5 text-[10px] text-[var(--text-muted)]">5h 与周窗口分别计算；“我的剩余”始终受母号当前剩余约束</p>
          </div>
          {exclusiveCard && <ExclusiveBadge />}
        </CardHeader>
        <CardContent>
          {accountProblem && <div className="mb-3 rounded-[8px] border border-[var(--warning)] bg-[var(--warning)]/10 px-3 py-2 text-[11px] text-[var(--text-secondary)]">{t('dashboard.accountProblem', { error: leaserError })}</div>}
          {hasSubscriptions ? (
            <SubscriptionUsageCarousel subscriptions={account!.subscriptions} boundAccounts={boundAccounts} />
          ) : (() => {
            const providers = [
              { id: 'antigravity', name: 'Antigravity' },
              { id: 'codex', name: 'Codex' },
              { id: 'anthropic', name: 'Anthropic' },
            ]
            const columns = providers.map((provider) => ({ ...provider, sections: quotaSections.filter((section) => section.bucket.startsWith(provider.id)) })).filter((provider) => provider.sections.length > 0)
            if (columns.length === 0) return <div className="py-1 text-[12px] text-[var(--text-muted)]">{t('dashboard.noUsageData')}</div>
            return (
              <div className="grid items-start gap-3" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
                {columns.map((provider) => (
                  <div key={provider.id} className="rounded-[12px] border border-[var(--border-light)] p-3.5">
                    <div className="mb-2.5 flex items-center gap-2"><ProviderLogo provider={provider.id} /><span className="text-[13px] font-semibold text-[var(--text-primary)]">{provider.name}</span></div>
                    <div className="flex flex-col gap-3">
                      {provider.sections.map((section) => (
                        <div key={section.bucket} className="flex flex-col gap-2.5">
                          <div className="text-[12px] font-semibold text-[var(--text-primary)]">{section.title}</div>
                          {section.mine.length > 0 ? (
                            <div className="flex flex-col divide-y divide-[var(--border-light)]">
                              {section.mine.map((myBar) => {
                                const accountBar = section.serviceAccount.find((bar) => bar.window === myBar.window)
                                const resetIdentity = typeof myBar.resetAt === 'number' && myBar.resetAt > Date.now() ? myBar.resetAt : undefined
                                return <div key={myBar.window} className="py-2 first:pt-0.5 last:pb-0.5"><NestedShareBar label={myBar.label} myFraction={myBar.fraction} accountFraction={accountBar?.fraction ?? -1} shareSeats={cardShareSeats} shareCapacity={cardShareCapacity} exclusive={cardExclusive} resetMs={myBar.resetMs} displayKey={resetIdentity ? `${accountId}:${section.bucket}:${myBar.window}:${resetIdentity}` : undefined} /></div>
                              })}
                            </div>
                          ) : (
                            <div className="flex flex-col gap-1.5"><div className="text-[11px] font-medium text-[var(--text-muted)]">当前服务账号</div><div className="flex flex-col divide-y divide-[var(--border-light)]">{section.serviceAccount.map((bar) => <div key={bar.window} className="py-2 first:pt-0.5 last:pb-0.5">{renderQuotaBar(bar)}</div>)}</div></div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )
          })()}
        </CardContent>
      </Card>

      <UsageTrendChart />

      <Card className="overflow-hidden">
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <div><CardTitle><BarChart3 size={15} />今日模型明细</CardTitle><p className="mt-0.5 text-[10px] text-[var(--text-muted)]">输入、输出、缓存、Priority 与计价质量完整保留</p></div>
          <div className="text-[10px] text-[var(--text-muted)]">本机实时 · API 等价价值（含缓存）</div>
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
