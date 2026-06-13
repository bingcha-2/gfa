import { useState } from 'react'
import { useAppStore } from '@/stores/useAppStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import * as api from '@/services/wails'
import { LanguageMenu } from '@/components/LanguageMenu'
import { useT } from '@/i18n'
import { Check } from 'lucide-react'
import bcaiIcon from '@/assets/images/bcai-icon.png'
import { topInset } from '@/components/layout/chrome'

/** 品牌徽标:玻璃杯图标 + 琥珀光晕(记忆点),登录与侧栏一致。 */
function BrandMark({ size = 48 }: { size?: number }) {
  return (
    <span
      className="relative grid place-items-center rounded-[14px] bg-[var(--bg-card)] border border-[var(--border-light)] shadow-[var(--shadow-sm)] shrink-0"
      style={{ width: size, height: size }}
    >
      <span
        className="pointer-events-none absolute -inset-1.5 rounded-[18px] opacity-70"
        style={{ background: 'radial-gradient(circle at 50% 40%, var(--glow), transparent 70%)' }}
        aria-hidden
      />
      <img src={bcaiIcon} alt="" className="relative rounded-[9px]" style={{ width: size * 0.66, height: size * 0.66 }} />
    </span>
  )
}

export function LoginPage() {
  const t = useT()
  const { login, logoutReason } = useAppStore()

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

  const trustPoints = [t('login.trust1'), t('login.trust2'), t('login.trust3')]

  return (
    <div className="relative flex items-center justify-center min-h-screen bg-[var(--bg-primary)] px-4">
      {/* 顶部拖动安全区:窗口为 TitleBarHiddenInset(无原生标题栏),只能从标了
          --wails-draggable:drag 的区域拖动。登录页不在 AppShell 内,需自带一条;
          高度与 AppShell 顶部安全区一致(mac 44 / 其它 16)。 */}
      <div
        className="absolute top-0 inset-x-0 z-0"
        style={{ height: `${topInset()}px`, '--wails-draggable': 'drag' } as React.CSSProperties}
        aria-hidden
      />
      <LanguageMenu className="absolute top-4 right-4 z-10" />

      <div className="w-full max-w-[760px] grid sm:grid-cols-[1.05fr_1fr] rounded-[20px] overflow-hidden border border-[var(--border-light)] bg-[var(--bg-card)] shadow-[var(--shadow-lg)]">
        {/* ── 品牌 / 信任 侧栏(窄窗折叠)── */}
        <aside className="relative hidden sm:flex flex-col gap-6 p-8 bg-[var(--sidebar-bg)] border-r border-[var(--border-light)] overflow-hidden">
          <div
            className="pointer-events-none absolute -top-20 -left-16 w-64 h-64 rounded-full"
            style={{ background: 'radial-gradient(circle, var(--glow), transparent 70%)' }}
            aria-hidden
          />

          {/* eyebrow */}
          <div className="relative flex items-center gap-2 text-[10.5px] font-semibold tracking-[0.12em] text-[var(--text-muted)] uppercase">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)] dot-pulse" />
            MEMBERSHIP · 冰茶AI
          </div>

          {/* brand lockup */}
          <div className="relative flex items-center gap-3">
            <BrandMark size={48} />
            <div>
              <div className="text-[19px] font-bold text-[var(--text-primary)] tracking-tight leading-none">冰茶AI</div>
              <div className="text-[12px] text-[var(--text-muted)] mt-1">{t('login.memberCenter')}</div>
            </div>
          </div>

          {/* lead */}
          <p className="relative text-[13px] leading-[1.75] text-[var(--text-secondary)] max-w-[34ch]">
            {t('login.lead')}
          </p>

          {/* trust points */}
          <div className="relative flex flex-col gap-2.5 mt-auto">
            {trustPoints.map((point) => (
              <div key={point} className="flex items-center gap-2 text-[12.5px] text-[var(--text-secondary)]">
                <span className="grid place-items-center w-4 h-4 rounded-full bg-[var(--primary-light)] text-[var(--primary)] shrink-0">
                  <Check size={11} strokeWidth={3} />
                </span>
                {point}
              </div>
            ))}
          </div>
        </aside>

        {/* ── 表单面板 ── */}
        <section className="p-7 sm:p-8 flex flex-col justify-center">
          {/* 窄窗下补一个紧凑品牌行(侧栏已折叠) */}
          <div className="flex sm:hidden items-center gap-2.5 mb-5">
            <BrandMark size={38} />
            <span className="text-[16px] font-bold text-[var(--text-primary)] tracking-tight">冰茶AI</span>
          </div>

          <div className="mb-5">
            <h1 className="text-[19px] font-bold text-[var(--text-primary)] tracking-tight">{t('login.title')}</h1>
          </div>

          {/* 被动登出提示(设备被移除 / 会话失效):解释为何回到登录页,避免看着像「没反应」 */}
          {logoutReason && !deviceLimitReached && !error && (
            <div className="mb-3 rounded-[10px] border border-[var(--warning)] bg-[var(--warning)]/10 px-3 py-2.5 text-[12px] text-[var(--text-secondary)]">
              {logoutReason === 'DEVICE_REVOKED'
                ? t('dashboard.kickedDeviceRevoked')
                : t('dashboard.kickedSessionInvalid')}
            </div>
          )}

          {/* Device limit error */}
          {deviceLimitReached && (
            <div className="mb-3 rounded-[10px] border border-[var(--danger)] bg-[var(--danger)]/5 px-3 py-2.5">
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
            <div className="mb-3 rounded-[10px] border border-[var(--danger)] bg-[var(--danger)]/5 px-3 py-2 text-[12px] text-[var(--danger)]">
              {error}
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
            <div>
              <label htmlFor="login-email" className="text-[11px] font-medium text-[var(--text-secondary)] mb-1.5 block">
                {t('login.emailLabel')}
              </label>
              <Input
                id="login-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('login.emailPlaceholder')}
                autoComplete="email"
                className="h-10"
              />
            </div>
            <div>
              <label htmlFor="login-password" className="text-[11px] font-medium text-[var(--text-secondary)] mb-1.5 block">
                {t('login.passwordLabel')}
              </label>
              <Input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('login.passwordPlaceholder')}
                autoComplete="current-password"
                className="h-10"
              />
            </div>
            <Button
              type="submit"
              disabled={submitting || !email.trim() || !password.trim()}
              className="w-full h-11 mt-1.5"
            >
              {submitting ? t('login.submitting') : t('login.submit')}
            </Button>
          </form>

          {/* Portal links */}
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-5">
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
        </section>
      </div>
    </div>
  )
}
