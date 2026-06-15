import { useState, useEffect } from 'react'
import { useAppStore } from '@/stores/useAppStore'
import { Modal, useModal } from '@/components/Modal'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import * as api from '@/services/wails'
import { cn } from '@/lib/utils'
import { PromoSection } from '@/components/PromoSection'
import { useT, useLocaleStore, SUPPORTED_LOCALES, LOCALE_NAMES } from '@/i18n'
import { getChangelogRecord } from '@/lib/changelog'
import { FolderOpen, Info, Languages, LogOut, MessageSquare, ScrollText, User } from 'lucide-react'

export function SettingsPage() {
  const t = useT()
  const { config, appVersion, updateStatus, account, logout } = useAppStore()
  const { modalProps, showAlert, showConfirm } = useModal()
  const [loggingOut, setLoggingOut] = useState(false)

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

  // 当前版本的更新内容:优先本地留存(更新前记下的),其次后台检查返回的
  // up-to-date 状态(服务端 latest == 当前版本),最后现场触发一次检查。
  const handleViewChangelog = async () => {
    const rec = getChangelogRecord()
    let text = ''
    if (rec && rec.version === appVersion && rec.changelog.trim()) {
      text = rec.changelog
    } else if (updateStatus?.changelog?.trim()) {
      text = updateStatus.changelog
    } else {
      try {
        const resp = await api.checkForUpdate()
        if (typeof resp?.changelog === 'string') text = resp.changelog
      } catch { /* 网络失败走兜底文案 */ }
    }
    await showAlert(
      t('settings.changelogModalTitle', { version: appVersion }),
      text.trim() || t('update.noChangelog'),
    )
  }
  const locale = useLocaleStore((s) => s.locale)
  const setLocale = useLocaleStore((s) => s.setLocale)

  const [idePath, setIdePath] = useState('')
  const [hubPath, setHubPath] = useState('')
  const [codexAppPath, setCodexAppPath] = useState('')
  const [claudeDesktopPath, setClaudeDesktopPath] = useState('')
  const [detectedIde, setDetectedIde] = useState<'custom' | 'detected' | 'none' | ''>('')
  const [detectedHub, setDetectedHub] = useState<'custom' | 'detected' | 'none' | ''>('')
  const [detectedCodex, setDetectedCodex] = useState<'custom' | 'detected' | 'none' | ''>('')
  const [detectedClaudeDesktop, setDetectedClaudeDesktop] = useState<'custom' | 'detected' | 'none' | ''>('')

  useEffect(() => {
    loadSettings()
  }, [config])

  const loadSettings = async () => {
    if (!config) return
    const paths = await api.getDetectedPaths()
    setIdePath(config.idePath || paths.idePath || '')
    setHubPath(config.hubPath || paths.hubPath || '')
    setCodexAppPath(config.codexAppPath || paths.codexAppPath || '')
    setClaudeDesktopPath(config.claudeDesktopPath || paths.claudeDesktopPath || '')
    setDetectedIde(config.idePath ? 'custom' : paths.idePath ? 'detected' : 'none')
    setDetectedHub(config.hubPath ? 'custom' : paths.hubPath ? 'detected' : 'none')
    setDetectedCodex(config.codexAppPath ? 'custom' : paths.codexAppPath ? 'detected' : 'none')
    setDetectedClaudeDesktop(config.claudeDesktopPath ? 'custom' : paths.claudeDesktopPath ? 'detected' : 'none')
  }

  // 检测状态 → 展示文案
  const detectedLabel = (s: 'custom' | 'detected' | 'none' | '') =>
    s === 'custom' ? t('common.custom') : s === 'detected' ? t('common.detected') : s === 'none' ? t('common.notDetected') : ''

  const handleBrowseIde = async () => {
    const path = await api.browseForPath(t('settings.browseIde'))
    if (path) setIdePath(path)
  }

  const handleBrowseHub = async () => {
    const path = await api.browseForPath(t('settings.browseHub'))
    if (path) setHubPath(path)
  }

  const handleBrowseCodex = async () => {
    const path = await api.browseForPath(t('settings.browseCodex'))
    if (path) setCodexAppPath(path)
  }

  const handleBrowseClaudeDesktop = async () => {
    const path = await api.browseForPath(t('settings.browseClaudeDesktop'))
    if (path) setClaudeDesktopPath(path)
  }

  const handleSavePaths = async () => {
    if (!config) return
    try {
      await useAppStore.getState().saveConfig({
        ...config,
        idePath: idePath.trim(),
        hubPath: hubPath.trim(),
        codexAppPath: codexAppPath.trim(),
        claudeDesktopPath: claudeDesktopPath.trim(),
      })
      await useAppStore.getState().fetchIDEStatus()
      await showAlert(t('settings.saveOk'), t('settings.pathsSaved'))
    } catch (err) {
      await showAlert(t('settings.saveFailed'), String(err))
    }
  }

  return (
    <div className="max-w-[620px] pt-1">
      {/* Language */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle><Languages size={15} /> {t('settings.languageTitle')}</CardTitle>
          <p className="text-[11px] text-[var(--text-muted)]">{t('settings.languageSubtitle')}</p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-2">
            {SUPPORTED_LOCALES.map((l) => (
              <button
                key={l}
                onClick={() => setLocale(l)}
                className={cn(
                  'h-9 rounded-[8px] border text-[12px] font-medium transition-colors cursor-pointer',
                  l === locale
                    ? 'border-[var(--primary)] bg-[var(--primary-light)] text-[var(--primary-strong)] font-semibold'
                    : 'border-[var(--border-light)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]',
                )}
              >
                {LOCALE_NAMES[l]}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Install Paths */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle><FolderOpen size={15} /> {t('settings.pathsTitle')}</CardTitle>
          <p className="text-[11px] text-[var(--text-muted)]">{t('settings.pathsSubtitle')}</p>
        </CardHeader>
        <CardContent>
          {/* IDE path */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[12px] text-[var(--text-secondary)] font-medium">Antigravity IDE</span>
              <span className={cn('text-[10px] font-semibold', detectedIde === 'detected' ? 'text-[var(--success)]' : 'text-[var(--text-muted)]')}>{detectedLabel(detectedIde)}</span>
            </div>
            <div className="flex gap-2">
              <Input value={idePath} readOnly placeholder={t('common.notDetected')} className="flex-1 text-[12px] font-mono" />
              <Button variant="secondary" onClick={handleBrowseIde}>{t('common.browse')}</Button>
            </div>
          </div>

          {/* Hub path */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[12px] text-[var(--text-secondary)] font-medium">Antigravity Hub</span>
              <span className={cn('text-[10px] font-semibold', detectedHub === 'detected' ? 'text-[var(--success)]' : 'text-[var(--text-muted)]')}>{detectedLabel(detectedHub)}</span>
            </div>
            <div className="flex gap-2">
              <Input value={hubPath} readOnly placeholder={t('common.notDetected')} className="flex-1 text-[12px] font-mono" />
              <Button variant="secondary" onClick={handleBrowseHub}>{t('common.browse')}</Button>
            </div>
          </div>

          {/* Codex app path */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[12px] text-[var(--text-secondary)] font-medium">Codex App</span>
              <span className={cn('text-[10px] font-semibold', detectedCodex === 'detected' ? 'text-[var(--success)]' : 'text-[var(--text-muted)]')}>{detectedLabel(detectedCodex)}</span>
            </div>
            <div className="flex gap-2">
              <Input value={codexAppPath} onChange={(e) => setCodexAppPath(e.target.value)}
                placeholder={t('common.notDetected')} className="flex-1 text-[12px] font-mono" />
              <Button variant="secondary" onClick={handleBrowseCodex}>{t('common.browse')}</Button>
            </div>
          </div>

          {/* Claude Desktop path —— 自动检测漏检/提权偏移时的逃生口,免「先开 Claude 才识别」 */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[12px] text-[var(--text-secondary)] font-medium">{t('settings.claudeDesktopLabel')}</span>
              <span className={cn('text-[10px] font-semibold', detectedClaudeDesktop === 'detected' ? 'text-[var(--success)]' : 'text-[var(--text-muted)]')}>{detectedLabel(detectedClaudeDesktop)}</span>
            </div>
            <div className="flex gap-2">
              <Input value={claudeDesktopPath} readOnly placeholder={t('settings.claudeDesktopPlaceholder')} className="flex-1 text-[12px] font-mono" />
              <Button variant="secondary" onClick={handleBrowseClaudeDesktop}>{t('common.browse')}</Button>
            </div>
          </div>

          <Button variant="secondary" onClick={handleSavePaths} className="w-full">{t('settings.savePaths')}</Button>
        </CardContent>
      </Card>

      {/* Promo cards */}
      <div className="mb-4">
        <PromoSection />
      </div>

      {/* Account */}
      {account && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle><User size={15} /> {t('account.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-2">
              {account.email && (
                <div className="flex items-center justify-between">
                  <span className="text-[var(--text-muted)]">{t('account.email')}</span>
                  <span className="text-[var(--text-secondary)] font-mono-data text-[12px]">{account.email}</span>
                </div>
              )}
              {account.planName && (
                <div className="flex items-center justify-between">
                  <span className="text-[var(--text-muted)]">{t('account.plan')}</span>
                  <span className="text-[var(--text-secondary)] text-[12px]">{account.planName}</span>
                </div>
              )}
              <div className="flex items-center justify-between mt-1">
                <span className="text-[var(--text-muted)]">{t('account.manageDevices')}</span>
                <Button size="sm" variant="ghost" onClick={() => api.openURL(api.PORTAL_URLS.devices)} className="h-7 px-2">
                  {t('account.manageDevices')}
                </Button>
              </div>
              <Button
                variant="ghost"
                onClick={handleLogout}
                disabled={loggingOut}
                className="w-full mt-1 text-[var(--danger)] hover:text-[var(--danger)] hover:bg-[var(--danger)]/5 gap-2"
              >
                <LogOut size={14} />
                {loggingOut ? '...' : t('account.logout')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* About */}
      <Card>
        <CardHeader>
          <CardTitle><Info size={15} /> {t('settings.aboutTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-muted)]">{t('settings.version')}</span>
              <span className="text-[var(--text-primary)] font-mono-data font-semibold">v{appVersion}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-muted)]">{t('settings.deviceId')}</span>
              <span className="text-[var(--text-secondary)] font-mono-data text-[10px]">{config?.deviceId || '-'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-muted)]">{t('settings.changelogLabel')}</span>
              <Button size="sm" variant="ghost" onClick={handleViewChangelog} className="h-7 gap-1.5 px-2">
                <ScrollText size={13} /> {t('settings.changelogBtn')}
              </Button>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-muted)]">{t('settings.feedbackLabel')}</span>
              <Button size="sm" variant="ghost" onClick={() => api.openURL(api.PORTAL_URLS.home)} className="h-7 gap-1.5 px-2">
                <MessageSquare size={13} /> {t('settings.feedbackBtn')}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Modal {...modalProps} />
    </div>
  )
}
