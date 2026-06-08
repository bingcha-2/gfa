import { useState } from 'react'
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
import { Modal, useModal } from '@/components/Modal'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import * as api from '@/services/wails'
import { cn, formatTokens, maskCard, formatDate } from '@/lib/utils'
import { Key, BarChart3 } from 'lucide-react'

/** 顶部「今日概览」里的一格统计。数字大、标签小,克制单色,只有关键项点琥珀。 */
function Stat({ label, value, tone }: { label: string; value: string; tone?: 'primary' | 'danger' }) {
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
    </div>
  )
}

export function DashboardPage() {
  const {
    config, leaserError, hasToken, autoLeaseRunning, accountId, cardUnusable, cardProducts,
    accountFractions, accountResetMs, myFractions, myResetMs, quotaMode, recoveryRemainingMs,
    cardWeight, cardShareCapacity, cardBuckets,
    codexQuota, claudeQuota,
    activationExpiresAt, todayRequests, todayErrors, todayInputTokens, todayOutputTokens,
    todayBillableTokens, todayCacheWriteTokens, todayCachedTokens, cumulativeSaving,
  } = useAppStore()

  // 绑定卡只显示它绑了的产品的用量条;池子卡(无 products)三条都显示。
  const visibleBars = usageBarsForProducts(cardProducts)
  // 绑定账号当前不可用(租号报错且非致命):额度数据不可信 → 血条显示「未知」+ 顶部提示,
  // 绝不把陈旧的「充足 100%」当真。lastError 在成功租号时会被清空,所以它=当前确有问题。
  // 仅对开通了 antigravity 的卡(opus/gemini 血条可见)成立 —— codex-only 卡不跑 antigravity,
  // 不该弹 antigravity 的账号异常提示。与后端"按 products 决定是否租号"是同一套逻辑。
  const accountProblem = !!leaserError && !cardUnusable && visibleBars.some((b) => b.family === 'claude')

  // 「我的卡」条:这张卡自己的剩余额度(独立于整个号)。
  //  • static 卡:本地 bucketLimits 剩余(localQuota 家族字段),可展开看 token 数。
  //  • 绑定卡:fair-share 份额(myFractions),只给 %。
  //  • 无独立额度(无限号池卡)→ null,降级单条。
  const renderMyCardBar = (bar: BarSpec) => {
    if (quotaMode === 'static') {
      // 用服务端 buckets 真相(复合桶精确),不用本地 localQuota——后者不含 claude/codex
      // 走独立 leaser 的用量,会假报「已用 0 · 充足」。
      const b = cardBuckets?.[bar.bucket]
      const limit = b?.limit ?? 0
      if (!limit || limit <= 0) return null
      const used = b?.used ?? 0
      const frac = Math.max(0, Math.min(1, (limit - used) / limit))
      return (
        <UsageBar key="mine" label="我的卡" used={used} limit={limit}
          fraction={accountProblem ? -1 : frac}
          resetMs={recoveryRemainingMs > 0 ? recoveryRemainingMs : undefined}
          expandable
          detail={`已用 ${formatTokens(used)} / 上限 ${formatTokens(limit)}`} />
      )
    }
    const myFrac = myFractions?.[bar.bucket]
    if (myFrac != null) {
      const pct = Math.round(Math.max(0, Math.min(1, myFrac)) * 100)
      return (
        <UsageBar key="mine" label="我的卡 · 份额" used={null} limit={null}
          fraction={accountProblem ? -1 : myFrac} resetMs={myResetMs?.[bar.bucket]}
          expandable
          detail={`份额 ${cardWeight}/${cardShareCapacity} · 本期剩 ${pct}%`} />
      )
    }
    return null
  }

  const { modalProps, showAlert } = useModal()

  const [cardInput, setCardInput] = useState('')
  const [activating, setActivating] = useState(false)
  const [changing, setChanging] = useState(false)
  const handleActivateCard = async (): Promise<boolean> => {
    if (!cardInput.trim()) { await showAlert('提示', '请输入账号卡号！'); return false }
    setActivating(true)
    try {
      const result = await useAppStore.getState().activateCard(cardInput.trim())
      await showAlert('激活成功', `有效期至: ${formatDate(result)}`); setCardInput('')
      return true
    } catch (err) { await showAlert('激活失败', `${err}`); return false }
    finally { setActivating(false) }
  }

  const activated = !!config?.accountCard
  const statusBadge = activated
    ? (autoLeaseRunning ? (hasToken ? '令牌正常' : '获取中') : '闲置')
    : '未激活'

  return (
    <div className="max-w-[960px] flex flex-col gap-4">
      {/* ── 状态 ── */}
      <StatusPill />
      <NotificationBanner />

      {/* 无可用卡密:停止租号、功能不可用,只能重新激活或退出接管 */}
      {cardUnusable && (
        <div className="rounded-[12px] border border-[var(--danger)] bg-[var(--danger)]/5 px-4 py-3">
          <div className="text-sm font-medium text-[var(--danger)]">卡密不可用,功能已停用</div>
          <div className="text-[12px] text-[var(--text-secondary)] mt-1">
            当前账号卡已失效(无效/过期/禁用)。请在下方<strong>重新激活有效卡密</strong>;或在「接管」面板<strong>退出接管</strong>,恢复 IDE / Codex 正常使用。
          </div>
        </div>
      )}

      {/* ── 账号卡:未激活 → 突出引导;已激活 → 紧凑条(可内联更换)── */}
      {!activated ? (
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-1.5">
            <Key size={16} className="text-[var(--primary)]" />
            <span className="text-[15px] font-bold text-[var(--text-primary)]">激活账号卡</span>
          </div>
          <p className="text-[12px] text-[var(--text-secondary)] leading-relaxed mb-3 max-w-[64ch]">
            输入卡密即可直连官方模型 —— 无需配置 API Key,代码数据直发官方,冰茶只在本地注入授权令牌。
          </p>
          <div className="flex gap-2">
            <Input value={cardInput} onChange={(e) => setCardInput(e.target.value)}
              placeholder="输入账号卡 (AI...)" className="flex-1 h-10"
              onKeyDown={(e) => { if (e.key === 'Enter') handleActivateCard() }} />
            <Button onClick={() => handleActivateCard()} disabled={activating} className="h-10 px-6 shrink-0">
              {activating ? '激活中...' : '验证激活'}
            </Button>
          </div>
          <button
            onClick={() => api.openURL('https://bcai.store')}
            className="mt-2.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--primary-strong)] transition-colors"
          >
            还没有卡密?前往冰茶商店购买 ↗
          </button>
        </Card>
      ) : (
        <Card className="px-4 py-3 flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="flex h-8 w-8 items-center justify-center rounded-[8px] bg-[var(--bg-tertiary)] text-[var(--primary)] shrink-0">
                <Key size={15} />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-mono-data text-[var(--text-primary)]">{maskCard(config!.accountCard)}</span>
                  <Badge variant={hasToken ? 'success' : 'default'}>{statusBadge}</Badge>
                </div>
                <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
                  到期 {activationExpiresAt && !isNaN(new Date(activationExpiresAt).getTime()) ? formatDate(activationExpiresAt) : '—'}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Button size="sm" variant="ghost" onClick={() => navigator.clipboard.writeText(config!.accountCard)}>复制</Button>
              <Button size="sm" variant="secondary" onClick={() => { setChanging((v) => !v); setCardInput('') }}>
                {changing ? '取消' : '更换'}
              </Button>
            </div>
          </div>
          {changing && (
            <div className="flex gap-2 pt-0.5">
              <Input value={cardInput} onChange={(e) => setCardInput(e.target.value)}
                placeholder="输入新账号卡以更换" className="flex-1 h-9"
                onKeyDown={(e) => { if (e.key === 'Enter') handleActivateCard().then((ok) => ok && setChanging(false)) }} />
              <Button onClick={() => handleActivateCard().then((ok) => ok && setChanging(false))} disabled={activating} className="px-5 shrink-0">
                {activating ? '保存中...' : '保存'}
              </Button>
            </div>
          )}
        </Card>
      )}

      {/* ── 今日概览:分段统计条 ── */}
      <Card className="overflow-hidden p-0">
        <div className="grid grid-cols-4 divide-x divide-[var(--border-light)]">
          <Stat label="今日请求" value={todayRequests.toLocaleString()} tone="primary" />
          <Stat label="错误" value={todayErrors.toLocaleString()} tone={todayErrors > 0 ? 'danger' : undefined} />
          <Stat label="净输入 Token" value={formatTokens(todayInputTokens)} />
          <Stat label="输出 Token" value={formatTokens(todayOutputTokens)} />
        </div>
        <div className="grid grid-cols-2 divide-x divide-[var(--border-light)] border-t border-[var(--border-light)] bg-[var(--bg-tertiary)]/40">
          <div className="px-4 py-2.5">
            <div className="text-[14px] font-bold font-mono-data text-[var(--text-primary)]">{formatTokens(todayBillableTokens)}</div>
            <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
              今日计费 · 含缓存(读 1/10 折) · 写 {formatTokens(todayCacheWriteTokens)} · 读 {formatTokens(todayCachedTokens)}
            </div>
          </div>
          <div className="px-4 py-2.5">
            <div className="text-[14px] font-bold font-mono-data text-[var(--text-primary)]">${cumulativeSaving.toFixed(2)}</div>
            <div className="text-[10px] text-[var(--text-muted)] mt-0.5">累计已节省 · 按各模型 API 定价估算</div>
          </div>
        </div>
      </Card>

      {/* ── 入口:两个广告,常驻显眼 ── */}
      <PromoCard />

      {/* ── 用量趋势 ── */}
      <UsageTrendChart />

      {/* ── 模型用量:每个服务商一栏(带品牌标识),顶部对齐 —— Antigravity / Codex / Anthropic。
          颜色随健康度变(充足绿/一般黄/紧张橙/已用尽红);只有部分服务商有数据时自动减少栏数。 ── */}
      <Card>
        <CardHeader><CardTitle><BarChart3 size={15} /> 模型用量</CardTitle></CardHeader>
        <CardContent>
          {/* 绑定账号当前异常 → 明确提示,不让用户对着「充足」误判。 */}
          {accountProblem && (
            <div className="mb-3 rounded-[8px] border border-[var(--warning)] bg-[var(--warning)]/10 px-3 py-2 text-[11px] text-[var(--text-secondary)]">
              ⚠ 绑定账号暂时不可用,额度数据无法确认:{leaserError}
            </div>
          )}
          {(() => {
            // 一个模型家族的余量行:号余量(单条 / 5h+周 双条)+「我的卡」。
            // 远程/绑定模式无 bucket 数据 / 账号异常 → fraction=-1 显示「未知」,
            // 不回退本地 used/limit(本地不限额恒为「充足 100%」,会假报满血)。
            const modelRows = (bar: BarSpec) => {
              const myBar = renderMyCardBar(bar)
              // codex / anthropic-claude 是账号级 5h + 周 双窗口;antigravity 的 Claude 单条号余量。
              const split =
                bar.family === 'gpt' && codexQuota && !accountProblem ? codexQuota :
                bar.bucket === 'anthropic-claude' && claudeQuota && !accountProblem ? claudeQuota : null
              const accountBars = split ? [
                <UsageBar key="acct-5h" label="号 · 5h 窗口" used={null} limit={null}
                  fraction={split.hourlyFraction} resetMs={split.hourlyResetMs} />,
                <UsageBar key="acct-week" label="号 · 周窗口" used={null} limit={null}
                  fraction={split.weeklyFraction} resetMs={split.weeklyResetMs} />,
              ] : [
                <UsageBar key="acct" label="号余量" used={null} limit={null}
                  fraction={accountProblem ? -1 : (accountFractions?.[bar.bucket] ?? -1)}
                  resetMs={accountResetMs?.[bar.bucket]} />,
              ]
              return [...accountBars, myBar].filter(Boolean)
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
              return <div className="text-[12px] text-[var(--text-muted)] py-1">暂无用量数据</div>
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
        <span>设备: {config?.deviceId?.substring(0, 8) || '-'}...</span>
        <span className="text-[var(--border)]">·</span>
        <span>活跃: {accountId ? `#${accountId}` : '暂无'}</span>
        <span className="text-[var(--border)]">·</span>
        <span>令牌: {autoLeaseRunning ? (hasToken ? '正常' : '获取中') : '闲置'}</span>
        {leaserError && (
          <>
            <span className="text-[var(--border)]">·</span>
            <span className="text-[var(--danger)] truncate max-w-[280px]">{leaserError}</span>
          </>
        )}
      </div>

      <Modal {...modalProps} />
    </div>
  )
}
