import { useAppStore } from '@/stores/useAppStore'
import { StatusPill } from '@/components/StatusPill'
import { NotificationBanner } from '@/components/NotificationBanner'
import { UsageBar } from '@/components/UsageBar'
import { NestedShareBar } from '@/components/NestedShareBar'
import { PromoCard } from '@/components/PromoCard'
import { TokenSourceControl } from '@/components/TokenSourceControl'
import { SubscriptionUsageCarousel } from '@/components/SubscriptionUsageCarousel'
import { UsageTrendChart } from '@/components/UsageTrendChart'
import { ProviderLogo } from '@/components/ProviderLogo'
import { usageBarsForProducts } from '@/lib/usageBars'
import { buildQuotaSections, shouldUseExclusiveDisplay, type QuotaDisplayBar } from '@/lib/quotaDisplay'
import { buildModelUsageRows, buildUsageOverview, type ModelUsageRow } from '@/lib/usageSummary'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import * as api from '@/services/wails'
import { cn, formatTokens } from '@/lib/utils'
import { useT } from '@/i18n'
import { BarChart3, Crown } from 'lucide-react'

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
    <div className="px-4 py-3">
      <div
        className={cn(
          'text-[20px] font-bold font-mono-data tracking-tight tabular-nums',
          tone === 'primary' ? 'text-[var(--primary)]'
            : tone === 'danger' ? 'text-[var(--danger)]'
            : 'text-[var(--text-primary)]',
        )}
      >
        {value}
      </div>
      <div className="text-[11px] text-[var(--text-muted)] mt-0.5">{label}</div>
      {caption && <div className="text-[10px] text-[var(--text-muted)] mt-0.5 leading-snug">{caption}</div>}
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
            <th className="text-right">官方 API 价估算</th>
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
              <td className="px-3 py-2.5 text-right font-mono-data tabular-nums text-[var(--text-primary)]">{formatUSD(row.estimatedCostUSD)}</td>
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
  } = useAppStore()

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
  // 独享卡:整号 100% 归你。展示「尊贵 · 独享」标识。优先用后端权威 cardExclusive;
  // 缺省(旧服务端)回退到 weight>=capacity 启发式。
  const exclusiveCard = shouldUseExclusiveDisplay({ cardWeight: cardShareSeats, cardShareCapacity, exclusive: cardExclusive, accountProblem })

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
    <div className="max-w-[960px] flex flex-col gap-4">
      {/* ── 状态 ── */}
      <StatusPill />
      <NotificationBanner />

      {/* 会话/订阅已失效(SESSION_INVALID / SUBSCRIPTION_EXPIRED 等):
          引导重新登录(登出 → 自动回登录页)或前往网页端处理订阅与账单 */}
      {cardUnusable && (
        <div className="rounded-[12px] border border-[var(--danger)] bg-[var(--danger)]/5 px-4 py-3">
          <div className="text-sm font-medium text-[var(--danger)]">{t('dashboard.cardUnusableTitle')}</div>
          <div className="text-[12px] text-[var(--text-secondary)] mt-1">{t('dashboard.cardUnusableBody')}</div>
          <div className="text-[12px] text-[var(--text-muted)] mt-1.5">{t('dashboard.cardUnusableHelp')}</div>
          <div className="flex flex-wrap items-center gap-2 mt-2.5">
            <Button size="sm" onClick={() => api.openURL(api.PORTAL_URLS.billing)}>
              {t('dashboard.cardUnusableBilling')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => api.openURL(api.PORTAL_URLS.tickets)}>
              {t('dashboard.cardUnusableContact')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => useAppStore.getState().logout()}>
              {t('dashboard.cardUnusableRelogin')}
            </Button>
          </div>
        </div>
      )}

      {/* ── 今日概览:总Token / API价值 / 成功·错误 / 累计价值 ── */}
      <Card className="overflow-hidden p-0">
        <div className="grid grid-cols-2 divide-x divide-y divide-[var(--border-light)] md:grid-cols-4 md:divide-y-0">
          <Stat
            label="今日总 Token"
            value={formatTokens(overview.totalTokens)}
            caption={`缓存读 ${formatTokens(todayCachedTokens)} / 写 ${formatTokens(todayCacheWriteTokens)}`}
            tone="primary"
          />
          <Stat label="官方 API 价估算" value={formatUSD(overview.apiValueUSD)} caption="按模型真实价格折算" />
          <Stat
            label="成功调用 / 错误"
            value={`${overview.successfulCalls.toLocaleString()} / ${overview.errors.toLocaleString()}`}
            caption={`错误率 ${formatRatio(overview.errorRate)}`}
            tone={overview.errors > 0 ? 'danger' : undefined}
          />
          <Stat label="累计 API 价值" value={formatUSD(overview.cumulativeApiValueUSD)} caption="按官方 API 价累计约" />
        </div>
      </Card>

      {/* ── 今日模型明细 ── */}
      <Card className="overflow-hidden">
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle><BarChart3 size={15} /> 今日模型明细</CardTitle>
          <div className="text-[11px] text-[var(--text-muted)]">本机实时 · 官方 API 价估算(含缓存)</div>
        </CardHeader>
        <CardContent className="p-0">
          <ModelUsageTable rows={modelUsageRows} />
        </CardContent>
      </Card>

      {/* ── 入口:两个广告,常驻显眼 ── */}
      <PromoCard />

      {/* ── 用量趋势 ── */}
      <UsageTrendChart />

      {/* ── 模型用量:每个服务商一栏(带品牌标识),顶部对齐 —— Antigravity / Codex / Anthropic。
          颜色随健康度变(充足绿/一般黄/紧张橙/已用尽红);只有部分服务商有数据时自动减少栏数。 ── */}
      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <CardTitle><BarChart3 size={15} /> {t('dashboard.usageTitle')}</CardTitle>
          {exclusiveCard && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold text-amber-500">
              <Crown size={11} /> 尊贵 · 独享
            </span>
          )}
        </CardHeader>
        <CardContent>
          {/* 绑定账号当前异常 → 明确提示,不让用户对着「充足」误判。 */}
          {accountProblem && (
            <div className="mb-3 rounded-[8px] border border-[var(--warning)] bg-[var(--warning)]/10 px-3 py-2 text-[11px] text-[var(--text-secondary)]">
              {t('dashboard.accountProblem', { error: leaserError })}
            </div>
          )}
          {account?.subscriptions && account.subscriptions.length > 0 ? (
            <SubscriptionUsageCarousel subscriptions={account.subscriptions} boundAccounts={boundAccounts} />
          ) : (() => {
            const PROVIDERS = [
              { id: 'antigravity', name: 'Antigravity' },
              { id: 'codex', name: 'Codex' },
              { id: 'anthropic', name: 'Anthropic' },
            ]
            const columns = PROVIDERS
              .map((p) => ({ ...p, sections: quotaSections.filter((section) => section.bucket.startsWith(p.id)) }))
              .filter((p) => p.sections.length > 0)

            if (columns.length === 0) {
              return <div className="text-[12px] text-[var(--text-muted)] py-1">{t('dashboard.noUsageData')}</div>
            }
            return (
              <div className="grid gap-3 items-start" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
                {columns.map((p) => (
                  <div key={p.id} className="rounded-[12px] border border-[var(--border-light)] p-3.5">
                    <div className="flex items-center gap-2 mb-2.5">
                      <ProviderLogo provider={p.id} />
                      <span className="text-[13px] font-semibold text-[var(--text-primary)]">{p.name}</span>
                    </div>
                    <div className="flex flex-col gap-3">
                      {p.sections.map((section) => (
                        <div key={section.bucket} className="flex flex-col gap-2.5">
                          <div className="text-[12px] font-semibold text-[var(--text-primary)]">{section.title}</div>
                          {section.mine.length > 0 ? (
                            // 双层血条:整号容量打底,叠「账号总剩余 + 我的总剩余」,按 5h/周 各一条。
                            <div className="flex flex-col divide-y divide-[var(--border-light)]">
                              {section.mine.map((myBar) => {
                                const acctBar = section.serviceAccount.find((b) => b.window === myBar.window)
                                const resetIdentity = typeof myBar.resetAt === 'number' && myBar.resetAt > Date.now() ? myBar.resetAt : undefined
                                return (
                                  <div key={myBar.window} className="py-2 first:pt-0.5 last:pb-0.5">
                                    <NestedShareBar
                                      label={myBar.label}
                                      myFraction={myBar.fraction}
                                      accountFraction={acctBar?.fraction ?? -1}
                                      shareSeats={cardShareSeats}
                                      shareCapacity={cardShareCapacity}
                                      exclusive={cardExclusive}
                                      resetMs={myBar.resetMs}
                                      displayKey={resetIdentity ? `${accountId}:${section.bucket}:${myBar.window}:${resetIdentity}` : undefined}
                                    />
                                  </div>
                                )
                              })}
                            </div>
                          ) : (
                            // 号池卡(无 fair-share 份额):只显示整号余量。
                            <div className="flex flex-col gap-1.5">
                              <div className="text-[11px] font-medium text-[var(--text-muted)]">当前服务账号</div>
                              <div className="flex flex-col divide-y divide-[var(--border-light)]">
                                {section.serviceAccount.map((bar) => (
                                  <div key={bar.window} className="py-2 first:pt-0.5 last:pb-0.5">{renderQuotaBar(bar)}</div>
                                ))}
                              </div>
                            </div>
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

      {/* ── 接管:整宽操作面板(生态自适应分列,加生态=加块)── */}
      <TokenSourceControl />

      {/* ── Footer: device info ── */}
      <div className="flex items-center gap-2 text-[11px] font-mono-data text-[var(--text-muted)] px-1 pb-2">
        <span>{t('dashboard.footActive')}: {accountId ? `#${accountId}` : t('common.none')}</span>
        <span className="text-[var(--border)]">·</span>
        <span>{t('dashboard.footToken')}: {autoLeaseRunning ? (hasToken ? t('dashboard.footTokenOk') : t('dashboard.footTokenFetching')) : t('dashboard.footTokenIdle')}</span>
        {leaserError && (
          <>
            <span className="text-[var(--border)]">·</span>
            <span className="text-[var(--danger)] truncate max-w-[280px]">{leaserError}</span>
          </>
        )}
      </div>
    </div>
  )
}
