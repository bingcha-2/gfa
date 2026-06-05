import { useState } from 'react'
import { useAppStore } from '@/stores/useAppStore'
import { StatusPill } from '@/components/StatusPill'
import { StatCard } from '@/components/StatCard'
import { UsageBar } from '@/components/UsageBar'
import { PromoCard } from '@/components/PromoCard'
import { TokenSourceControl } from '@/components/TokenSourceControl'
import { BoundAccountsCard } from '@/components/BoundAccountsCard'
import { usageBarsForProducts } from '@/lib/usageBars'
import { Modal, useModal } from '@/components/Modal'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { formatTokens, maskCard, formatDate } from '@/lib/utils'
import {
  Activity, AlertCircle, ArrowUpRight, ArrowDownRight, DollarSign,
  Key,
} from 'lucide-react'

export function DashboardPage() {
  const {
    config, leaserError, hasToken, autoLeaseRunning, accountId, cardUnusable, cardProducts, bucketFractions, bucketResetMs, codexQuota, claudeQuota,
    activationExpiresAt, todayRequests, todayErrors, todayInputTokens, todayOutputTokens, cumulativeSaving,
    opusUsed, opusLimit, geminiUsed, geminiLimit, codexUsed, codexLimit,
  } = useAppStore()

  // 绑定卡只显示它绑了的产品的用量条;池子卡(无 products)三条都显示。
  const visibleBars = usageBarsForProducts(cardProducts)
  // 绑定账号当前不可用(租号报错且非致命):额度数据不可信 → 血条显示「未知」+ 顶部提示,
  // 绝不把陈旧的「充足 100%」当真。lastError 在成功租号时会被清空,所以它=当前确有问题。
  // 仅对开通了 antigravity 的卡(opus/gemini 血条可见)成立 —— codex-only 卡不跑 antigravity,
  // 不该弹 antigravity 的账号异常提示。与后端"按 products 决定是否租号"是同一套逻辑。
  const accountProblem = !!leaserError && !cardUnusable && visibleBars.some((b) => b.family === 'claude')

  const { modalProps, showAlert } = useModal()

  const [cardInput, setCardInput] = useState('')
  const [activating, setActivating] = useState(false)
  const handleActivateCard = async () => {
    if (!cardInput.trim()) { await showAlert('提示', '请输入账号卡号！'); return }
    setActivating(true)
    try {
      const result = await useAppStore.getState().activateCard(cardInput.trim())
      await showAlert('激活成功', `有效期至: ${formatDate(result)}`); setCardInput('')
    } catch (err) { await showAlert('激活失败', `${err}`) }
    finally { setActivating(false) }
  }

  return (
    <div className="max-w-[920px] flex flex-col gap-4">
      {/* ── Row 0: Status ── */}
      <StatusPill />

      {/* 无可用卡密:停止租号、功能不可用,只能重新激活或退出接管 */}
      {cardUnusable && (
        <div className="rounded-[10px] border border-[var(--danger)] bg-[var(--danger)]/5 px-4 py-3">
          <div className="text-sm font-medium text-[var(--danger)]">卡密不可用,功能已停用</div>
          <div className="text-[12px] text-[var(--text-secondary)] mt-1">
            当前账号卡已失效(无效/过期/禁用)。请在下方<strong>重新激活有效卡密</strong>;或前往左侧「接管」面板<strong>退出接管</strong>,恢复 IDE / Codex 正常使用。
          </div>
        </div>
      )}

      {/* ── Row 1: Stats ── */}
      <div className="grid grid-cols-4 gap-3">
        <StatCard icon={Activity} value={todayRequests.toLocaleString()} label="今日请求" color="text-[var(--primary)]" />
        <StatCard icon={AlertCircle} value={todayErrors.toLocaleString()} label="错误数" color="text-[var(--danger)]" />
        <StatCard icon={ArrowUpRight} value={formatTokens(todayInputTokens)} label="输入 Token" color="text-[var(--accent)]" />
        <StatCard icon={ArrowDownRight} value={formatTokens(todayOutputTokens)} label="输出 Token" color="text-purple-600" />
      </div>

      {/* ── Row 2: Ads — full-width, 3 columns, prominent ── */}
      <PromoCard />

      {/* ── Row 3: Savings (full width) ── */}
      <Card className="flex items-center gap-3 px-4 py-3">
        <div className="w-9 h-9 rounded-[10px] bg-green-50 flex items-center justify-center shrink-0">
          <DollarSign size={18} className="text-[var(--success)]" />
        </div>
        <div className="min-w-0">
          <div className="text-lg font-bold font-mono-data text-[var(--success)]">${cumulativeSaving.toFixed(2)}</div>
          <div className="text-[10px] text-[var(--text-muted)]">累计已节省</div>
        </div>
      </Card>

      {/* ── Row 4: Source+Takeover (left, tall) / Account card + Usage (right stack) ── */}
      <div className="grid grid-cols-2 gap-4 items-stretch">
        <TokenSourceControl />

        {/* 右列竖向堆叠:账号卡配置 + 模型用量,自然填满左侧高度 */}
        <div className="flex flex-col gap-4">
          {/* 账号卡配置 */}
          <Card>
            <CardHeader><CardTitle><Key size={15} /> 账号卡配置</CardTitle></CardHeader>
            <CardContent>
              <div className="flex items-center justify-between px-3 rounded-[8px] bg-[var(--bg-tertiary)] border border-[var(--border-light)] h-[52px]">
                <div>
                  <div className="text-[10px] text-[var(--text-muted)]">当前生效</div>
                  <div className="text-[13px] font-mono-data text-[var(--text-primary)]">{config?.accountCard ? maskCard(config.accountCard) : '未激活'}</div>
                </div>
                {config?.accountCard && (
                  <Button size="sm" variant="ghost" onClick={() => navigator.clipboard.writeText(config.accountCard)}>复制</Button>
                )}
              </div>
              <Input value={cardInput} onChange={(e) => setCardInput(e.target.value)}
                placeholder={config?.accountCard ? '输入新账号卡以更换' : '输入账号卡 (AI...)'} className="h-[52px] mt-1.5" />

              {/* 卡密状态 */}
              <div className="mt-3 rounded-[8px] border border-[var(--border-light)] bg-[var(--bg-card)] p-3 flex flex-col gap-2.5">
                <div className="flex items-center justify-between text-[12px]">
                  <span className="text-[var(--text-muted)]">激活状态</span>
                  <Badge variant={config?.accountCard ? (hasToken ? 'success' : 'default') : 'muted'}>
                    {config?.accountCard ? (autoLeaseRunning ? (hasToken ? '已激活 · 令牌正常' : '已激活 · 获取中') : '已激活 · 闲置') : '未激活'}
                  </Badge>
                </div>
                <div className="flex items-center justify-between text-[12px]">
                  <span className="text-[var(--text-muted)]">到期时间</span>
                  <span className="text-[var(--text-secondary)] font-mono-data">
                    {activationExpiresAt && !isNaN(new Date(activationExpiresAt).getTime()) ? formatDate(activationExpiresAt) : '—'}
                  </span>
                </div>
              </div>

              <Button onClick={handleActivateCard} disabled={activating} className="w-full mt-3">
                {activating ? '激活中...' : config?.accountCard ? '保存新账号卡' : '验证激活'}
              </Button>
            </CardContent>
          </Card>

          {/* 模型用量 */}
          <Card>
            <CardHeader><CardTitle>模型用量</CardTitle></CardHeader>
            <CardContent>
              <div className="flex flex-col gap-2.5">
                  {/* 绑定账号当前异常 → 明确提示,不让用户对着「充足」误判。 */}
                  {accountProblem && (
                    <div className="rounded-[8px] border border-[var(--warning)] bg-[var(--warning)]/10 px-3 py-2 text-[11px] text-[var(--text-secondary)]">
                      ⚠ 绑定账号暂时不可用,额度数据无法确认:{leaserError}
                    </div>
                  )}
                  {/* 远程/绑定模式:无 bucket 数据 / 账号异常 → 显示「未知」(fraction=-1),
                      不回退本地 used/limit(本地不限额恒为「充足 100%」,会假报满血)。 */}
                  {visibleBars.map((bar) => {
                    // Codex bar: prefer the upstream 5h/周 windows when present.
                    if (bar.family === 'gpt' && codexQuota && !accountProblem) {
                      return [
                        <UsageBar key="codex-5h" label={`${bar.label} · 5h`} used={null} limit={null} fraction={codexQuota.hourlyFraction} resetMs={codexQuota.hourlyResetMs} color="bg-emerald-500" />,
                        <UsageBar key="codex-week" label={`${bar.label} · 周`} used={null} limit={null} fraction={codexQuota.weeklyFraction} resetMs={codexQuota.weeklyResetMs} color="bg-emerald-600" />,
                      ]
                    }
                    // Anthropic subscription is also an account-level 5h + 周 window
                    // (like codex). Only the anthropic-claude bar gets the split —
                    // antigravity's Claude (IDE ×1 bucket) keeps a single bar.
                    if (bar.bucket === 'anthropic-claude' && claudeQuota && !accountProblem) {
                      return [
                        <UsageBar key="claude-5h" label={`${bar.label} · 5h`} used={null} limit={null} fraction={claudeQuota.hourlyFraction} resetMs={claudeQuota.hourlyResetMs} color="bg-purple-500" />,
                        <UsageBar key="claude-week" label={`${bar.label} · 周`} used={null} limit={null} fraction={claudeQuota.weeklyFraction} resetMs={claudeQuota.weeklyResetMs} color="bg-purple-600" />,
                      ]
                    }
                    // Local used/limit are family-scoped (server still sends the
                    // flat per-family fields); the fraction comes from the
                    // composite bucket so two same-family bars stay separate.
                    const used = bar.family === 'gemini' ? geminiUsed : bar.family === 'gpt' ? codexUsed : opusUsed
                    const limit = bar.family === 'gemini' ? geminiLimit : bar.family === 'gpt' ? codexLimit : opusLimit
                    return (
                      <UsageBar
                        key={bar.bucket}
                        label={bar.label}
                        used={used}
                        limit={limit}
                        fraction={accountProblem ? -1 : (bucketFractions?.[bar.bucket] ?? -1)}
                        resetMs={bucketResetMs?.[bar.bucket]}
                        color={bar.color}
                      />
                    )
                  })}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ── Row 5: 绑定账号信息(仅绑定卡 + 远程模式显示)── */}
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
