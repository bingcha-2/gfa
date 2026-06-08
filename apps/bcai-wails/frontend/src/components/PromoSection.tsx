import * as api from '@/services/wails'
import { ArrowUpRight, ShoppingBag, Zap } from 'lucide-react'

const PROMOS = [
  {
    icon: ShoppingBag,
    tag: '热卖',
    title: '冰茶商店',
    desc: 'Codex Plus · Cursor Pro · Windsurf\n一键代理全家桶,9.9 元起',
    cta: '立即选购',
    link: 'https://bcai.store',
    tone: 'var(--primary)',
  },
  {
    icon: Zap,
    tag: 'NEW',
    title: '冰茶 API',
    desc: 'Claude / Gemini / GPT 低价调用\n企业级稳定,按量计费',
    cta: '了解更多',
    link: 'https://bcai.online',
    tone: 'var(--primary)',
  },
]

export function PromoSection() {
  return (
    <div className="grid grid-cols-2 gap-4">
      {PROMOS.map((p) => {
        const Icon = p.icon
        return (
          <button
            key={p.link}
            onClick={() => api.openURL(p.link)}
            className="group flex flex-col rounded-[16px] border border-[var(--border-light)] bg-[var(--bg-secondary)] p-5 text-left transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)] hover:border-[var(--border)] active:translate-y-0"
          >
            <div className="flex items-start justify-between mb-3">
              <span
                className="flex h-11 w-11 items-center justify-center rounded-[12px]"
                style={{ background: 'var(--bg-tertiary)', color: p.tone }}
              >
                <Icon size={22} />
              </span>
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                style={{ background: 'var(--bg-tertiary)', color: p.tone }}
              >
                {p.tag}
              </span>
            </div>

            <div className="text-[15px] font-bold text-[var(--text-primary)] mb-1">{p.title}</div>
            <div className="text-[12px] text-[var(--text-muted)] leading-relaxed mb-4 whitespace-pre-line">{p.desc}</div>

            <span
              className="mt-auto inline-flex items-center gap-1 text-[12px] font-semibold"
              style={{ color: p.tone }}
            >
              {p.cta}
              <ArrowUpRight size={14} className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </span>
          </button>
        )
      })}
    </div>
  )
}
