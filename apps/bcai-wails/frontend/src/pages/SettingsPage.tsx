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
import { GitHubIcon } from '@/components/GitHubIcon'
import { GITHUB_ISSUES_URL } from '@/lib/feedback'
import { FolderOpen, Info, Languages } from 'lucide-react'

export function SettingsPage() {
  const t = useT()
  const { config, appVersion } = useAppStore()
  const { modalProps, showAlert } = useModal()
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
              <Input value={codexAppPath} readOnly placeholder={t('common.notDetected')} className="flex-1 text-[12px] font-mono" />
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
              <span className="text-[var(--text-muted)]">{t('settings.feedbackLabel')}</span>
              <Button size="sm" variant="ghost" onClick={() => api.openURL(GITHUB_ISSUES_URL)} className="h-7 gap-1.5 px-2">
                <GitHubIcon size={13} /> {t('settings.feedbackBtn')}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Modal {...modalProps} />
    </div>
  )
}
