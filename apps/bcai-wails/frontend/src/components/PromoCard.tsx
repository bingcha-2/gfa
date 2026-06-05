import { ArrowUpRight } from 'lucide-react'
import * as api from '@/services/wails'

const ADS = [
  {
    emoji: '🛒',
    title: '冰茶商店',
    desc: 'Codex Plus · Cursor · Windsurf 一键代理',
    cta: '立即选购',
    link: 'https://bcai.store',
    gradient: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)',
  },
  {
    emoji: '⚡',
    title: '冰茶 API',
    desc: 'Claude / Gemini / GPT 低价调用',
    cta: '了解更多',
    link: 'https://api.bcai.space',
    gradient: 'linear-gradient(135deg, #e11d48 0%, #f97316 100%)',
  },
]

/**
 * 全宽 2 列广告 — 常驻显示
 */
export function PromoCard() {
  return (
    <div className="grid grid-cols-2 gap-3">
      {ADS.map((ad) => (
        <button
          key={ad.link}
          onClick={() => api.openURL(ad.link)}
          className="group relative overflow-hidden rounded-[12px] px-4 py-3 text-left transition-all duration-300 hover:shadow-lg hover:scale-[1.02] active:scale-[0.98]"
          style={{ background: ad.gradient }}
        >
          <div className="absolute -top-4 -right-4 w-20 h-20 rounded-full bg-white/10 blur-xl group-hover:bg-white/20 transition-all duration-500" />
          <div className="relative flex items-center gap-3">
            <span className="text-[22px] flex-shrink-0">{ad.emoji}</span>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-bold text-white leading-tight">{ad.title}</div>
              <div className="text-[11px] text-white/65 truncate">{ad.desc}</div>
            </div>
            <div className="flex-shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/20 backdrop-blur-sm text-[10px] font-bold text-white group-hover:bg-white/30 transition-all">
              {ad.cta} <ArrowUpRight size={10} />
            </div>
          </div>
        </button>
      ))}
    </div>
  )
}
