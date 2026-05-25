import { useAppStore } from '@/stores/useAppStore'
import { Megaphone } from 'lucide-react'

/**
 * 公告栏 — 经典跑马灯：文字从右侧进入，匀速滑过，从左侧离开，循环往复
 */
export function AnnouncementBar() {
  const announcement = useAppStore((s) => s.announcement)
  const text = announcement || '欢迎使用冰茶AI'

  return (
    <div className="flex items-center gap-2 px-4 py-2 mb-4 rounded-[10px] bg-gradient-to-r from-blue-50 to-cyan-50 border border-blue-100/60 overflow-hidden">
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
