import { t } from '@/i18n'

export type BloodTone = 'ok' | 'warn' | 'low' | 'empty'

/** 语义状态键:UI 判断(如「未知」不显示百分比)一律用 key,不比对文案。 */
export type BloodKey = 'ok' | 'warn' | 'low' | 'empty' | 'waiting' | 'unknown'

export interface BloodStatus {
  /** Remaining "life" as a 0..100 percentage (full bar = plenty of quota left). */
  remainingPct: number
  /** Localized status word shown instead of raw token counts. */
  label: string
  tone: BloodTone
  /** Semantic key — use this for logic, never compare the label text. */
  key: BloodKey
}

/**
 * Derive a "blood bar" (remaining-quota health bar) from a card's used/limit
 * counts. The end-user UI shows ONLY this bar + status word — never the raw
 * token numbers — so usage reads as a shared "拼车" pool. An unlimited card
 * (limit 0) or missing data degrades gracefully.
 */
function statusFromRemaining(remaining: number): BloodStatus {
  const r = Math.max(0, Math.min(1, remaining))
  const remainingPct = r * 100
  if (r <= 0) return { remainingPct, label: t('usage.statusEmpty'), tone: 'empty', key: 'empty' }
  if (r < 0.2) return { remainingPct, label: t('usage.statusLow'), tone: 'low', key: 'low' }
  if (r < 0.5) return { remainingPct, label: t('usage.statusWarn'), tone: 'warn', key: 'warn' }
  return { remainingPct, label: t('usage.statusOk'), tone: 'ok', key: 'ok' }
}

export function bloodBarStatus(used: number | null, limit: number | null): BloodStatus {
  if (used == null || limit == null) {
    return { remainingPct: 0, label: t('usage.statusWaiting'), tone: 'warn', key: 'waiting' }
  }
  if (limit <= 0) {
    return statusFromRemaining(1) // unlimited → full
  }
  return statusFromRemaining(1 - used / limit)
}

/**
 * Blood bar from the bound account's REAL upstream remaining fraction (0..1),
 * as reported by the server. Preferred over used/limit for bound cards — the
 * GFA-side used/limit is uncapped now, so it would always read "充足".
 */
export function bloodBarFromFraction(fraction: number): BloodStatus {
  // < 0 means "queried but no quota info" — show 未知, NOT a misleading 已用尽/充足.
  if (fraction < 0) return { remainingPct: 0, label: t('usage.statusUnknown'), tone: 'warn', key: 'unknown' }
  return statusFromRemaining(fraction)
}
