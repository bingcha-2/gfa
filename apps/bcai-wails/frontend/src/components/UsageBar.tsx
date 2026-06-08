import { useState } from 'react'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { bloodBarStatus, bloodBarFromFraction } from '@/lib/bloodBar'

interface UsageBarProps {
  label: string
  used: number | null
  limit: number | null
  /** Model accent color for a healthy bar (e.g. "bg-purple-500"). */
  color: string
  subtitle?: string
  /** Bound account's real upstream remaining (0..1; -1 = 未知). When present the
   *  bar uses this instead of local used/limit (which is uncapped → always 满). */
  fraction?: number | null
  /** Remaining ms until this bucket's quota refreshes (>0 → show a countdown). */
  resetMs?: number | null
  /** When true, the label row is clickable to reveal `detail` below the bar.
   *  Used by the "我的卡" bar so the % stays default but token numbers are one tap away. */
  expandable?: boolean
  /** Detail line shown when expanded, e.g. "已用 30M / 上限 50M". */
  detail?: string
}

/** Format a remaining-ms duration as a short "Xh Ym" / "Zm" recovery hint. */
function formatReset(ms: number): string {
  const totalMin = Math.ceil(ms / 60000)
  if (totalMin <= 0) return '已恢复'
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ''}后恢复` : `${m}m后恢复`
}

/**
 * End-user "blood bar": a remaining-quota health bar with a status word + the
 * remaining percentage (NOT raw token counts). Each bar can show its own quota
 * recovery countdown. "未知" = queried but no quota data; 充足/紧张/已用尽 = real.
 *
 * Set `expandable` + `detail` to let the user tap the label and reveal the exact
 * numbers (used for the "我的卡" bar — default stays %, numbers on demand).
 */
export function UsageBar({ label, used, limit, color, subtitle, fraction, resetMs, expandable, detail }: UsageBarProps) {
  const [expanded, setExpanded] = useState(false)
  // Any non-null fraction (including -1 = 未知) is authoritative; only fall back to
  // local used/limit when no fraction was provided at all.
  const { remainingPct, label: statusLabel, tone } =
    fraction != null ? bloodBarFromFraction(fraction) : bloodBarStatus(used, limit)
  const barColor =
    tone === 'empty' ? 'bg-[var(--danger)]' : tone === 'low' ? 'bg-[var(--warning)]' : color
  // Percentage shown only for a known fraction (not 未知 / 等待数据).
  const statusText =
    statusLabel === '等待数据' || statusLabel === '未知'
      ? statusLabel
      : `${statusLabel} ${Math.round(remainingPct)}%`
  const showReset = typeof resetMs === 'number' && resetMs > 0
  const canExpand = !!expandable && !!detail

  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={cn('flex items-center justify-between', canExpand && 'cursor-pointer select-none')}
        onClick={canExpand ? () => setExpanded((v) => !v) : undefined}
      >
        <span className="text-[12px] font-medium text-[var(--text-secondary)]">
          {label}
          {canExpand && (
            <span className="ml-1 text-[10px] text-[var(--text-muted)]">{expanded ? '▾' : '▸'}</span>
          )}
        </span>
        <span className="text-[11px] font-medium text-[var(--text-muted)]">
          {statusText}
          {showReset && <span className="ml-1.5 text-[var(--warning)]">· {formatReset(resetMs!)}</span>}
        </span>
      </div>
      <Progress value={remainingPct} indicatorClassName={cn(barColor)} />
      {canExpand && expanded && (
        <div className="text-[10px] text-[var(--text-muted)] bg-[var(--bg-tertiary)] rounded px-2 py-1 font-mono-data">
          {detail}
        </div>
      )}
      {subtitle && <span className="text-[10px] text-[var(--text-muted)]">{subtitle}</span>}
    </div>
  )
}
