import { useAppStore } from '@/stores/useAppStore'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Download, RefreshCw, CheckCircle, AlertTriangle } from 'lucide-react'
import * as api from '@/services/wails'

export function UpdateBanner() {
  const updateStatus = useAppStore((s) => s.updateStatus)
  if (!updateStatus || !updateStatus.status || updateStatus.status === 'idle' || updateStatus.status === 'checking') return null

  const { status, version, percent, error } = updateStatus

  if (status === 'available') {
    return (
      <div className="flex items-center justify-between px-4 py-2.5 mb-4 rounded-[12px] border border-blue-200 bg-blue-50/80 shadow-sm">
        <div className="flex items-center gap-2 text-[13px]">
          <Download size={15} className="text-[var(--primary)]" />
          <span className="text-[var(--text-primary)] font-medium">新版本 v{version} 可用</span>
        </div>
        <Button size="sm" onClick={() => api.downloadUpdate()}>立即更新</Button>
      </div>
    )
  }

  if (status === 'downloading') {
    return (
      <div className="px-4 py-3 mb-4 rounded-[12px] border border-blue-200 bg-blue-50/80 shadow-sm">
        <div className="flex items-center gap-2 text-[13px] mb-2">
          <RefreshCw size={15} className="text-[var(--primary)] animate-spin" />
          <span className="text-[var(--text-primary)] font-medium">正在下载 v{version}... {Math.round(percent || 0)}%</span>
        </div>
        <Progress value={percent || 0} />
      </div>
    )
  }

  if (status === 'ready') {
    return (
      <div className="flex items-center justify-between px-4 py-2.5 mb-4 rounded-[12px] border border-green-200 bg-green-50/80 shadow-sm">
        <div className="flex items-center gap-2 text-[13px]">
          <CheckCircle size={15} className="text-[var(--success)]" />
          <span className="text-[var(--text-primary)] font-medium">更新 v{version} 已就绪</span>
        </div>
        <Button size="sm" variant="success" onClick={() => api.restartToUpdate()}>重启应用</Button>
      </div>
    )
  }

  if (status === 'error' && error) {
    return (
      <div className="flex items-center justify-between px-4 py-2.5 mb-4 rounded-[12px] border border-red-200 bg-red-50/80 shadow-sm">
        <div className="flex items-center gap-2 text-[13px]">
          <AlertTriangle size={15} className="text-[var(--danger)]" />
          <span className="text-[var(--text-secondary)] truncate">更新失败: {error}</span>
        </div>
        <Button size="sm" variant="secondary" onClick={() => api.checkForUpdate()}>重试</Button>
      </div>
    )
  }

  return null
}
