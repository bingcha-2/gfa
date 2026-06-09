import { useState, useEffect } from 'react'
import { useAppStore } from '@/stores/useAppStore'
import { Modal, useModal } from '@/components/Modal'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import * as api from '@/services/wails'
import { cn } from '@/lib/utils'
import { PromoSection } from '@/components/PromoSection'
import { Globe, FolderOpen, Info } from 'lucide-react'

export function SettingsPage() {
  const { config, appVersion } = useAppStore()
  const { modalProps, showAlert } = useModal()

  const [proxy, setProxy] = useState('')
  const [idePath, setIdePath] = useState('')
  const [hubPath, setHubPath] = useState('')
  const [codexAppPath, setCodexAppPath] = useState('')
  const [claudeDesktopPath, setClaudeDesktopPath] = useState('')
  const [detectedIde, setDetectedIde] = useState('')
  const [detectedHub, setDetectedHub] = useState('')
  const [detectedCodex, setDetectedCodex] = useState('')
  const [detectedClaudeDesktop, setDetectedClaudeDesktop] = useState('')

  useEffect(() => {
    loadSettings()
  }, [config])

  const loadSettings = async () => {
    if (!config) return
    setProxy(config.upstreamProxy || '')
    const paths = await api.getDetectedPaths()
    setIdePath(config.idePath || paths.idePath || '')
    setHubPath(config.hubPath || paths.hubPath || '')
    setCodexAppPath(config.codexAppPath || paths.codexAppPath || '')
    setClaudeDesktopPath(config.claudeDesktopPath || paths.claudeDesktopPath || '')
    setDetectedIde(config.idePath ? '自定义' : paths.idePath ? '已检测' : '未检测到')
    setDetectedHub(config.hubPath ? '自定义' : paths.hubPath ? '已检测' : '未检测到')
    setDetectedCodex(config.codexAppPath ? '自定义' : paths.codexAppPath ? '已检测' : '未检测到')
    setDetectedClaudeDesktop(config.claudeDesktopPath ? '自定义' : paths.claudeDesktopPath ? '已检测' : '未检测到')
  }

  const handleSaveProxy = async () => {
    if (!config) return
    try {
      await useAppStore.getState().saveConfig({ ...config, upstreamProxy: proxy.trim() })
      await showAlert('保存成功', '前置代理设置已保存并生效。')
    } catch (err) {
      await showAlert('保存失败', String(err))
    }
  }

  const handleBrowseIde = async () => {
    const path = await api.browseForPath('选择 Antigravity IDE 安装目录')
    if (path) setIdePath(path)
  }

  const handleBrowseHub = async () => {
    const path = await api.browseForPath('选择 Antigravity Hub 安装目录')
    if (path) setHubPath(path)
  }

  const handleBrowseCodex = async () => {
    const path = await api.browseForPath('选择 Codex App 路径')
    if (path) setCodexAppPath(path)
  }

  const handleBrowseClaudeDesktop = async () => {
    const path = await api.browseForPath('选择 Claude 桌面端程序 (Claude.app / Claude.exe)')
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
      await showAlert('保存成功', '安装路径已保存。')
    } catch (err) {
      await showAlert('保存失败', String(err))
    }
  }

  return (
    <div className="max-w-[620px] pt-1">
      {/* Upstream Proxy */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle><Globe size={15} /> 前置代理</CardTitle>
        </CardHeader>
        <CardContent>
          <Input
            value={proxy}
            onChange={(e) => setProxy(e.target.value)}
            placeholder="例: http://127.0.0.1:7890 (留空直连)"
            className="mb-3"
          />
          <Button variant="secondary" onClick={handleSaveProxy} className="w-full">保存</Button>
        </CardContent>
      </Card>

      {/* Install Paths */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle><FolderOpen size={15} /> 安装路径</CardTitle>
          <p className="text-[11px] text-[var(--text-muted)]">自动检测或手动选择安装目录</p>
        </CardHeader>
        <CardContent>
          {/* IDE path */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[12px] text-[var(--text-secondary)] font-medium">Antigravity IDE</span>
              <span className={cn('text-[10px] font-semibold', detectedIde === '已检测' ? 'text-[var(--success)]' : 'text-[var(--text-muted)]')}>{detectedIde}</span>
            </div>
            <div className="flex gap-2">
              <Input value={idePath} readOnly placeholder="未检测到" className="flex-1 text-[12px] font-mono" />
              <Button variant="secondary" onClick={handleBrowseIde}>浏览</Button>
            </div>
          </div>

          {/* Hub path */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[12px] text-[var(--text-secondary)] font-medium">Antigravity Hub</span>
              <span className={cn('text-[10px] font-semibold', detectedHub === '已检测' ? 'text-[var(--success)]' : 'text-[var(--text-muted)]')}>{detectedHub}</span>
            </div>
            <div className="flex gap-2">
              <Input value={hubPath} readOnly placeholder="未检测到" className="flex-1 text-[12px] font-mono" />
              <Button variant="secondary" onClick={handleBrowseHub}>浏览</Button>
            </div>
          </div>

          {/* Codex app path */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[12px] text-[var(--text-secondary)] font-medium">Codex App</span>
              <span className={cn('text-[10px] font-semibold', detectedCodex === '已检测' ? 'text-[var(--success)]' : 'text-[var(--text-muted)]')}>{detectedCodex}</span>
            </div>
            <div className="flex gap-2">
              <Input value={codexAppPath} readOnly placeholder="未检测到" className="flex-1 text-[12px] font-mono" />
              <Button variant="secondary" onClick={handleBrowseCodex}>浏览</Button>
            </div>
          </div>

          {/* Claude Desktop path —— 自动检测漏检/提权偏移时的逃生口,免「先开 Claude 才识别」 */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[12px] text-[var(--text-secondary)] font-medium">Claude 桌面端</span>
              <span className={cn('text-[10px] font-semibold', detectedClaudeDesktop === '已检测' ? 'text-[var(--success)]' : 'text-[var(--text-muted)]')}>{detectedClaudeDesktop}</span>
            </div>
            <div className="flex gap-2">
              <Input value={claudeDesktopPath} readOnly placeholder="未检测到(可手动指定,无需先打开 Claude)" className="flex-1 text-[12px] font-mono" />
              <Button variant="secondary" onClick={handleBrowseClaudeDesktop}>浏览</Button>
            </div>
          </div>

          <Button variant="secondary" onClick={handleSavePaths} className="w-full">保存路径</Button>
        </CardContent>
      </Card>

      {/* Promo cards */}
      <div className="mb-4">
        <PromoSection />
      </div>

      {/* About */}
      <Card>
        <CardHeader>
          <CardTitle><Info size={15} /> 关于</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-muted)]">版本</span>
              <span className="text-[var(--text-primary)] font-mono-data font-semibold">v{appVersion}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-muted)]">设备 ID</span>
              <span className="text-[var(--text-secondary)] font-mono-data text-[10px]">{config?.deviceId || '-'}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Modal {...modalProps} />
    </div>
  )
}
