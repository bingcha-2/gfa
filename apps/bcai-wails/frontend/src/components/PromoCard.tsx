import { ArrowUpRight, ShoppingBag, Zap } from 'lucide-react'
import * as api from '@/services/wails'

const ADS = [
  {
    icon: ShoppingBag,
    title: '冰茶商店',
    desc: 'Codex Plus · Cursor · Windsurf 一键代理',
    cta: '选购',
    link: 'https://bcai.store',
    tone: 'var(--primary)',
  },
  {
    icon: Zap,
    title: '冰茶 API',
    desc: 'Claude / Gemini / GPT 低价调用',
    cta: '了解',
    link: 'https://api.bcai.space',
    tone: 'var(--primary)',
  },
]

/**
 * 全宽 2 列入口 — 常驻。中性卡 + 各自标识色,克制,无渐变/玻璃。
 */
export function PromoCard() {
  return (
    <div className="grid grid-cols-2 gap-3">
      {ADS.map((ad) => {
        const Icon = ad.icon
        return (
          <button
            key={ad.link}
            onClick={() => api.openURL(ad.link)}
            className="group flex items-center gap-3 rounded-[14px] border border-[var(--border-light)] bg-[var(--bg-secondary)] px-4 py-3 text-left transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)] hover:border-[var(--border)] active:translate-y-0"
          >
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
              style={{ background: 'var(--bg-tertiary)', color: ad.tone }}
            >
              <Icon size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-[var(--text-primary)] leading-tight">{ad.title}</div>
              <div className="text-[11px] text-[var(--text-muted)] truncate">{ad.desc}</div>
            </div>
            <span
              className="shrink-0 inline-flex items-center gap-0.5 text-[11px] font-semibold"
              style={{ color: ad.tone }}
            >
              {ad.cta}
              <ArrowUpRight size={13} className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </span>
          </button>
        )
      })}
    </div>
  )
}
