import { cn } from '@/lib/utils'
import { bloodBarFromFraction } from '@/lib/bloodBar'
import { t } from '@/i18n'

interface NestedShareBarProps {
  /** 时间窗标签,如「5h 窗口」「周窗口」。 */
  label: string
  /** 我这一份还剩多少(0..1;-1=未知)。决定健康色,也是「我那份剩多少」。 */
  myFraction: number
  /** 我的份额占整号比例 e_i(0..1;独享=1)。 */
  share: number
  /** 账号上游总剩余(0..1;-1=未知)。 */
  accountFraction: number
  /** 该窗口额度恢复剩余毫秒(>0 → 显示倒计时)。 */
  resetMs?: number | null
}

function formatReset(ms: number): string {
  const totalMin = Math.ceil(ms / 60000)
  if (totalMin <= 0) return t('usage.recovered')
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  const time = h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ''}` : `${m}m`
  return t('usage.resetIn', { time })
}

/**
 * 双层血条:长条 = 整号总容量(100%)。两条进度叠在同一条上 ——
 *   ① 账号总剩余(accountFraction):中性底层,整个号上游还剩多少。
 *   ② 我的总剩余(share × myFraction):健康色上层,这个号里属于我、且我还没用掉的那部分(占整号比例)。
 * 我的总剩余恒 ≤ 我的份额 e_i ≤ 整号,故上层落在底层之内,直观看出「整号 / 我那块 / 我还剩」。
 * 健康色由「我那份剩余比例」myFraction 决定(它才是会不会被本地拦的那个数)。
 */
export function NestedShareBar({ label, myFraction, share, accountFraction, resetMs }: NestedShareBarProps) {
  const acctKnown = accountFraction >= 0
  const myKnown = myFraction >= 0 && share >= 0
  const acctPct = acctKnown ? Math.round(accountFraction * 100) : 0
  // 我的总剩余(占整号)= e_i × 我那份剩余比例。
  const myTotalPct = myKnown ? Math.round(share * myFraction * 100) : 0
  const myShareRemainPct = myKnown ? Math.round(myFraction * 100) : 0
  const exclusive = share >= 1

  const { tone, key } = bloodBarFromFraction(myKnown ? myFraction : -1)
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
        <span className="text-[11px] font-medium text-[var(--text-muted)]">
          {myKnown ? `我剩 ${myShareRemainPct}%` : '未知'}
          {showReset && <span className="ml-1.5 text-[var(--warning)]">· {formatReset(resetMs!)}</span>}
        </span>
      </div>

      <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
        <div className="absolute inset-y-0 left-0 rounded-full bg-[var(--text-muted)]" style={{ width: `${acctPct}%`, opacity: 0.28 }} />
        <div className={cn('absolute inset-y-0 left-0 rounded-full', myColor)} style={{ width: `${myTotalPct}%` }} />
      </div>

      <div className="flex justify-between text-[10px] text-[var(--text-muted)]">
        <span>
          我的总剩余 {myTotalPct}%
          {!exclusive && myKnown && <span className="text-[var(--text-muted)]">(占整号 {Math.round(share * 100)}% · 我那份剩 {myShareRemainPct}%)</span>}
        </span>
        <span>账号总剩余 {acctKnown ? `${acctPct}%` : '未知'}</span>
      </div>
    </div>
  )
}
