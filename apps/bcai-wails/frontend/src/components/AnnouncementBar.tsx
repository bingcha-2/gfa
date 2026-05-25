import { useAppStore } from '@/stores/useAppStore'
import { Megaphone } from 'lucide-react'

/**
 * 公告栏 — 始终显示，无公告时显示默认文案
 */
export function AnnouncementBar() {
  const announcement = useAppStore((s) => s.announcement)
  const text = announcement || '欢迎使用冰茶AI'

  return (
    <div className="flex items-center gap-2 px-4 py-2 mb-4 rounded-[10px] bg-gradient-to-r from-blue-50 to-cyan-50 border border-blue-100/60 overflow-hidden">
      <Megaphone size={14} className="text-[var(--primary)] flex-shrink-0" />
      <div className="flex-1 overflow-hidden relative h-[22px]">
        <div className="flex items-center animate-marquee whitespace-nowrap absolute h-full">
          <span className="text-[13px] font-medium text-[var(--text-secondary)]">
            📢 {text}
          </span>
        </div>
      </div>
    </div>
  )
}
