import { useState, useEffect } from 'react'
import { useAppStore } from '@/stores/useAppStore'
import { Modal, useModal } from '@/components/Modal'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import * as api from '@/services/wails'
import { cn } from '@/lib/utils'
import { Settings as SettingsIcon, Globe, FolderOpen, Info, ArrowUpRight } from 'lucide-react'

export function SettingsPage() {
  const { config, appVersion, fetchConfig } = useAppStore()
  const { modalProps, showAlert } = useModal()

  const [proxy, setProxy] = useState('')
  const [idePath, setIdePath] = useState('')
  const [hubPath, setHubPath] = useState('')
  const [detectedIde, setDetectedIde] = useState('')
  const [detectedHub, setDetectedHub] = useState('')

  useEffect(() => {
    loadSettings()
  }, [config])

  const loadSettings = async () => {
    if (!config) return
    setProxy(config.upstreamProxy || '')
    const paths = await api.getDetectedPaths()
    setIdePath(config.idePath || paths.idePath || '')
    setHubPath(config.hubPath || paths.hubPath || '')
    setDetectedIde(config.idePath ? '自定义' : paths.idePath ? '已检测' : '未检测到')
    setDetectedHub(config.hubPath ? '自定义' : paths.hubPath ? '已检测' : '未检测到')
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

  const handleSavePaths = async () => {
    if (!config) return
    try {
      await useAppStore.getState().saveConfig({ ...config, idePath: idePath.trim(), hubPath: hubPath.trim() })
      await useAppStore.getState().fetchIDEStatus()
      await showAlert('保存成功', '安装路径已保存。')
    } catch (err) {
      await showAlert('保存失败', String(err))
    }
  }

  return (
    <div className="max-w-[620px]">
      <h2 className="text-[18px] font-bold text-[var(--text-primary)] mb-4 flex items-center gap-2">
        <SettingsIcon size={20} /> 设置
      </h2>

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

          <Button variant="secondary" onClick={handleSavePaths} className="w-full">保存路径</Button>
        </CardContent>
      </Card>

      {/* Promo cards */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <button
          onClick={() => api.openURL('https://bcai.store')}
          className="group relative overflow-hidden rounded-[14px] p-4 text-left transition-all duration-300 hover:scale-[1.02] hover:shadow-xl active:scale-[0.98]"
          style={{ background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a78bfa 100%)' }}
        >
          <div className="absolute inset-0 bg-gradient-to-br from-white/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          <div className="absolute -top-4 -right-4 w-20 h-20 rounded-full bg-white/10 blur-xl" />
          <div className="relative">
            <div className="text-[22px] mb-2">🛒</div>
            <div className="text-[14px] font-bold text-white leading-tight mb-1">冰茶商店</div>
            <div className="text-[11px] text-white/75 leading-snug mb-3">Codex Plus · Cursor Pro · Windsurf 一键代理，9.9 元起</div>
            <div className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/20 backdrop-blur-sm text-[10px] font-semibold text-white">
              立即选购 <ArrowUpRight size={10} />
            </div>
          </div>
        </button>

        <button
          onClick={() => api.openURL('https://bcai.online')}
          className="group relative overflow-hidden rounded-[14px] p-4 text-left transition-all duration-300 hover:scale-[1.02] hover:shadow-xl active:scale-[0.98]"
          style={{ background: 'linear-gradient(135deg, #f59e0b 0%, #f97316 50%, #ef4444 100%)' }}
        >
          <div className="absolute inset-0 bg-gradient-to-br from-white/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          <div className="absolute -top-4 -right-4 w-20 h-20 rounded-full bg-white/10 blur-xl" />
          <div className="relative">
            <div className="text-[22px] mb-2">⚡</div>
            <div className="text-[14px] font-bold text-white leading-tight mb-1">冰茶 API</div>
            <div className="text-[11px] text-white/75 leading-snug mb-3">Claude / Gemini / GPT 低价调用，企业级稳定</div>
            <div className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/20 backdrop-blur-sm text-[10px] font-semibold text-white">
              了解更多 <ArrowUpRight size={10} />
            </div>
          </div>
        </button>
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
