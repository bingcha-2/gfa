import { useState } from 'react'
import { useAppStore } from '@/stores/useAppStore'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Modal, useModal } from '@/components/Modal'
import * as api from '@/services/wails'
import { formatDate } from '@/lib/utils'
import { useT } from '@/i18n'
import { User } from 'lucide-react'

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
    <Card>
      <CardHeader>
        <CardTitle><User size={15} /> {t('account.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-[var(--text-muted)]">{t('account.email')}</span>
            <span className="text-[12px] font-medium text-[var(--text-primary)] font-mono-data">
              {account.email || '—'}
            </span>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-[12px] text-[var(--text-muted)]">{t('account.plan')}</span>
            <span className="text-[12px] text-[var(--text-primary)]">
              {account.sessionUnusable ? (
                <Badge variant="danger">{t('account.sessionExpired')}</Badge>
              ) : (
                <span>{planLabel}</span>
              )}
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
      </CardContent>

      <Modal {...modalProps} />
    </Card>
  )
}
