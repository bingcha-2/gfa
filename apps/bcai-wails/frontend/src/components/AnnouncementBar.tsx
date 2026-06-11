import { useAppStore } from '@/stores/useAppStore'
import { Megaphone } from 'lucide-react'
import { useT } from '@/i18n'

/**
 * 公告栏 — 经典跑马灯：文字从右侧进入，匀速滑过，从左侧离开，循环往复
 */
export function AnnouncementBar() {
  const t = useT()
  const announcement = useAppStore((s) => s.announcement)
  const text = announcement || t('announcement.welcome')

  return (
    <div className="flex items-center gap-2 px-4 py-2 mb-4 rounded-[12px] bg-[var(--bg-secondary)] border border-[var(--border-light)] overflow-hidden">
      <Megaphone size={14} className="text-[var(--primary)] flex-shrink-0" />
      <div className="flex-1 overflow-hidden h-[22px]">
        <div className="animate-marquee whitespace-nowrap leading-[22px]">
          <span className="text-[13px] font-medium text-[var(--text-secondary)]">
            📢 {text}
          </span>
        </div>
      </div>
    </div>
  )
}
