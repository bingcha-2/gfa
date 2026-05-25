import { useState, useEffect } from 'react'
import { ArrowUpRight } from 'lucide-react'
import * as api from '@/services/wails'

const ADS = [
  {
    emoji: '🔥',
    title: '9.9 元起 Codex Plus 号',
    desc: '下单最高可获 88 元现金红包',
    cta: '立即抢购',
    link: 'https://bcai.store',
  },
  {
    emoji: '🎁',
    title: '冰茶 AI 全家桶',
    desc: 'Antigravity · Codex · Cursor · Windsurf 一键代理',
    cta: '去看看',
    link: 'https://bcai.store',
  },
  {
    emoji: '⚡',
    title: '冰茶 API 已上线',
    desc: 'Claude / Gemini / GPT 低价调用',
    cta: '了解更多',
    link: 'https://api.bcai.site',
  },
]

/**
 * 自动轮播广告卡 — 放在右列顶部
 */
export function PromoCard() {
  const [index, setIndex] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((i) => (i + 1) % ADS.length)
    }, 4000)
    return () => clearInterval(timer)
  }, [])

  const ad = ADS[index]

  return (
    <button
      onClick={() => api.openURL(ad.link)}
      className="group relative w-full overflow-hidden rounded-[14px] p-4 text-left transition-all duration-300 hover:shadow-xl active:scale-[0.98]"
      style={{
        background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 40%, #a855f7 100%)',
      }}
    >
      {/* Decorative elements */}
      <div className="absolute -top-6 -right-6 w-28 h-28 rounded-full bg-white/10 blur-lg group-hover:bg-white/15 transition-all" />
      <div className="absolute bottom-2 left-2 w-16 h-16 rounded-full bg-white/5 blur-md" />

      {/* Content */}
      <div className="relative">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[24px]">{ad.emoji}</span>
          {/* Carousel dots */}
          <div className="flex gap-1">
            {ADS.map((_, i) => (
              <div
                key={i}
                className={`h-1 rounded-full transition-all duration-500 ${
                  i === index ? 'w-4 bg-white/90' : 'w-1 bg-white/30'
                }`}
              />
            ))}
          </div>
        </div>

        <div className="text-[15px] font-bold text-white leading-tight mb-1">{ad.title}</div>
        <div className="text-[12px] text-white/70 leading-snug mb-3">{ad.desc}</div>

        <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/20 backdrop-blur-sm text-[11px] font-bold text-white transition-all group-hover:bg-white/30 group-hover:gap-2">
          {ad.cta} <ArrowUpRight size={12} className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </div>
      </div>
    </button>
  )
}
