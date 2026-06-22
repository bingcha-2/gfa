import { useRef } from 'react'
import { cn } from '@/lib/utils'
import { bloodBarFromFraction } from '@/lib/bloodBar'
import { formatPercent, formatResetDuration, monotonicQuotaValue, nestedBarDisplay } from '@/lib/quotaDisplay'
import { t } from '@/i18n'

interface NestedShareBarProps {
  /** 时间窗标签,如「5h 窗口」「周窗口」。 */
  label: string
  /** 我这一份还剩多少比例(0..1;-1=未知)。服务端值(已含等比例缩放),决定健康色,用了/账号低都会降。 */
  myFraction: number
  /** 账号上游总剩余(0..1;-1=未知),真实显示不缩放。 */
  accountFraction: number
  /** 我的席位数 X(份额 X/Y 的 X)。 */
  shareSeats: number
  /** 号总份数 Y(份额 X/Y 的 Y,= 没超卖的名义分母)。 */
  shareCapacity: number
  /** 后端权威独享标志(独享=名义份额 1)。 */
  exclusive?: boolean
  /** 该窗口额度恢复剩余毫秒(>0 → 显示倒计时)。 */
  resetMs?: number | null
  displayKey?: string
}

function formatReset(ms: number): string {
  const dur = formatResetDuration(ms)
  if (!dur) return t('usage.recovered')
  return t('usage.resetIn', { time: dur })
}

/**
 * 双层血条(遮超卖,纯展示;服务端值保持真实)：
 *   长条 = 整号总容量(100%)。两条进度叠在同一条上 ——
 *   ① 账号总剩余(accountRemain):中性底层,整个号上游还剩多少(真实)。
 *   ② 我的总剩余(myTotalRemain = min(名义份额 X/Y × myFraction, 账号)):健康色上层。
 * 用【没超卖的名义份额 X/Y】放大显示「我那一席」,遮掉真实被切薄的 w/D;再按账号封顶,
 * 故上层恒 ≤ 底层(我的总剩余 ≤ 账号),永不穿帮。健康色由「我那份剩比例」myFraction 决定。
 */
export function NestedShareBar({ label, myFraction, accountFraction, shareSeats, shareCapacity, exclusive, resetMs, displayKey }: NestedShareBarProps) {
  const displayStateRef = useRef<Record<string, number>>({})
  const d = nestedBarDisplay({ myFraction, accountFraction, shareSeats, shareCapacity, exclusive })
  const acctKnown = d.accountRemain >= 0
  // 传 Date.now() 启用回升确认:服务端值被修正抬升后,血条几分钟内自己回上去,不必等重启/窗口 reset。
  const now = Date.now()
  const displayMyTotalRemain = monotonicQuotaValue(
    displayStateRef.current,
    displayKey && d.myTotalRemain >= 0 ? `${displayKey}:total` : undefined,
    d.myTotalRemain,
    now,
  )
  const displaySeatFill = monotonicQuotaValue(
    displayStateRef.current,
    displayKey && d.seatFill >= 0 ? `${displayKey}:seat` : undefined,
    d.seatFill,
    now,
  )
  const myKnown = displayMyTotalRemain >= 0
  // 条宽用精确百分比;文字用 formatPercent(保留小数,12.5% 不被抹成 13%)。
  const acctPct = acctKnown ? d.accountRemain * 100 : 0
  const myTotalPct = myKnown ? displayMyTotalRemain * 100 : 0

  const { tone, key } = bloodBarFromFraction(displaySeatFill >= 0 ? displaySeatFill : -1)
  const isUnknown = key === 'unknown' || key === 'waiting'
  const myColor =
    isUnknown ? 'bg-[var(--text-muted)]'
      : tone === 'empty' ? 'bg-[var(--danger)]'
      : tone === 'low' ? 'bg-[var(--warning-strong)]'
      : tone === 'warn' ? 'bg-[var(--warning)]'
      : 'bg-[var(--success)]'

  const showReset = typeof resetMs === 'number' && resetMs > 0

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-[var(--text-secondary)]">{label}</span>
        {showReset && <span className="text-[11px] font-medium text-[var(--warning)]">{formatReset(resetMs!)}</span>}
      </div>

      <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
        <div className="absolute inset-y-0 left-0 rounded-full bg-[var(--text-muted)]" style={{ width: `${acctPct}%`, opacity: 0.28 }} />
        <div className={cn('absolute inset-y-0 left-0 rounded-full', myColor)} style={{ width: `${myTotalPct}%` }} />
      </div>

      <div className="flex justify-between text-[10px] text-[var(--text-muted)]">
        {d.exclusive ? (
          <span>剩余 {myKnown ? `${formatPercent(displayMyTotalRemain)}%` : '未知'}</span>
        ) : (
          <>
            <span>我的总剩余 {myKnown ? `${formatPercent(displayMyTotalRemain)}%（占总帐号份额）` : '未知'}</span>
            <span>账号总剩余 {acctKnown ? `${formatPercent(d.accountRemain)}%` : '未知'}</span>
          </>
        )}
      </div>
    </div>
  )
}
