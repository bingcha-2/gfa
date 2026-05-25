import { useState } from 'react'
import { useAppStore } from '@/stores/useAppStore'
import { usePoolStore } from '@/stores/usePoolStore'
import { StatusPill } from '@/components/StatusPill'
import { StatCard } from '@/components/StatCard'
import { UsageBar } from '@/components/UsageBar'
import { PromoCard } from '@/components/PromoCard'
import { Modal, useModal } from '@/components/Modal'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { formatTokens, maskCard, formatDate, cn } from '@/lib/utils'
import { useCountdown } from '@/hooks/useCountdown'
import * as api from '@/services/wails'
import {
  Activity, AlertCircle, ArrowUpRight, ArrowDownRight, DollarSign,
  Power, Check, Key, Zap, Cloud, HardDrive, Timer, CalendarClock,
} from 'lucide-react'

export function DashboardPage() {
  const {
    config, ideProducts, leaserError, hasToken, autoLeaseRunning, accountId,
    activationExpiresAt, todayRequests, todayErrors, todayInputTokens, todayOutputTokens, cumulativeSaving,
    opusUsed, opusLimit, geminiUsed, geminiLimit, recoveryRemainingMs,
    fetchIDEStatus,
  } = useAppStore()

  const poolMode = usePoolStore((s) => s.mode)
  const setPoolMode = usePoolStore((s) => s.setMode)

  const { modalProps, showAlert } = useModal()
  const { display: recoveryDisplay, percent: recoveryPercent, isDone: recoveryDone } = useCountdown(recoveryRemainingMs)

  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set())
  const [injecting, setInjecting] = useState(false)
  const isAnyInjected = ideProducts.some((p) => p.injected)

  const toggleTarget = (target: string) => {
    const next = new Set(selectedTargets)
    if (next.has(target)) next.delete(target)
    else next.add(target)
    setSelectedTargets(next)
  }

  const handleInjectToggle = async () => {
    setInjecting(true)
    try {
      if (isAnyInjected) {
        const targets = ideProducts.filter((p) => p.injected).map((p) => p.id === 'antigravity_ide' ? 'ide' : 'hub')
        await api.restoreSelected(targets)
      } else {
        const targets = Array.from(selectedTargets)
        if (targets.length === 0) { await showAlert('请选择产品', '请先勾选要接管的产品。'); return }
        if (poolMode === 'remote' && (!config?.accountCard || config.accountCard.trim() === '')) {
          await showAlert('请先激活账号卡', '当前为远程续杯模式，请先激活账号卡。'); return
        }
        await api.injectSelected(targets)
      }
      await fetchIDEStatus()
    } catch (err) { await showAlert('操作失败', String(err)) }
    finally { setInjecting(false) }
  }

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

      {/* ── Row 3: Savings + Recovery ── */}
      <div className={cn('grid gap-3', recoveryRemainingMs > 0 ? 'grid-cols-2' : 'grid-cols-1')}>
        <Card className="flex items-center gap-3 px-4 py-3">
          <div className="w-9 h-9 rounded-[10px] bg-green-50 flex items-center justify-center shrink-0">
            <DollarSign size={18} className="text-[var(--success)]" />
          </div>
          <div className="min-w-0">
            <div className="text-lg font-bold font-mono-data text-[var(--success)]">${cumulativeSaving.toFixed(2)}</div>
            <div className="text-[10px] text-[var(--text-muted)]">累计已节省</div>
          </div>
        </Card>

        {recoveryRemainingMs > 0 && (
          <Card className="flex flex-col justify-center gap-1.5 px-4 py-3">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-medium text-[var(--text-secondary)] flex items-center gap-1">
                <Timer size={12} /> 额度恢复
              </span>
              <Badge variant={recoveryDone ? 'success' : 'warning'}>{recoveryDisplay}</Badge>
            </div>
            <Progress value={recoveryPercent} indicatorClassName={cn(recoveryDone ? 'bg-[var(--success)]' : 'bg-[var(--warning)]')} />
          </Card>
        )}
      </div>

      {/* ── Row 4: Main 2-col — equal height ── */}
      <div className="grid grid-cols-2 gap-4 items-stretch">
        {/* Left: Token 来源 (top) + IDE 接管 (bottom) */}
        <Card className="flex flex-col">
          <CardContent className="flex-1 flex flex-col pt-5">
            {/* Token source */}
            <div className="mb-4 min-h-[88px]">
              <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--text-secondary)] mb-2">
                <Zap size={13} /> Token 来源
              </div>
              <div className="flex rounded-[8px] bg-[var(--bg-tertiary)] p-1">
                {[
                  { mode: 'remote' as const, icon: Cloud, label: '远程续杯' },
                  { mode: 'local' as const, icon: HardDrive, label: '本地号池' },
                ].map(({ mode, icon: Icon, label }) => (
                  <button
                    key={mode}
                    onClick={() => setPoolMode(mode)}
                    className={cn(
                      'flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-[6px] text-[12px] font-semibold transition-all',
                      poolMode === mode
                        ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                    )}
                  >
                    <Icon size={13} /> {label}
                  </button>
                ))}
              </div>
            </div>

            {/* IDE 接管 */}
            <div className="border-t border-[var(--border-light)] pt-3">
              <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--text-secondary)] mb-2">
                <Power size={13} /> IDE 接管控制
              </div>
              <div className="flex flex-col gap-1.5 mb-3">
                {ideProducts.map((product) => {
                  const target = product.id === 'antigravity_ide' ? 'ide' : 'hub'
                  const isSelected = selectedTargets.has(target)
                  return (
                    <button
                      key={product.id}
                      onClick={() => product.detected && toggleTarget(target)}
                      disabled={!product.detected}
                      className={cn(
                        'flex items-center justify-between px-3 py-2 rounded-[8px] transition-all text-left border',
                        product.detected ? 'hover:bg-[var(--bg-hover)] cursor-pointer border-[var(--border-light)]' : 'opacity-40 cursor-not-allowed border-transparent',
                      )}
                    >
                      <div>
                        <div className="text-[13px] text-[var(--text-primary)] font-medium">{product.name}</div>
                        <div className={cn('text-[11px] mt-0.5', product.injected ? 'text-[var(--success)]' : 'text-[var(--text-muted)]')}>
                          {!product.detected ? '未安装' : product.injected ? '✓ 已接管' : '未接管'}
                        </div>
                      </div>
                      <div className={cn(
                        'w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all',
                        isSelected || product.injected ? 'border-[var(--primary)] bg-[var(--primary-light)]' : 'border-[var(--border)]'
                      )}>
                        {(isSelected || product.injected) && <Check size={11} className="text-[var(--primary)]" />}
                      </div>
                    </button>
                  )
                })}
              </div>

              <Button onClick={handleInjectToggle} disabled={injecting} variant={isAnyInjected ? 'danger' : 'default'} className="w-full mb-2">
                {injecting ? '处理中...' : isAnyInjected ? '停止接管' : '开启接管'}
              </Button>

              {/* Expiry + 5h countdown */}
              {activationExpiresAt && !isNaN(new Date(activationExpiresAt).getTime()) && (
                <div className="flex items-center gap-2 mt-1 px-2.5 py-1.5 rounded-[6px] border border-[var(--border-light)] bg-[var(--bg-card)] text-[10px] text-[var(--text-muted)]">
                  <CalendarClock size={10} className="flex-shrink-0" />
                  <span>到期: <span className="text-[var(--text-secondary)] font-medium">{formatDate(activationExpiresAt)}</span></span>
                  <span className="text-[var(--border)]">|</span>
                  <span>5h: <span className="text-[var(--text-secondary)] font-medium">{recoveryDisplay}</span></span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Right: 模型用量 (top) + 账号卡 (bottom) */}
        <Card className="flex flex-col">
          <CardContent className="flex-1 flex flex-col pt-5">
            {/* 模型用量 */}
            <div className="mb-4 min-h-[88px]">
              <div className="text-[12px] font-semibold text-[var(--text-secondary)] mb-2.5">模型用量</div>
              <div className="flex flex-col gap-3">
                <UsageBar label="Claude (Opus)" used={opusUsed} limit={opusLimit} color="bg-purple-500" />
                <UsageBar label="Gemini" used={geminiUsed} limit={geminiLimit} color="bg-[var(--accent)]" />
              </div>
            </div>

            {/* 账号卡 */}
            <div className="border-t border-[var(--border-light)] pt-3">
              <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--text-secondary)] mb-2">
                <Key size={13} /> 账号卡配置
              </div>
              {config?.accountCard && (
                <div className="flex items-center justify-between px-3 py-2 rounded-[8px] bg-[var(--bg-tertiary)] border border-[var(--border-light)] mb-3">
                  <div>
                    <div className="text-[10px] text-[var(--text-muted)]">当前生效</div>
                    <div className="text-[13px] font-mono-data text-[var(--text-primary)]">{maskCard(config.accountCard)}</div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => navigator.clipboard.writeText(config.accountCard)}>复制</Button>
                </div>
              )}
              <Input value={cardInput} onChange={(e) => setCardInput(e.target.value)}
                placeholder={config?.accountCard ? '输入新账号卡以更换' : '输入账号卡 (AI...)'} className="mb-2" />
              <Button onClick={handleActivateCard} disabled={activating} className="w-full">
                {activating ? '激活中...' : config?.accountCard ? '保存新账号卡' : '验证激活'}
              </Button>
            </div>
          </CardContent>
        </Card>
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
