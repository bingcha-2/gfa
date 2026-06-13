import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useAppStore } from '@/stores/useAppStore'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Modal, useModal } from '@/components/Modal'
import * as api from '@/services/wails'
import { formatDate } from '@/lib/utils'
import { useT } from '@/i18n'
import bcaiIcon from '@/assets/images/bcai-icon.png'

export function AccountStatusCard() {
  const t = useT()
  const { account, logout, heartbeat, fetchStats, cardUnusable } = useAppStore()
  const { modalProps, showAlert, showConfirm } = useModal()
  const [loggingOut, setLoggingOut] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  if (!account) return null

  // 「是否已订阅」必须反映真实可用态。catalog 化后订阅没有套餐名(planName 恒空),不能用它判断;
  // 但也不能只看 planExpiry —— 订阅到期/被移除后心跳返回无订阅,而本地 planExpiry 可能仍是上一期
  // 的未来值(stale),会误显示「已订阅」。所以:卡密被标记不可用(SUBSCRIPTION_EXPIRED 等)或
  // 会话失效时一律视为未订阅;否则才用「有未过期有效期」判定。Go 侧另会在心跳无订阅时清掉 stale 快照。
  const hasActivePlan =
    !cardUnusable &&
    !account.sessionUnusable &&
    !!account.planExpiry &&
    account.planExpiry !== 'null' &&
    new Date(account.planExpiry).getTime() > Date.now()
  const planLabel =
    account.planName || (hasActivePlan ? t('account.activeMember') : t('account.noSubscription'))
  const planExpiryLabel =
    account.planExpiry && account.planExpiry !== 'null'
      ? formatDate(account.planExpiry)
      : '—'

  // 手动刷新:立刻心跳一次(重新校验会话 + 拉最新订阅快照,内部随后 fetchAccountState),
  // 再刷新租号/额度态。订阅刚开通/续费后无需干等 60s 轮询或重启 App。
  // 卡密被标记不可用时,顺带重启接管重新租号 —— 让一键恢复成为可能(订阅已续上即生效)。
  const handleRefresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await heartbeat()
      await fetchStats()
      if (useAppStore.getState().cardUnusable) {
        await api.restartProxy()
        await fetchStats()
      }
    } catch {
      // 忽略:各 store action 自行记录错误
    } finally {
      setRefreshing(false)
    }
  }

  const handleLogout = async () => {
    const confirmed = await showConfirm(t('account.logoutConfirmTitle'), t('account.logoutConfirmBody'))
    if (!confirmed) return
    setLoggingOut(true)
    try {
      await logout()
    } catch (err) {
      await showAlert('Error', String(err))
    } finally {
      setLoggingOut(false)
    }
  }

  return (
    <Card className="overflow-hidden">
      {/* ── 会员身份头:套餐为主角,玻璃杯徽标 + MEMBERSHIP 眉标 + 琥珀光晕(与官网通行证一致)── */}
      <div className="relative flex items-center justify-between gap-3 px-4 pt-4 pb-3.5">
        <div
          className="pointer-events-none absolute -top-12 -left-8 w-44 h-28 rounded-full"
          style={{ background: 'radial-gradient(circle, var(--glow), transparent 70%)' }}
          aria-hidden
        />
        <div className="relative flex items-center gap-3 min-w-0">
          <span className="relative grid place-items-center w-10 h-10 rounded-[12px] bg-[var(--bg-tertiary)] border border-[var(--border-light)] shadow-[var(--shadow-sm)] shrink-0">
            <img src={bcaiIcon} alt="" className="w-7 h-7 rounded-[8px]" />
          </span>
          <div className="min-w-0">
            <div className="text-[10px] font-semibold tracking-[0.1em] uppercase text-[var(--text-muted)]">
              MEMBERSHIP · 冰茶AI
            </div>
            <div className="text-[15px] font-bold text-[var(--text-primary)] leading-tight mt-0.5 truncate">
              {planLabel}
            </div>
          </div>
        </div>
        <div className="relative shrink-0 flex items-center gap-2">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            title={t('account.refresh')}
            aria-label={t('account.refresh')}
            className="grid place-items-center w-7 h-7 rounded-[8px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          </button>
          {account.sessionUnusable ? (
            <Badge variant="danger">{t('account.sessionExpired')}</Badge>
          ) : (
            <span className="w-2 h-2 rounded-full bg-[var(--success)] dot-pulse block" title={t('account.title')} />
          )}
        </div>
      </div>

      <div className="border-t border-[var(--border-light)]" />

      {/* ── 明细行 ── */}
      <div className="px-4 py-3 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[12px] text-[var(--text-muted)]">{t('account.email')}</span>
          <span className="text-[12px] font-medium text-[var(--text-primary)] font-mono-data truncate max-w-[220px]">
            {account.email || '—'}
          </span>
        </div>

        {hasActivePlan && (
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-[var(--text-muted)]">{t('account.planExpiry')}</span>
            <span className="text-[12px] text-[var(--text-secondary)]">{planExpiryLabel}</span>
          </div>
        )}

        {account.deviceName && (
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-[var(--text-muted)]">{t('account.deviceName')}</span>
            <span className="text-[11px] text-[var(--text-secondary)] font-mono-data truncate max-w-[200px]">
              {account.deviceName}
            </span>
          </div>
        )}

        <div className="flex items-center gap-2 mt-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => api.openURL(api.PORTAL_URLS.devices)}
            className="flex-1"
          >
            {t('account.manageDevices')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleLogout}
            disabled={loggingOut}
            className="flex-1"
          >
            {loggingOut ? '...' : t('account.logout')}
          </Button>
        </div>
      </div>

      <Modal {...modalProps} />
    </Card>
  )
}
