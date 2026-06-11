import * as api from '@/services/wails'
import { ArrowUpRight, ShoppingBag, Zap } from 'lucide-react'
import { useT } from '@/i18n'

export function PromoSection() {
  const t = useT()
  const promos = [
    {
      icon: ShoppingBag,
      tag: t('promo.hotTag'),
      title: t('promo.storeTitle'),
      desc: t('promo.storeDescFull'),
      cta: t('promo.storeCtaFull'),
      link: 'https://bcai.store',
      tone: 'var(--primary)',
    },
    {
      icon: Zap,
      tag: t('promo.newTag'),
      title: t('promo.apiTitle'),
      desc: t('promo.apiDescFull'),
      cta: t('promo.apiCtaFull'),
      link: 'https://bcai.online',
      tone: 'var(--primary)',
    },
  ]
  return (
    <div className="grid grid-cols-2 gap-4">
      {promos.map((p) => {
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
