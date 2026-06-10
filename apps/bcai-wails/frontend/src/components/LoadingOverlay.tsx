import { Loader2 } from 'lucide-react'

/**
 * 全屏 loading 遮罩。用于接管/还原这类有数秒延迟(改文件 + 拉起 app)的操作,
 * 期间锁住交互并给出明确反馈。
 *
 * ⚠ z-index:本遮罩 z-overlay(70) 高于 Dialog 的 z-modal(60)。因此【弹任何结果/错误
 * 弹窗之前,必须先把 show 置 false(调用方 setBusy(null))】,否则遮罩会盖住弹窗,用户只看到
 * 转圈、看不到下面的提示与按钮。调用方(runTakeover)已在每个弹窗分支前先关遮罩。
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
