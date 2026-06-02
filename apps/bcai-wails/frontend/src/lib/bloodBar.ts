export type BloodTone = 'ok' | 'warn' | 'low' | 'empty'

export interface BloodStatus {
  /** Remaining "life" as a 0..100 percentage (full bar = plenty of quota left). */
  remainingPct: number
  /** Short Chinese status word shown instead of raw token counts. */
  label: string
  tone: BloodTone
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
  if (r <= 0) return { remainingPct, label: '已用尽', tone: 'empty' }
  if (r < 0.2) return { remainingPct, label: '紧张', tone: 'low' }
  if (r < 0.5) return { remainingPct, label: '一般', tone: 'warn' }
  return { remainingPct, label: '充足', tone: 'ok' }
}

export function bloodBarStatus(used: number | null, limit: number | null): BloodStatus {
  if (used == null || limit == null) {
    return { remainingPct: 0, label: '等待数据', tone: 'warn' }
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
  if (fraction < 0) return { remainingPct: 0, label: '未知', tone: 'warn' }
  return statusFromRemaining(fraction)
}
