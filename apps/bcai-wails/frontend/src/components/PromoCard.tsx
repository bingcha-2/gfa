import { ArrowUpRight } from 'lucide-react'
import * as api from '@/services/wails'

const ADS = [
  {
    emoji: '🔥',
    title: '9.9 元起 Codex Plus',
    desc: '下单最高可获 88 元红包',
    cta: '立即抢购',
    link: 'https://bcai.store',
    gradient: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)',
  },
  {
    emoji: '🎁',
    title: '冰茶 AI 全家桶',
    desc: 'Codex · Cursor · Windsurf',
    cta: '去看看',
    link: 'https://bcai.store',
    gradient: 'linear-gradient(135deg, #0891b2 0%, #2563eb 100%)',
  },
  {
    emoji: '⚡',
    title: '冰茶 API',
    desc: 'Claude / Gemini / GPT',
    cta: '了解更多',
    link: 'https://api.bcai.site',
    gradient: 'linear-gradient(135deg, #e11d48 0%, #f97316 100%)',
  },
]

/**
 * 全宽 3 列广告 — 常驻显示
 */
export function PromoCard() {
  return (
    <div className="grid grid-cols-3 gap-3">
      {ADS.map((ad) => (
        <button
          key={ad.link + ad.emoji}
          onClick={() => api.openURL(ad.link)}
          className="group relative overflow-hidden rounded-[14px] p-4 text-left transition-all duration-300 hover:shadow-xl hover:scale-[1.02] active:scale-[0.98]"
          style={{ background: ad.gradient }}
        >
          {/* Glow decorations */}
          <div className="absolute -top-5 -right-5 w-24 h-24 rounded-full bg-white/10 blur-xl group-hover:bg-white/20 transition-all duration-500" />
          <div className="absolute bottom-1 left-1 w-14 h-14 rounded-full bg-white/5 blur-md" />

          <div className="relative">
            <div className="text-[26px] mb-2">{ad.emoji}</div>
            <div className="text-[14px] font-bold text-white leading-tight mb-1">{ad.title}</div>
            <div className="text-[11px] text-white/65 leading-snug mb-3">{ad.desc}</div>
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/20 backdrop-blur-sm text-[11px] font-bold text-white transition-all group-hover:bg-white/30 group-hover:gap-2">
              {ad.cta} <ArrowUpRight size={11} className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </div>
          </div>
        </button>
      ))}
    </div>
  )
}
