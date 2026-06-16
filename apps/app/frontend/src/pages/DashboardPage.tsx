import type { ReactNode } from 'react'
import { useAppStore } from '@/stores/useAppStore'
import { StatusPill } from '@/components/StatusPill'
import { NotificationBanner } from '@/components/NotificationBanner'
import { UsageBar } from '@/components/UsageBar'
import { PromoCard } from '@/components/PromoCard'
import { TokenSourceControl } from '@/components/TokenSourceControl'
import { BoundAccountsCard } from '@/components/BoundAccountsCard'
import { UsageTrendChart } from '@/components/UsageTrendChart'
import { ProviderLogo } from '@/components/ProviderLogo'
import { usageBarsForProducts, type BarSpec } from '@/lib/usageBars'
import { cardScopeFiveHour, cardScopeWeekly, shouldUseExclusiveDisplay } from '@/lib/quotaDisplay'
import { buildModelUsageRows, buildUsageOverview, type ModelUsageRow } from '@/lib/usageSummary'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import * as api from '@/services/wails'
import { cn, formatTokens } from '@/lib/utils'
import { useT } from '@/i18n'
import { BarChart3 } from 'lucide-react'

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
    leaserError, hasToken, autoLeaseRunning, accountId, cardUnusable, cardProducts,
    accountFractions, accountResetMs, myFractions, myResetMs, myWeeklyFractions, myWeeklyResetMs, quotaMode,
    cardBuckets, cardWeeklyBuckets, cardWeight, cardShareCapacity,
    codexQuota, claudeQuota,
    todayRequests, todayErrors, todayInputTokens, todayOutputTokens,
    todayCacheWriteTokens, todayCachedTokens, todayApiValueUSD, todayByModel, cumulativeSaving,
  } = useAppStore()

  // 绑定卡只显示它绑了的产品的用量条;池子卡(无 products)三条都显示。
  const visibleBars = usageBarsForProducts(cardProducts)
  // 绑定账号当前不可用(租号报错且非致命):额度数据不可信 → 血条显示「未知」+ 顶部提示,
  // 绝不把陈旧的「充足 100%」当真。lastError 在成功租号时会被清空,所以它=当前确有问题。
  // 仅对开通了 antigravity 的卡(opus/gemini 血条可见)成立 —— codex-only 卡不跑 antigravity,
  // 不该弹 antigravity 的账号异常提示。与后端"按 products 决定是否租号"是同一套逻辑。
  const isQuotaLikeError = /quota|limit|公平|额度|恢复|retry-after|token limit/i.test(leaserError)
  const accountProblem = !!leaserError && !cardUnusable && visibleBars.some((b) => b.family === 'claude') && !isQuotaLikeError

  // 独享订阅(weight≥号总份数,即就你一个人用整个号):此时「号余量」就是「你的卡额度」,
  // 把号余量条映射成卡额度真实数值/窗口,而不是只给一个 fair-share 百分比。
  const useExclusiveDisplay = shouldUseExclusiveDisplay({ cardWeight, cardShareCapacity, accountProblem })
  const cardScopeInput = {
    cardBuckets, cardWeeklyBuckets, myFractions, myResetMs, myWeeklyFractions, myWeeklyResetMs,
  }

  // 「我的卡」条:这张卡自己的剩余额度(独立于整个号)。
  //  • static 卡:本地 bucketLimits 剩余(localQuota 家族字段),可展开看 token 数。
  //  • 绑定卡:fair-share 份额(myFractions),只给 %。
  //  • 无独立额度(无限号池卡)→ null,降级单条。
  // 返回「我的卡」条数组(0~2 条):static 卡单条;绑定卡的 fair-share 份额在有周数据时
  // 出 5h + 周 双条(与账号侧 5h/周 双条对称),否则单条。
  const renderMyCardBar = (bar: BarSpec): ReactNode[] => {
    if (quotaMode === 'static') {
      // 用服务端 buckets 真相(复合桶精确),不用本地 localQuota——后者不含 claude/codex
      // 走独立 leaser 的用量,会假报「已用 0 · 充足」。
      const b = cardBuckets?.[bar.bucket]
      const limit = b?.limit ?? 0
      if (!limit || limit <= 0) return []
      const used = b?.used ?? 0
      const frac = Math.max(0, Math.min(1, (limit - used) / limit))
      // 5h 条用该卡 5h 窗口自身的 reset(cardBuckets.resetMs),不再借 recoveryRemainingMs —— 后者是
      // 账号级「更紧窗口」的恢复时间,周窗口更空时会变成 7d 的 reset,导致 5h 条显示成 7d。
      const fiveHReset = b?.resetMs && b.resetMs > 0 ? b.resetMs : undefined
      // static 卡封顶条:有周上限(显式或派生 5h×R)时 → 5h + 周 双条,否则单条。
      const staticBar = (key: string, suffix: string, u: number, lim: number, resetMs?: number) => (
        <UsageBar key={key} label={`${t('dashboard.myCard')} · ${suffix}`} used={u} limit={lim}
          fraction={accountProblem ? -1 : Math.max(0, Math.min(1, (lim - u) / lim))}
          resetMs={resetMs} />
      )
      const wk = cardWeeklyBuckets?.[bar.bucket]
      if (wk && wk.limit > 0) {
        return [staticBar('mine-5h', '5h', used, limit, fiveHReset),
                staticBar('mine-7d', '7d', wk.used ?? 0, wk.limit, wk.resetMs)]
      }
      return [(
        <UsageBar key="mine" label={t('dashboard.myCard')} used={used} limit={limit}
          fraction={accountProblem ? -1 : frac}
          resetMs={fiveHReset} />
      )]
    }
    const myFrac = myFractions?.[bar.bucket]
    if (myFrac == null) return []
    // 份额条:label 复用 myCardShare,加语言中性窗口后缀(5h / 7d)区分两条。
    const shareBar = (key: string, suffix: string, frac: number, resetMs?: number) => {
      return (
        <UsageBar key={key} label={`${t('dashboard.myCardShare')} · ${suffix}`} used={null} limit={null}
          fraction={accountProblem ? -1 : frac} resetMs={resetMs} />
      )
    }
    const wk = myWeeklyFractions?.[bar.bucket]
    if (wk != null) {
      // 5h + 周 双条。
      return [shareBar('mine-5h', '5h', myFrac, myResetMs?.[bar.bucket]),
              shareBar('mine-7d', '7d', wk, myWeeklyResetMs?.[bar.bucket])]
    }
    // 无周数据(antigravity 或旧服务端)→ 保持原单条,标签不变。
    return [(
      <UsageBar key="mine" label={t('dashboard.myCardShare')} used={null} limit={null}
        fraction={accountProblem ? -1 : myFrac} resetMs={myResetMs?.[bar.bucket]} />
    )]
  }

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
        <CardHeader><CardTitle><BarChart3 size={15} /> {t('dashboard.usageTitle')}</CardTitle></CardHeader>
        <CardContent>
          {/* 绑定账号当前异常 → 明确提示,不让用户对着「充足」误判。 */}
          {accountProblem && (
            <div className="mb-3 rounded-[8px] border border-[var(--warning)] bg-[var(--warning)]/10 px-3 py-2 text-[11px] text-[var(--text-secondary)]">
              {t('dashboard.accountProblem', { error: leaserError })}
            </div>
          )}
          {(() => {
            // 一个模型家族的余量行:号余量(单条 / 5h+周 双条)+「我的卡」。
            // 远程/绑定模式无 bucket 数据 / 账号异常 → fraction=-1 显示「未知」,
            // 不回退本地 used/limit(本地不限额恒为「充足 100%」,会假报满血)。
            const modelRows = (bar: BarSpec) => {
              const myBars = renderMyCardBar(bar)
              const accountBars = (() => {
                // 独享订阅:号余量条直接映射成卡额度(真实数值/窗口),而非 fair-share %。
                if (useExclusiveDisplay) {
                  const fiveHour = cardScopeFiveHour(bar.bucket, cardScopeInput)
                  if (bar.family === 'gpt' || bar.bucket === 'anthropic-claude') {
                    const weekly = cardScopeWeekly(bar.bucket, cardScopeInput)
                    return [
                      <UsageBar key="acct-5h" label={t('dashboard.acct5h')} used={null} limit={null}
                        fraction={fiveHour.fraction} resetMs={fiveHour.resetMs} />,
                      <UsageBar key="acct-week" label={t('dashboard.acctWeek')} used={null} limit={null}
                        fraction={weekly.fraction} resetMs={weekly.resetMs} />,
                    ]
                  }
                  return [
                    <UsageBar key="acct" label={t('dashboard.acctRemaining')} used={null} limit={null}
                      fraction={fiveHour.fraction} resetMs={fiveHour.resetMs} />,
                  ]
                }
                // codex / anthropic-claude 是账号级 5h + 周 双窗口;antigravity 的 Claude 单条号余量。
                const split =
                  bar.family === 'gpt' && codexQuota && !accountProblem ? codexQuota :
                  bar.bucket === 'anthropic-claude' && claudeQuota && !accountProblem ? claudeQuota : null
                return split ? [
                  <UsageBar key="acct-5h" label={t('dashboard.acct5h')} used={null} limit={null}
                    fraction={split.hourlyFraction} resetMs={split.hourlyResetMs} />,
                  <UsageBar key="acct-week" label={t('dashboard.acctWeek')} used={null} limit={null}
                    fraction={split.weeklyFraction} resetMs={split.weeklyResetMs} />,
                ] : [
                  <UsageBar key="acct" label={t('dashboard.acctRemaining')} used={null} limit={null}
                    fraction={accountProblem ? -1 : (accountFractions?.[bar.bucket] ?? -1)}
                    resetMs={accountResetMs?.[bar.bucket]} />,
                ]
              })()
              return [...accountBars, ...myBars].filter(Boolean)
            }

            // 按服务商分栏:Antigravity / Codex / Anthropic,各自一个带品牌标识的描边面板;
            // 只渲染有数据的服务商,顶部对齐。
            const PROVIDERS = [
              { id: 'antigravity', name: 'Antigravity' },
              { id: 'codex', name: 'Codex' },
              { id: 'anthropic', name: 'Anthropic' },
            ]
            const columns = PROVIDERS
              .map((p) => ({ ...p, bars: visibleBars.filter((b) => b.bucket.startsWith(p.id)) }))
              .filter((p) => p.bars.length > 0)

            if (columns.length === 0) {
              return <div className="text-[12px] text-[var(--text-muted)] py-1">{t('dashboard.noUsageData')}</div>
            }
            return (
              <div className="grid gap-3 items-start" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
                {columns.map((p) => {
                  const multiModel = p.bars.length > 1
                  return (
                    <div key={p.id} className="rounded-[12px] border border-[var(--border-light)] p-3.5">
                      <div className="flex items-center gap-2 mb-2.5">
                        <ProviderLogo provider={p.id} />
                        <span className="text-[13px] font-semibold text-[var(--text-primary)]">{p.name}</span>
                      </div>
                      <div className="flex flex-col gap-3">
                        {p.bars.map((bar) => (
                          <div key={bar.bucket}>
                            {multiModel && (
                              <div className="text-[11px] font-medium text-[var(--text-muted)] mb-0.5">{bar.label.split(' · ')[1] || bar.label}</div>
                            )}
                            <div className="flex flex-col divide-y divide-[var(--border-light)]">
                              {modelRows(bar).map((row, i) => (
                                <div key={i} className="py-2 first:pt-0.5 last:pb-0.5">{row}</div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })()}
        </CardContent>
      </Card>

      {/* ── 接管:整宽操作面板(生态自适应分列,加生态=加块)── */}
      <TokenSourceControl />

      {/* ── 绑定账号信息(仅绑定卡 + 远程模式显示)── */}
      <BoundAccountsCard />

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
