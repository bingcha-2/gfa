import { Loader2 } from 'lucide-react'

/**
 * 全屏 loading 遮罩。用于接管/还原这类有数秒延迟(改文件 + 拉起 app)的操作,
 * 期间锁住交互并给出明确反馈。z-[60] 高于 Dialog(z-50);但操作结束后才会弹
 * 结果/错误弹窗,二者不会同时出现。
 */
export function LoadingOverlay({ show, label }: { show: boolean; label?: string }) {
  if (!show) return null
  return (
    <div className="fixed inset-0 z-[var(--z-overlay)] flex items-center justify-center bg-black/40">
      <div className="flex flex-col items-center gap-3 rounded-[16px] bg-[var(--bg-secondary)] px-8 py-6 shadow-[var(--shadow-lg)] border border-[var(--border)]">
        <Loader2 size={28} className="animate-spin text-[var(--primary)]" />
        <span className="text-[13px] font-medium text-[var(--text-primary)]">{label || '处理中...'}</span>
      </div>
    </div>
  )
}
