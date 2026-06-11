import { useState } from 'react'
import { useAppStore } from '@/stores/useAppStore'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import * as api from '@/services/wails'
import { useT } from '@/i18n'

export function LoginPage() {
  const t = useT()
  const { login } = useAppStore()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [deviceLimitReached, setDeviceLimitReached] = useState(false)

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!email.trim() || !password.trim()) return
    setSubmitting(true)
    setError('')
    setDeviceLimitReached(false)
    try {
      await login(email.trim(), password)
    } catch (err: unknown) {
      const msg = String(err)
      if (msg.includes('DEVICE_LIMIT_EXCEEDED')) {
        setDeviceLimitReached(true)
      } else if (msg.includes('INVALID_CREDENTIALS')) {
        setError(t('login.errorInvalidCreds'))
      } else if (msg.includes('ACCOUNT_DISABLED')) {
        setError(t('login.errorDisabled'))
      } else {
        setError(t('login.errorGeneric', { error: msg }))
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-[var(--bg-primary)]">
      <Card className="w-full max-w-[360px] mx-4">
        <CardContent className="pt-6 pb-6">
          {/* Logo / Title */}
          <div className="text-center mb-5">
            <div className="text-[20px] font-bold text-[var(--text-primary)] mb-1">冰茶AI</div>
            <div className="text-[13px] text-[var(--text-muted)]">{t('login.title')}</div>
          </div>

          {/* Device limit error */}
          {deviceLimitReached && (
            <div className="mb-3 rounded-[8px] border border-[var(--danger)] bg-[var(--danger)]/5 px-3 py-2.5">
              <div className="text-[12px] font-semibold text-[var(--danger)] mb-1">
                {t('login.deviceLimitTitle')}
              </div>
              <div className="text-[11px] text-[var(--text-secondary)] mb-2">
                {t('login.deviceLimitBody')}
              </div>
              <button
                onClick={() => api.openURL(api.PORTAL_URLS.devices)}
                className="text-[11px] font-semibold text-[var(--primary)] hover:text-[var(--primary-strong)] transition-colors underline"
              >
                {t('login.manageDevices')}
              </button>
            </div>
          )}

          {/* Generic error */}
          {error && !deviceLimitReached && (
            <div className="mb-3 rounded-[8px] border border-[var(--danger)] bg-[var(--danger)]/5 px-3 py-2 text-[12px] text-[var(--danger)]">
              {error}
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <div>
              <label className="text-[11px] font-medium text-[var(--text-secondary)] mb-1 block">
                {t('login.emailLabel')}
              </label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('login.emailPlaceholder')}
                autoComplete="email"
                className="h-9"
              />
            </div>
            <div>
              <label className="text-[11px] font-medium text-[var(--text-secondary)] mb-1 block">
                {t('login.passwordLabel')}
              </label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('login.passwordPlaceholder')}
                autoComplete="current-password"
                className="h-9"
              />
            </div>
            <Button
              type="submit"
              disabled={submitting || !email.trim() || !password.trim()}
              className="w-full h-10 mt-1"
            >
              {submitting ? t('login.submitting') : t('login.submit')}
            </Button>
          </form>

          {/* Portal links */}
          <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 mt-4">
            <button
              onClick={() => api.openURL(api.PORTAL_URLS.register)}
              className="text-[11px] text-[var(--text-muted)] hover:text-[var(--primary-strong)] transition-colors"
            >
              {t('login.registerLink')}
            </button>
            <button
              onClick={() => api.openURL(api.PORTAL_URLS.forgot)}
              className="text-[11px] text-[var(--text-muted)] hover:text-[var(--primary-strong)] transition-colors"
            >
              {t('login.forgotLink')}
            </button>
            <button
              onClick={() => api.openURL(api.PORTAL_URLS.billing)}
              className="text-[11px] text-[var(--text-muted)] hover:text-[var(--primary-strong)] transition-colors"
            >
              {t('login.buyLink')}
            </button>
            <button
              onClick={() => api.openURL(api.PORTAL_URLS.bind)}
              className="text-[11px] text-[var(--text-muted)] hover:text-[var(--primary-strong)] transition-colors"
            >
              {t('login.bindCard')}
            </button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
