import { useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import type { AccountSubscription, ProductQuotaWindow } from '@/types'
import { productLabel } from '@/lib/usageBars'
import { formatResetDuration } from '@/lib/quotaDisplay'
import { cn } from '@/lib/utils'
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

// 逐订阅余量轮播:多个订阅时一次显示一个,左右切换。每页 = 一个订阅(按 #id 区分),顶部是
// 订阅整体(产品 chip + #短id + 订阅总剩余%),下面按产品分小节,各画该产品整号 5h/周血条。
// 数据来自心跳订阅快照(remainFraction + productQuota),纯展示。

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
  // 每窗口:有「我的份额」(fair-share)→ 双层血条(母号打底 + 我的叠加);否则退单层账号条。
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

export function SubscriptionUsageCarousel({ subscriptions }: { subscriptions: AccountSubscription[] }) {
  const t = useT()
  const subs = [...subscriptions].sort((a, b) => a.priority - b.priority)
  const [index, setIndex] = useState(0)
  if (subs.length === 0) return null

  const safeIndex = Math.min(index, subs.length - 1)
  const sub = subs[safeIndex]
  const multi = subs.length > 1
  const go = (dir: -1 | 1) => setIndex((safeIndex + dir + subs.length) % subs.length)

  const shortId = sub.id.slice(-4).toUpperCase()
  const remain = sub.remainFraction
  const pct = remain == null ? null : Math.round(remain * 100)
  const color = remain == null ? '' : healthColor(remain * 100)

  return (
    <div className="rounded-[12px] border border-[var(--border-light)] p-3.5">
      <div className="flex items-start gap-2.5">
        {multi && (
          <button
            type="button"
            aria-label="previous subscription"
            onClick={() => go(-1)}
            className="grid place-items-center w-6 h-6 mt-0.5 shrink-0 rounded-full border border-[var(--border-light)] text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] transition-colors"
          >
            <ChevronLeft size={14} />
          </button>
        )}

        <div className="flex-1 min-w-0">
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

        {multi && (
          <button
            type="button"
            aria-label="next subscription"
            onClick={() => go(1)}
            className="grid place-items-center w-6 h-6 mt-0.5 shrink-0 rounded-full border border-[var(--border-light)] text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] transition-colors"
          >
            <ChevronRight size={14} />
          </button>
        )}
      </div>

      {multi && (
        <div className="flex items-center justify-center gap-1.5 mt-3">
          {subs.map((s, i) => (
            <button
              type="button"
              key={s.id}
              aria-label={`subscription ${i + 1}`}
              onClick={() => setIndex(i)}
              className={cn('h-1.5 rounded-full transition-all', i === safeIndex ? 'w-4 bg-[var(--primary)]' : 'w-1.5 bg-[var(--border)]')}
            />
          ))}
        </div>
      )}
    </div>
  )
}
