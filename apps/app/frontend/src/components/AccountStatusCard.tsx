import { useState } from 'react'
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
  const { account, logout } = useAppStore()
  const { modalProps, showAlert, showConfirm } = useModal()
  const [loggingOut, setLoggingOut] = useState(false)

  if (!account) return null

  const planLabel = account.planName || t('account.noSubscription')
  const planExpiryLabel =
    account.planExpiry && account.planExpiry !== 'null'
      ? formatDate(account.planExpiry)
      : '—'

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
        <div className="relative shrink-0">
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

        {account.planExpiry && account.planExpiry !== 'null' && (
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
