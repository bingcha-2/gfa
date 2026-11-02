import { ArrowUpRight, ShoppingBag, Zap } from 'lucide-react'
import * as api from '@/services/wails'
import { useT } from '@/i18n'

/** Compact store and API links with the app's existing surface and accent colors. */
export function PromoCard() {
  const t = useT()
  const ads = [
    {
      icon: ShoppingBag,
      title: t('promo.storeTitle'),
      desc: t('promo.storeDescCard'),
      cta: t('promo.storeCta'),
      link: 'https://niuma996.icu/',
      tone: 'var(--primary)',
    },
    {
      icon: Zap,
      title: t('promo.apiTitle'),
      desc: t('promo.apiDescCard'),
      cta: t('promo.apiCta'),
      link: 'https://www.tk4me.com/',
      tone: 'var(--primary)',
    },
  ]
  return (
    <div className="grid grid-cols-2 gap-3">
      {ads.map((ad) => {
        const Icon = ad.icon
        return (
          <button
            type="button"
            key={ad.link}
            onClick={() => api.openURL(ad.link)}
            className="group flex min-h-[64px] min-w-0 items-center gap-2.5 rounded-xl border border-[var(--border-light)] bg-[var(--bg-secondary)] px-3 py-2.5 text-left transition-colors hover:border-[var(--primary)] hover:bg-[var(--bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]"
          >
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
              style={{ background: 'var(--primary-light)', color: ad.tone }}
            >
              <Icon size={17} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold leading-5 text-[var(--text-primary)]">{ad.title}</div>
              <div className="mt-0.5 truncate text-[11px] leading-4 text-[var(--text-secondary)]" title={ad.desc}>{ad.desc}</div>
            </div>
            <span
              className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]"
            >
              {ad.cta}
              <ArrowUpRight size={12} />
            </span>
          </button>
        )
      })}
    </div>
  )
}
