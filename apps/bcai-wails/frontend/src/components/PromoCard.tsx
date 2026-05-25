import { ArrowUpRight } from 'lucide-react'
import * as api from '@/services/wails'

const ADS = [
  {
    emoji: '🔥',
    title: '9.9 元起 Codex Plus 号',
    desc: '下单最高可获 88 元现金红包',
    cta: '立即抢购',
    link: 'https://bcai.store',
    gradient: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)',
  },
  {
    emoji: '🎁',
    title: '冰茶 AI 全家桶',
    desc: 'Antigravity · Codex · Cursor · Windsurf',
    cta: '去看看',
    link: 'https://bcai.store',
    gradient: 'linear-gradient(135deg, #0ea5a5 0%, #2563eb 100%)',
  },
  {
    emoji: '⚡',
    title: '冰茶 API',
    desc: 'Claude / Gemini / GPT 低价调用',
    cta: '了解更多',
    link: 'https://api.bcai.site',
    gradient: 'linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)',
  },
]

/**
 * 常驻广告卡列表 — 所有广告同时显示
 */
export function PromoCard() {
  return (
    <div className="flex flex-col gap-2.5">
      {ADS.map((ad) => (
        <button
          key={ad.link + ad.emoji}
          onClick={() => api.openURL(ad.link)}
          className="group relative w-full overflow-hidden rounded-[12px] px-3.5 py-3 text-left transition-all duration-300 hover:shadow-lg active:scale-[0.98]"
          style={{ background: ad.gradient }}
        >
          {/* Glow */}
          <div className="absolute -top-4 -right-4 w-20 h-20 rounded-full bg-white/10 blur-lg group-hover:bg-white/15 transition-all" />

          <div className="relative flex items-center gap-3">
            <span className="text-[20px] flex-shrink-0">{ad.emoji}</span>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-bold text-white leading-tight">{ad.title}</div>
              <div className="text-[11px] text-white/65 leading-snug truncate">{ad.desc}</div>
            </div>
            <div className="flex-shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/20 backdrop-blur-sm text-[10px] font-bold text-white transition-all group-hover:bg-white/30">
              {ad.cta} <ArrowUpRight size={10} className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </div>
          </div>
        </button>
      ))}
    </div>
  )
}
