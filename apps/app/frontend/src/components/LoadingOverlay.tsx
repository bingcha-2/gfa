import { Loader2 } from 'lucide-react'
import { t } from '@/i18n'

/**
 * 全屏 loading 遮罩。用于接管/还原这类有数秒延迟(改文件 + 拉起 app)的操作,
 * 期间锁住交互并给出明确反馈。
 *
 * z-index 用 --z-loading(45),【低于】Dialog:遮罩与弹窗同时挂着是常态(接管中心的遮罩由
 * busy 与 hostBusy 两个独立开关驱动,任一为真就显示),排在弹窗之上就会把错误弹窗整个盖住 ——
 * 这曾是真事故:用户只看到「正在接管…」转圈,看不到底下的失败原因。
 * 曾靠「弹窗前必须先关遮罩」的口头契约兜底,但跨两个状态源的契约必然被漏,故改用 z 从根上保证。
 */
export function LoadingOverlay({ show, label }: { show: boolean; label?: string }) {
  if (!show) return null
  return (
    <div className="fixed inset-0 z-[var(--z-loading)] flex items-center justify-center bg-black/40">
      <div className="flex flex-col items-center gap-3 rounded-[16px] bg-[var(--bg-secondary)] px-8 py-6 shadow-[var(--shadow-lg)] border border-[var(--border)]">
        <Loader2 size={28} className="animate-spin text-[var(--primary)]" />
        <span className="text-[13px] font-medium text-[var(--text-primary)]">{label || t('common.processing')}</span>
      </div>
    </div>
  )
}
