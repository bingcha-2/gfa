type BucketValue = {
  used: number
  limit: number
  resetMs?: number
  resetAt?: number | string
}

export type DisplayQuotaValue = {
  fraction: number
  resetMs?: number
  resetAt?: number
}

export type CardScopeQuotaInput = {
  cardBuckets?: Record<string, BucketValue>
  cardWeeklyBuckets?: Record<string, BucketValue>
  myFractions?: Record<string, number>
  myResetMs?: Record<string, number>
  myResetAt?: Record<string, number>
  myWeeklyFractions?: Record<string, number>
  myWeeklyResetMs?: Record<string, number>
  myWeeklyResetAt?: Record<string, number>
  /** e_i:我的份额占整号比例(0~1,独享=1)。双层血条画「整号里我那一段」的外层宽度。 */
  myShares?: Record<string, number>
}

type SplitAccountQuota = {
  hourlyFraction: number
  weeklyFraction: number
  hourlyResetMs?: number
  weeklyResetMs?: number
}

export type QuotaDisplayBar = {
  window: '5h' | '7d'
  label: string
  fraction: number
  resetMs?: number
  resetAt?: number
  used?: number | null
  limit?: number | null
  hideValues?: boolean
}

export type QuotaSection = {
  bucket: string
  title: string
  mine: QuotaDisplayBar[]
  serviceAccount: QuotaDisplayBar[]
}

export type QuotaSectionBarSpec = {
  bucket: string
  label: string
  family?: string
  seatLabel?: string
}

export type BuildQuotaSectionsInput = CardScopeQuotaInput & {
  bucket?: string
  seatLabel?: string
  bars?: QuotaSectionBarSpec[]
  accountFractions?: Record<string, number>
  accountResetMs?: Record<string, number>
  accountResetAt?: Record<string, number>
  codexQuota?: SplitAccountQuota | null
  claudeQuota?: SplitAccountQuota | null
  accountProblem?: boolean
}

/**
 * 是否独享卡。后端现在下发显式 exclusive(权威);提供时以它为准,
 * 否则回退老的 weight>=capacity 推断(兼容旧服务端/旧缓存)。
 */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

// 血条回升确认(与服务端 fair-share lastFraction 同口径):明显回升需「持续够久 + 够多次读数」
// 才采纳,抗上游额度抖动 / 孤立高值。不传 now → 退化为纯单调(只降不升,旧行为)。
const REBOUND_EPS = 0.02
const REBOUND_CONFIRM_MS = 5 * 60 * 1000
const REBOUND_MIN_CONFIRMATIONS = 2

/**
 * 窗口内血条「低水位」：真跌立即降;明显回升(超容差且持续确认)才抬 —— 否则保持低值。
 * 没有 now(旧调用)= 纯单调(Math.min,只降不升)。传 now 启用回升:服务端值被修正抬升后,
 * 同一窗口的血条不必等重启/窗口 reset,几分钟内自己回上去(把服务端 lastFraction 的回升逻辑搬到客户端)。
 */
export function monotonicQuotaValue(
  state: Record<string, number>,
  key: string | undefined,
  value: number,
  now?: number,
): number {
  if (!key || !Number.isFinite(value) || value < 0) return value
  const lo = state[key]
  if (lo == null) {
    state[key] = value
    return value
  }
  const pv = `${key}::rb_v`, ps = `${key}::rb_since`, pc = `${key}::rb_n`
  const clearPending = () => {
    delete state[pv]
    delete state[ps]
    delete state[pc]
  }
  // 真跌:立即降,清回升确认。
  if (value < lo) {
    state[key] = value
    clearPending()
    return value
  }
  // 明显回升(超容差)+ 有时钟:连续确认够久(≥CONFIRM_MS)且够多次(≥MIN_CONF)才采纳,取确认期内最保守(最低)高值。
  if (now != null && value > lo + REBOUND_EPS) {
    if (state[pv] == null) {
      state[pv] = value
      state[ps] = now
      state[pc] = 1
    } else {
      state[pv] = Math.min(state[pv], value)
      state[pc] = (state[pc] || 0) + 1
    }
    if (now - (state[ps] ?? now) >= REBOUND_CONFIRM_MS && (state[pc] || 0) >= REBOUND_MIN_CONFIRMATIONS) {
      const accepted = state[pv]
      state[key] = accepted
      clearPending()
      return accepted
    }
    return lo
  }
  // ≈低水位 或 无时钟:不回升,清确认(要求确认必须连续)。
  clearPending()
  return lo
}

export type NestedBarDisplay = {
  /** 我的总剩余(占整号 0~1):min((X/Y)×myFraction, 账号);-1=未知。恒 ≤ accountRemain。 */
  myTotalRemain: number
  /** 账号总剩余(0~1,真实不缩放);-1=未知。 */
  accountRemain: number
  /** 我那份剩比例(0~1,健康色用)= 服务端 myFraction;-1=未知。 */
  seatFill: number
  /** 名义席位占整号(X/Y;独享=1)—— 遮超卖,真实份额 w/D 不外显。 */
  nominalShare: number
  exclusive: boolean
}

/**
 * 客户端遮超卖渲染(纯展示,服务端值保持真实):
 * 把「我那一席」按【没超卖】的名义份额 X/Y(而非真实 w/D)放大显示,再按账号余量封顶 ——
 *   我的总剩余 = min( (X/Y) × myFraction , 账号 )
 * - 名义份额遮掉超卖(看着像干净的 1/Y 席,而非被切薄的 1/D)。
 * - myFraction 已含服务端等比例缩放,用了/账号低都会让它降 → 血条等比例降。
 * - 封顶保证「我的总剩余 ≤ 账号」永不穿帮(名义 X/Y 比真实大,独占账号剩余时会顶破,故封顶)。
 * - 账号本身真实显示,不缩放(它是真池子;放大会 >100%)。
 */
export function nestedBarDisplay(input: {
  myFraction: number
  accountFraction: number
  shareSeats: number
  shareCapacity: number
  exclusive?: boolean
}): NestedBarDisplay {
  const exclusive = input.exclusive === true
  const myKnown = input.myFraction >= 0

  // 独享单层:直接 = myFraction,不按名义份额缩放、不被 accountFraction 封顶、不暴露账号层。
  if (exclusive) {
    return {
      myTotalRemain: myKnown ? clamp01(input.myFraction) : -1,
      accountRemain: -1,
      seatFill: input.myFraction,
      nominalShare: 1,
      exclusive: true,
    }
  }

  // 拼车双层:保留原逻辑(名义份额缩放 + 账号封顶)。
  const nominalShare = input.shareCapacity > 0
    ? clamp01(input.shareSeats / input.shareCapacity)
    : 1
  const acctKnown = input.accountFraction >= 0
  const raw = myKnown ? clamp01(nominalShare * input.myFraction) : -1
  const myTotalRemain = myKnown && acctKnown ? Math.min(raw, input.accountFraction) : raw
  return {
    myTotalRemain,
    accountRemain: input.accountFraction,
    seatFill: input.myFraction,
    nominalShare,
    exclusive: false,
  }
}

/**
 * 把份数(0~1)格式化成百分比文本,保留 1 位小数、整数去掉「.0」。
 * 避免 Math.round 把 12.5% 抹成 13%(份额常是 1/8=12.5%、1/4=25% 这种)。
 */
export function formatPercent(fraction: number): string {
  const rounded = Math.round(fraction * 1000) / 10 // 1 位小数
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/**
 * 把恢复剩余毫秒格式化成时长串(不含 i18n 包装)。≥24h 显示「天」(周窗口 167h → 6天23h),
 * 否则「时分」(4h 56m / 5h / 30m)。≤0 返回空串(调用方按「已恢复」处理)。
 */
export function formatResetDuration(ms: number): string {
  const totalMin = Math.ceil(ms / 60000)
  if (totalMin <= 0) return ''
  const totalHours = Math.floor(totalMin / 60)
  if (totalHours >= 24) {
    const d = Math.floor(totalHours / 24)
    const h = totalHours % 24
    return h > 0 ? `${d}天${h}h` : `${d}天`
  }
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ''}` : `${m}m`
}

export function isExclusiveCard(cardWeight: number, cardShareCapacity: number, explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit === true
  return cardShareCapacity > 0 && cardWeight >= cardShareCapacity
}

export function shouldUseExclusiveDisplay({
  cardWeight,
  cardShareCapacity,
  exclusive,
  accountProblem,
}: {
  cardWeight: number
  cardShareCapacity: number
  exclusive?: boolean
  accountProblem: boolean
}): boolean {
  return isExclusiveCard(cardWeight, cardShareCapacity, exclusive) && !accountProblem
}

function normalizeResetAt(resetAt: number | string | undefined): number | undefined {
  if (typeof resetAt === 'number') return Number.isFinite(resetAt) && resetAt > 0 ? resetAt : undefined
  if (typeof resetAt === 'string' && resetAt) {
    const parsed = Date.parse(resetAt)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
  }
  return undefined
}

function fractionFromBucket(bucket: BucketValue | undefined): DisplayQuotaValue | null {
  if (!bucket || bucket.limit <= 0) return null
  const fraction = Math.max(0, Math.min(1, (bucket.limit - bucket.used) / bucket.limit))
  const resetAt = normalizeResetAt(bucket.resetAt)
  return resetAt == null ? { fraction, resetMs: bucket.resetMs } : { fraction, resetMs: bucket.resetMs, resetAt }
}

function fractionFromMap(
  bucket: string,
  fractions: Record<string, number> | undefined,
  resets: Record<string, number> | undefined,
  resetAts?: Record<string, number> | undefined,
): DisplayQuotaValue | null {
  const fraction = fractions?.[bucket]
  if (fraction == null) return null
  const resetAt = normalizeResetAt(resetAts?.[bucket])
  return resetAt == null ? { fraction, resetMs: resets?.[bucket] } : { fraction, resetMs: resets?.[bucket], resetAt }
}

function unknownQuota(): DisplayQuotaValue {
  return { fraction: -1, resetMs: undefined }
}

export function cardScopeFiveHour(bucket: string, input: CardScopeQuotaInput): DisplayQuotaValue {
  return (
    fractionFromBucket(input.cardBuckets?.[bucket]) ??
    fractionFromMap(bucket, input.myFractions, input.myResetMs, input.myResetAt) ??
    unknownQuota()
  )
}

export function cardScopeWeekly(bucket: string, input: CardScopeQuotaInput): DisplayQuotaValue {
  return (
    fractionFromBucket(input.cardWeeklyBuckets?.[bucket]) ??
    fractionFromMap(bucket, input.myWeeklyFractions, input.myWeeklyResetMs, input.myWeeklyResetAt) ??
    unknownQuota()
  )
}

function barFromBucket(window: '5h' | '7d', label: string, bucket: BucketValue | undefined): QuotaDisplayBar | null {
  const value = fractionFromBucket(bucket)
  if (!value || !bucket) return null
  const bar: QuotaDisplayBar = {
    window,
    label,
    fraction: value.fraction,
    resetMs: value.resetMs,
    used: bucket.used,
    limit: bucket.limit,
    hideValues: true,
  }
  if (value.resetAt != null) bar.resetAt = value.resetAt
  return bar
}

function barFromFraction(
  window: '5h' | '7d',
  label: string,
  fraction: number | undefined,
  resetMs: number | undefined,
  resetAt?: number | undefined,
): QuotaDisplayBar | null {
  if (fraction == null) return null
  const bar: QuotaDisplayBar = { window, label, fraction, resetMs, used: null, limit: null, hideValues: true }
  const normalizedResetAt = normalizeResetAt(resetAt)
  if (normalizedResetAt != null) bar.resetAt = normalizedResetAt
  return bar
}

function mineBars(bucket: string, input: BuildQuotaSectionsInput): QuotaDisplayBar[] {
  const bars: QuotaDisplayBar[] = []
  const fiveHour = barFromBucket('5h', '5h 窗口', input.cardBuckets?.[bucket])
  if (fiveHour) bars.push(fiveHour)
  const weekly = barFromBucket('7d', '周窗口', input.cardWeeklyBuckets?.[bucket])
  if (weekly) bars.push(weekly)
  if (bars.length > 0) return bars

  const myFiveHour = barFromFraction('5h', '5h 份额', input.myFractions?.[bucket], input.myResetMs?.[bucket], input.myResetAt?.[bucket])
  if (myFiveHour) bars.push(myFiveHour)
  const myWeekly = barFromFraction('7d', '周份额', input.myWeeklyFractions?.[bucket], input.myWeeklyResetMs?.[bucket], input.myWeeklyResetAt?.[bucket])
  if (myWeekly) bars.push(myWeekly)
  return bars
}

function splitServiceQuota(bucket: string, input: BuildQuotaSectionsInput): SplitAccountQuota | null {
  if (bucket === 'codex-gpt') return input.codexQuota ?? null
  if (bucket === 'anthropic-claude') return input.claudeQuota ?? null
  return null
}

function serviceAccountBars(bucket: string, input: BuildQuotaSectionsInput): QuotaDisplayBar[] {
  if (input.accountProblem) {
    return [{ window: '5h', label: '5h 窗口', fraction: -1, used: null, limit: null, hideValues: true }]
  }
  const split = splitServiceQuota(bucket, input)
  if (split) {
    return [
      { window: '5h', label: '5h 窗口', fraction: split.hourlyFraction, resetMs: split.hourlyResetMs, used: null, limit: null, hideValues: true },
      { window: '7d', label: '周窗口', fraction: split.weeklyFraction, resetMs: split.weeklyResetMs, used: null, limit: null, hideValues: true },
    ]
  }
  const account = barFromFraction('5h', '5h 窗口', input.accountFractions?.[bucket], input.accountResetMs?.[bucket], input.accountResetAt?.[bucket])
  return account ? [account] : [{ window: '5h', label: '5h 窗口', fraction: -1, used: null, limit: null, hideValues: true }]
}

export function buildQuotaSections(input: BuildQuotaSectionsInput): QuotaSection[] {
  const bars = input.bars && input.bars.length > 0
    ? input.bars
    : input.bucket
      ? [{ bucket: input.bucket, label: input.seatLabel || input.bucket, seatLabel: input.seatLabel }]
      : []

  return bars.map((bar) => ({
    bucket: bar.bucket,
    title: bar.seatLabel || input.seatLabel || bar.label,
    mine: mineBars(bar.bucket, input),
    serviceAccount: serviceAccountBars(bar.bucket, input),
  }))
}
