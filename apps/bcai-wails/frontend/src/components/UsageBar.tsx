import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'

interface UsageBarProps {
  label: string
  used: number | null
  limit: number | null
  color: string
  subtitle?: string
}

export function UsageBar({ label, used, limit, color, subtitle }: UsageBarProps) {
  const noData = used == null || limit == null
  const unlimited = !noData && limit === 0
  const pct = noData || unlimited ? 0 : Math.min(100, (used / limit) * 100)
  const isFull = !noData && used === 0
  const isExhausted = !noData && !unlimited && used >= limit

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-[var(--text-secondary)]">{label}</span>
        <span className="text-[11px] font-mono-data text-[var(--text-muted)]">
          {noData
            ? '等待数据...'
            : unlimited
              ? `${fmtNum(used)} / 不限额`
              : isFull
                ? `满额度 · ${fmtNum(limit)}`
                : `${fmtNum(used)} / ${fmtNum(limit)}`}
        </span>
      </div>
      <Progress
        value={isFull ? 100 : pct}
        indicatorClassName={cn(isExhausted ? 'bg-[var(--danger)]' : color)}
      />
      {subtitle && <span className="text-[10px] text-[var(--text-muted)]">{subtitle}</span>}
    </div>
  )
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}
