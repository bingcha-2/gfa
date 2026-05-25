import { useAppStore } from '@/stores/useAppStore'
import { Megaphone, ExternalLink } from 'lucide-react'
import * as api from '@/services/wails'

const ADS = [
  { text: '🔥 9.9元起 Codex plus号和12元代试用Plus，下单最高可获88元现金红包！', link: 'https://bcai.store' },
  { text: '🎁 购买冰茶AI产品 — 一键代理 Antigravity / Codex / Cursor / Windsurf', link: 'https://bcai.store' },
  { text: '⚡ 冰茶API已上线 — 支持 Claude / Gemini / GPT 低价调用', link: 'https://api.bcai.site' },
]

export function AnnouncementBar() {
  const announcement = useAppStore((s) => s.announcement)

  // Combine server announcements + built-in ads
  const items = announcement ? [{ text: `📢 ${announcement}`, link: '' }, ...ADS] : ADS

  return (
    <div className="flex items-center gap-2 px-4 py-2.5 mb-4 rounded-[10px] bg-gradient-to-r from-blue-50 to-cyan-50 border border-blue-100/60 overflow-hidden">
      <Megaphone size={14} className="text-[var(--primary)] flex-shrink-0" />

      {/* Marquee container */}
      <div className="flex-1 overflow-hidden relative h-[24px]">
        <div className="flex items-center gap-14 animate-marquee whitespace-nowrap absolute h-full">
          {[...items, ...items].map((item, i) => (
            <button
              key={i}
              onClick={() => item.link && api.openURL(item.link)}
              className={`text-[13px] font-medium inline-flex items-center gap-1.5 transition-colors ${
                item.link
                  ? 'text-[var(--text-secondary)] hover:text-[var(--primary)] cursor-pointer'
                  : 'text-[var(--text-secondary)] cursor-default'
              }`}
            >
              {item.text}
              {item.link && <ExternalLink size={10} className="opacity-40" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
