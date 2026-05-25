import * as api from '@/services/wails'
import { ArrowUpRight, Sparkles } from 'lucide-react'

const PROMOS = [
  {
    emoji: '🛒',
    tag: '热卖',
    tagColor: 'bg-red-500',
    title: '冰茶商店',
    desc: 'Codex Plus · Cursor Pro · Windsurf\n一键代理全家桶，9.9 元起',
    cta: '立即选购',
    link: 'https://bcai.store',
    accent: 'var(--primary)',
    tint: 'rgba(29, 78, 216, 0.07)',
    border: 'rgba(29, 78, 216, 0.15)',
    borderHover: 'rgba(29, 78, 216, 0.30)',
    glow: 'rgba(29, 78, 216, 0.08)',
  },
  {
    emoji: '⚡',
    tag: 'NEW',
    tagColor: 'bg-[var(--accent)]',
    title: '冰茶 API',
    desc: 'Claude / Gemini / GPT 低价调用\n企业级稳定，按量计费',
    cta: '了解更多',
    link: 'https://bcai.online',
    accent: 'var(--accent)',
    tint: 'rgba(14, 165, 165, 0.07)',
    border: 'rgba(14, 165, 165, 0.15)',
    borderHover: 'rgba(14, 165, 165, 0.30)',
    glow: 'rgba(14, 165, 165, 0.08)',
  },
]

export function PromoSection() {
  return (
    <div className="grid grid-cols-2 gap-4">
      {PROMOS.map((p) => (
        <button
          key={p.link}
          onClick={() => api.openURL(p.link)}
          className="group relative overflow-hidden rounded-[16px] p-5 text-left transition-all duration-300 hover:shadow-lg active:scale-[0.98]"
          style={{
            background: `linear-gradient(160deg, ${p.tint} 0%, transparent 60%)`,
            border: `1.5px solid ${p.border}`,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = p.borderHover }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = p.border }}
        >
          {/* Decorative glow */}
          <div
            className="absolute -top-8 -right-8 w-32 h-32 rounded-full opacity-40 group-hover:opacity-70 transition-opacity duration-500"
            style={{ background: `radial-gradient(circle, ${p.glow}, transparent 65%)` }}
          />
          <div
            className="absolute bottom-0 left-0 w-20 h-20 rounded-full opacity-20"
            style={{ background: `radial-gradient(circle, ${p.glow}, transparent 70%)` }}
          />

          <div className="relative">
            {/* Icon + Tag row */}
            <div className="flex items-start justify-between mb-3">
              <div
                className="w-11 h-11 rounded-[12px] flex items-center justify-center shadow-sm"
                style={{ background: p.tint }}
              >
                <span className="text-[24px]">{p.emoji}</span>
              </div>
              <span className={`${p.tagColor} text-white text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide flex items-center gap-0.5`}>
                <Sparkles size={8} /> {p.tag}
              </span>
            </div>

            {/* Title */}
            <div className="text-[16px] font-bold text-[var(--text-primary)] mb-1.5">{p.title}</div>

            {/* Description */}
            <div className="text-[12px] text-[var(--text-muted)] leading-relaxed mb-4 whitespace-pre-line">{p.desc}</div>

            {/* CTA */}
            <div
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[11px] font-bold text-white shadow-sm group-hover:shadow-md transition-all duration-300 group-hover:gap-2"
              style={{ background: p.accent }}
            >
              {p.cta} <ArrowUpRight size={12} className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </div>
          </div>
        </button>
      ))}
    </div>
  )
}
