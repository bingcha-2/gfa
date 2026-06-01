import { useState } from 'react'
import { useAppStore } from '@/stores/useAppStore'
import { usePoolStore } from '@/stores/usePoolStore'
import { StatusPill } from '@/components/StatusPill'
import { StatCard } from '@/components/StatCard'
import { UsageBar } from '@/components/UsageBar'
import { PromoCard } from '@/components/PromoCard'
import { TokenSourceControl } from '@/components/TokenSourceControl'
import { Modal, useModal } from '@/components/Modal'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { formatTokens, maskCard, formatDate, cn } from '@/lib/utils'
import { useCountdown } from '@/hooks/useCountdown'
import {
  Activity, AlertCircle, ArrowUpRight, ArrowDownRight, DollarSign,
  Key, Timer, HardDrive,
} from 'lucide-react'
import type { ActiveAccountSummary } from '@/types'

const planLabels: Record<string, string> = {
  ultra: 'Ultra', premium: 'Premium', standard: 'Standard', free: 'Free',
}

const providerColors: Record<string, string> = {
  gemini: 'bg-[var(--accent)]',
  claude: 'bg-purple-500',
  gpt: 'bg-emerald-500',
}

function LocalPoolQuotaDisplay() {
  const activeAccount = useAppStore((s) => s.activeAccount) as ActiveAccountSummary | null

  if (!activeAccount) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 py-3 text-center">
        <HardDrive size={20} className="text-[var(--text-muted)]" />
        <span className="text-[12px] text-[var(--text-muted)]">本地号池模式下，配额按各账号独立计算</span>
        <span className="text-[11px] text-[var(--text-muted)]">可在「号池管理」页查看各号额度</span>
      </div>
    )
  }

  const { planType, credits, quotaGroups, email, alias } = activeAccount

  return (
    <div className="flex flex-col gap-2">
      {/* 账号 + 套餐 */}
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-[var(--text-secondary)] truncate max-w-[140px]">
          {alias || email}
        </span>
        <Badge variant={planType === 'ultra' ? 'success' : planType === 'premium' ? 'default' : 'muted'}>
          {planLabels[planType] || planType || 'Unknown'}
        </Badge>
      </div>

      {/* AI 积分 */}
      {credits?.known && (
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-[var(--text-muted)]">AI 积分</span>
          <span className={cn('font-mono-data font-semibold', credits.available ? 'text-[var(--success)]' : 'text-[var(--danger)]')}>
            {credits.creditAmount.toLocaleString()}
          </span>
        </div>
      )}

      {/* 模型额度条 */}
      {quotaGroups && quotaGroups.length > 0 ? (
        quotaGroups.map((g) => (
          <div key={g.provider} className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-[var(--text-muted)] capitalize">{g.provider}</span>
              <span className="text-[var(--text-muted)] font-mono-data">{Math.round(g.percent)}%</span>
            </div>
            <Progress
              value={g.percent}
              className="h-1.5"
              indicatorClassName={cn(
                providerColors[g.provider] || 'bg-[var(--primary)]',
                g.percent <= 0 && 'bg-[var(--danger)]',
              )}
            />
          </div>
        ))
      ) : (
        <span className="text-[11px] text-[var(--text-muted)]">额度数据加载中...</span>
      )}
    </div>
  )
}

export function DashboardPage() {
  const {
    config, leaserError, hasToken, autoLeaseRunning, accountId,
    activationExpiresAt, todayRequests, todayErrors, todayInputTokens, todayOutputTokens, cumulativeSaving,
    opusUsed, opusLimit, geminiUsed, geminiLimit, codexUsed, codexLimit, recoveryRemainingMs, recoveryWindowMs,
  } = useAppStore()

  // 限流窗口时长由服务端按卡密下发(可配置小时/天),文案据此动态显示。
  const windowLabel = (() => {
    const hours = recoveryWindowMs / 3600000
    return hours >= 24 ? `${Math.round(hours / 24)}天` : `${Math.round(hours)}h`
  })()

  const poolMode = usePoolStore((s) => s.mode)

  const { modalProps, showAlert } = useModal()
  const { display: recoveryDisplay, percent: recoveryPercent, isDone: recoveryDone } = useCountdown(recoveryRemainingMs, recoveryWindowMs)

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
              {/* 额度恢复倒计时(统一收口于此,租号/中转限流后显示) */}
              {recoveryRemainingMs > 0 && (
                <div className="mb-3 pb-3 border-b border-[var(--border-light)]">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[12px] font-medium text-[var(--text-secondary)] flex items-center gap-1">
                      <Timer size={12} /> {windowLabel} 额度恢复
                    </span>
                    <Badge variant={recoveryDone ? 'success' : 'warning'}>{recoveryDisplay}</Badge>
                  </div>
                  <Progress value={recoveryPercent} indicatorClassName={cn(recoveryDone ? 'bg-[var(--success)]' : 'bg-[var(--warning)]')} />
                </div>
              )}
              {poolMode === 'local' ? (
                <LocalPoolQuotaDisplay />
              ) : (
                <div className="flex flex-col gap-2.5">
                  <UsageBar label="Claude (Opus)" used={opusUsed} limit={opusLimit} color="bg-purple-500" />
                  <UsageBar label="Gemini" used={geminiUsed} limit={geminiLimit} color="bg-[var(--accent)]" />
                  <UsageBar label="Codex" used={codexUsed} limit={codexLimit} color="bg-emerald-500" />
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

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
