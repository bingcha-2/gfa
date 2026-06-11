import { useAppStore } from '@/stores/useAppStore'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Download, RefreshCw, CheckCircle, AlertTriangle } from 'lucide-react'
import * as api from '@/services/wails'
import { useT } from '@/i18n'

export function UpdateBanner() {
  const t = useT()
  const updateStatus = useAppStore((s) => s.updateStatus)
  if (!updateStatus || !updateStatus.status || updateStatus.status === 'idle' || updateStatus.status === 'checking') return null

  const { status, version, percent, error } = updateStatus

  if (status === 'available') {
    return (
      <div className="flex items-center justify-between px-4 py-2.5 mb-4 rounded-[12px] border border-[var(--border)] bg-[var(--bg-secondary)] shadow-[var(--shadow-sm)]">
        <div className="flex items-center gap-2 text-[13px]">
          <Download size={15} className="text-[var(--primary)]" />
          <span className="text-[var(--text-primary)] font-medium">{t('update.available', { version })}</span>
        </div>
        <Button size="sm" onClick={() => api.downloadUpdate()}>{t('update.updateNow')}</Button>
      </div>
    )
  }

  if (status === 'downloading') {
    return (
      <div className="px-4 py-3 mb-4 rounded-[12px] border border-[var(--border)] bg-[var(--bg-secondary)] shadow-[var(--shadow-sm)]">
        <div className="flex items-center gap-2 text-[13px] mb-2">
          <RefreshCw size={15} className="text-[var(--primary)] animate-spin" />
          <span className="text-[var(--text-primary)] font-medium">{t('update.downloading', { version, percent: Math.round(percent || 0) })}</span>
        </div>
        <Progress value={percent || 0} />
      </div>
    )
  }

  if (status === 'ready') {
    return (
      <div className="flex items-center justify-between px-4 py-2.5 mb-4 rounded-[12px] border border-[color-mix(in_srgb,var(--success)_35%,var(--border))] bg-[color-mix(in_srgb,var(--success)_10%,var(--bg-secondary))] shadow-[var(--shadow-sm)]">
        <div className="flex items-center gap-2 text-[13px]">
          <CheckCircle size={15} className="text-[var(--success)]" />
          <span className="text-[var(--text-primary)] font-medium">{t('update.ready', { version })}</span>
        </div>
        <Button size="sm" variant="success" onClick={() => api.restartToUpdate()}>{t('update.restart')}</Button>
      </div>
    )
  }

  if (status === 'error' && error) {
    return (
      <div className="flex items-center justify-between px-4 py-2.5 mb-4 rounded-[12px] border border-[color-mix(in_srgb,var(--danger)_35%,var(--border))] bg-[color-mix(in_srgb,var(--danger)_10%,var(--bg-secondary))] shadow-[var(--shadow-sm)]">
        <div className="flex items-center gap-2 text-[13px]">
          <AlertTriangle size={15} className="text-[var(--danger)]" />
          <span className="text-[var(--text-secondary)] truncate">{t('update.failed', { error })}</span>
        </div>
        <Button size="sm" variant="secondary" onClick={() => api.checkForUpdate()}>{t('update.retry')}</Button>
      </div>
    )
  }

  return null
}
