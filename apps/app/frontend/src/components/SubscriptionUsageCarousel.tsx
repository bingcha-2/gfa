import type { AccountSubscription, ProductQuotaWindow } from '@/types'
import { productLabel } from '@/lib/usageBars'
import { formatResetDuration } from '@/lib/quotaDisplay'
import { useT } from '@/i18n'
import { NestedShareBar } from './NestedShareBar'

function isFutureIso(iso: string | null | undefined): boolean {
  if (!iso) return false
  const ms = Date.parse(iso) - Date.now()
  return Number.isFinite(ms) && ms > 0
}

function resetMsOf(iso: string | null | undefined): number {
  if (!iso) return 0
  const ms = Date.parse(iso) - Date.now()
  return Number.isFinite(ms) && ms > 0 ? ms : 0
}

function healthColor(pct: number): string {
  return pct < 15 ? 'var(--danger)' : pct < 40 ? 'var(--warning)' : 'var(--success)'
}

function resetText(iso: string | null | undefined): string {
  if (!iso) return ''
  const ms = Date.parse(iso) - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return ''
  return formatResetDuration(ms)
}

function AccountBar({ label, percent, reset }: { label: string; percent: number | null; reset: string }) {
  const t = useT()
  if (percent == null) {
    return (
      <div className="py-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium text-[var(--text-primary)]">{label}</span>
          <span className="text-[11px] text-[var(--text-muted)]">{t('dashboard.statusUnknown')}</span>
        </div>
      </div>
    )
  }

  const pct = Math.round(percent)
  const color = healthColor(pct)
  return (
    <div className="py-1.5">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[12px] font-medium text-[var(--text-primary)]">{label}</span>
        {reset && <span className="text-[11px] text-[var(--warning)] font-mono-data">{reset}</span>}
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
          <div className="h-full rounded-full transition-[width]" style={{ width: `${pct}%`, backgroundColor: color }} />
        </div>
        <span className="text-[10px] font-mono-data shrink-0" style={{ color }}>{pct}%</span>
      </div>
    </div>
  )
}

function ProductSection({ subId, product, level, quota }: { subId: string; product: string; level?: string; quota?: ProductQuotaWindow }) {
  const t = useT()
  const renderWindow = (
    win: '5h' | '7d',
    label: string,
    accountPercent: number | null | undefined,
    myFraction: number | null | undefined,
    resetIso: string | null | undefined,
  ) => {
    if (myFraction != null && quota?.myShare != null) {
      return (
        <div className="py-1.5">
          <NestedShareBar
            label={label}
            myFraction={myFraction}
            accountFraction={accountPercent != null ? accountPercent / 100 : -1}
            shareSeats={quota.myShare}
            shareCapacity={1}
            resetMs={resetMsOf(resetIso)}
            displayKey={isFutureIso(resetIso) ? `${subId}:${product}:${win}:${resetIso}` : undefined}
          />
        </div>
      )
    }
    return <AccountBar label={label} percent={accountPercent ?? null} reset={resetText(resetIso)} />
  }

  return (
    <div className="mt-3">
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--primary)]" />
        <span className="text-[12px] font-medium text-[var(--text-primary)]">{productLabel(product)}</span>
        {level && (
          <span className="text-[11px] px-1.5 py-0.5 rounded-[6px] bg-[var(--bg-secondary)] border border-[var(--border-light)] text-[var(--text-secondary)]">
            {level}
          </span>
        )}
      </div>
      <div className="flex flex-col divide-y divide-[var(--border-light)]">
        {renderWindow('5h', t('dashboard.acct5h'), quota?.hourlyPercent, quota?.myHourlyFraction, quota?.hourlyResetAt)}
        {renderWindow('7d', t('dashboard.acctWeek'), quota?.weeklyPercent, quota?.myWeeklyFraction, quota?.weeklyResetAt)}
      </div>
    </div>
  )
}

function SubscriptionCard({ sub }: { sub: AccountSubscription }) {
  const t = useT()
  const shortId = sub.id.slice(-4).toUpperCase()
  const remain = sub.remainFraction
  const pct = remain == null ? null : Math.round(remain * 100)
  const color = remain == null ? '' : healthColor(remain * 100)

  return (
    <div className="rounded-[12px] border border-[var(--border-light)] p-3.5">
      <div className="flex items-center gap-1.5 flex-wrap">
        {sub.products.length > 0 ? (
          sub.products.map((p) => (
            <span
              key={p}
              className="px-1.5 py-0.5 rounded-[6px] text-[11px] bg-[var(--bg-secondary)] border border-[var(--border-light)] text-[var(--text-secondary)]"
            >
              {productLabel(p)}
            </span>
          ))
        ) : (
          <span className="text-[11px] text-[var(--text-secondary)]">{t('account.activeMember')}</span>
        )}
        <span className="ml-auto text-[11px] font-mono-data text-[var(--text-muted)]">#{shortId}</span>
      </div>

      {pct != null && (
        <div className="flex items-center gap-2 mt-2">
          <div className="flex-1 h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
            <div className="h-full rounded-full transition-[width]" style={{ width: `${pct}%`, backgroundColor: color }} />
          </div>
          <span className="text-[10px] font-mono-data shrink-0" style={{ color }}>{pct}%</span>
        </div>
      )}

      {sub.products.map((p) => (
        <ProductSection key={p} subId={sub.id} product={p} level={sub.levels?.[p]} quota={sub.productQuota?.[p]} />
      ))}
    </div>
  )
}

export function SubscriptionUsageCarousel({ subscriptions }: { subscriptions: AccountSubscription[] }) {
  const subs = [...subscriptions].sort((a, b) => a.priority - b.priority)
  if (subs.length === 0) return null

  return (
    <div className="flex flex-col gap-3">
      {subs.map((sub) => (
        <SubscriptionCard key={sub.id} sub={sub} />
      ))}
    </div>
  )
}
