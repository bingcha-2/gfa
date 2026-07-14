import type { AccountSubscription, SubscriptionProductUsdQuota, SubscriptionUsdQuotaWindow } from '@/types'
import { productLabel } from '@/lib/usageBars'
import { formatResetDuration, quotaRemainingPercent } from '@/lib/quotaDisplay'
import { useT } from '@/i18n'
import { ExclusiveBadge } from './ExclusiveBadge'

function resetText(iso: string | null | undefined): string {
  if (!iso) return ''
  const ms = Date.parse(iso) - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return ''
  return formatResetDuration(ms)
}

type QuotaTone = {
  name: 'normal' | 'warning' | 'danger'
  label: '正常' | '提醒' | '危险'
  barColor: string
  textColor: string
}

function quotaTone(remainingPercent: number): QuotaTone {
  if (remainingPercent < 15) {
    return { name: 'danger', label: '危险', barColor: 'var(--danger)', textColor: 'var(--danger)' }
  }
  if (remainingPercent < 40) {
    return { name: 'warning', label: '提醒', barColor: 'var(--warning)', textColor: 'var(--warning-deep)' }
  }
  return { name: 'normal', label: '正常', barColor: 'var(--success)', textColor: 'var(--success-strong)' }
}

function QuotaRatioBar({ label, quota }: { label: string; quota: SubscriptionUsdQuotaWindow }) {
  const used = Math.max(0, Number(quota.used) || 0)
  const limit = Math.max(0, Number(quota.limit) || 0)
  const remainingPercent = quotaRemainingPercent(used, limit)
  const tone = quotaTone(remainingPercent)
  const reset = resetText(quota.resetAt)

  return (
    <div className="py-2 first:pt-0 last:pb-0">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-[12px] font-medium text-[var(--text-primary)]">{label}</span>
        {reset && <span className="shrink-0 font-mono-data text-[10px] text-[var(--text-muted)]">{reset} 后重置</span>}
      </div>
      <div className="flex items-center gap-2.5">
        <div
          className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--bg-tertiary)]"
          role="progressbar"
          aria-label={`${label}剩余`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={remainingPercent}
          aria-valuetext={`剩余 ${remainingPercent}%，${tone.label}`}
          data-quota-tone={tone.name}
        >
          <div
            className="h-full rounded-full transition-[width]"
            style={{ width: `${remainingPercent}%`, backgroundColor: tone.barColor }}
          />
        </div>
        <span className="min-w-[62px] shrink-0 text-right font-mono-data text-[11px] tabular-nums text-[var(--text-secondary)]">
          剩余 <span style={{ color: tone.textColor }}>{remainingPercent}%</span>
        </span>
      </div>
    </div>
  )
}

function SubscriptionCard({ sub }: { sub: AccountSubscription }) {
  const t = useT()
  const shortId = sub.id.slice(-4).toUpperCase()
  const shareSeats = Math.max(1, Math.floor(Number(sub.shareSeats) || 1))

  const renderProduct = (product: string, quota?: SubscriptionProductUsdQuota) => {
    const windows = [
      { key: 'fiveHour', label: '5 小时额度', quota: quota?.fiveHour },
      { key: 'weekly', label: '每周额度', quota: quota?.weekly },
    ].filter((item): item is { key: string; label: string; quota: SubscriptionUsdQuotaWindow } => !!item.quota)
    return (
      <div key={product} className="mt-3 rounded-[10px] border border-[var(--border-light)] p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[12px] font-semibold text-[var(--text-primary)]">{productLabel(product)}</span>
          {sub.levels?.[product] && (
            <span className="rounded-[6px] bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">{sub.levels[product]}</span>
          )}
          {windows.length > 0 && (
            <span className="ml-auto font-mono-data text-[10px] text-[var(--text-muted)]">{shareSeats} 份</span>
          )}
        </div>
        {windows.length > 0 ? (
          <div className="mt-2.5 flex flex-col divide-y divide-[var(--border-light)]">
            {windows.map((item) => <QuotaRatioBar key={item.key} label={item.label} quota={item.quota} />)}
          </div>
        ) : (
          <div className="mt-2 text-[11px] text-[var(--text-muted)]">该产品暂未配置额度</div>
        )}
      </div>
    )
  }

  return (
    <div className="rounded-[12px] border border-[var(--border-light)] p-3.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-[var(--text-secondary)]">{sub.products.length > 0 ? '订阅额度' : t('account.activeMember')}</span>
        {sub.exclusive && <ExclusiveBadge />}
        <span className="ml-auto font-mono-data text-[11px] text-[var(--text-muted)]">#{shortId}</span>
      </div>
      {sub.products.map((product) => renderProduct(product, sub.usdQuotaByProduct?.[product]))}
    </div>
  )
}

export function SubscriptionUsageCarousel({ subscriptions }: { subscriptions: AccountSubscription[] }) {
  const subs = [...subscriptions].sort((a, b) => a.priority - b.priority)
  if (subs.length === 0) return null

  return (
    <div className="flex flex-col gap-3">
      {subs.map((sub) => <SubscriptionCard key={sub.id} sub={sub} />)}
    </div>
  )
}
