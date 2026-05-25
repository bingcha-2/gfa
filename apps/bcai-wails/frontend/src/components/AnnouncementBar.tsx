import { useAppStore } from '@/stores/useAppStore'
import { Megaphone } from 'lucide-react'

/**
 * 纯服务器公告栏 — 无公告时隐藏
 */
export function AnnouncementBar() {
  const announcement = useAppStore((s) => s.announcement)

  if (!announcement) return null

  return (
    <div className="flex items-center gap-2 px-4 py-2 mb-4 rounded-[10px] bg-gradient-to-r from-blue-50 to-cyan-50 border border-blue-100/60 overflow-hidden">
      <Megaphone size={14} className="text-[var(--primary)] flex-shrink-0" />
      <div className="flex-1 overflow-hidden relative h-[22px]">
        <div className="flex items-center animate-marquee whitespace-nowrap absolute h-full">
          <span className="text-[13px] font-medium text-[var(--text-secondary)]">
            📢 {announcement}
          </span>
        </div>
      </div>
    </div>
  )
}
