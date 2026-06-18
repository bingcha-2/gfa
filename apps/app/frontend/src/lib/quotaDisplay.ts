type BucketValue = {
  used: number
  limit: number
  resetMs?: number
}

export type DisplayQuotaValue = {
  fraction: number
  resetMs?: number
}

export type CardScopeQuotaInput = {
  cardBuckets?: Record<string, BucketValue>
  cardWeeklyBuckets?: Record<string, BucketValue>
  myFractions?: Record<string, number>
  myResetMs?: Record<string, number>
  myWeeklyFractions?: Record<string, number>
  myWeeklyResetMs?: Record<string, number>
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
  codexQuota?: SplitAccountQuota | null
  claudeQuota?: SplitAccountQuota | null
  accountProblem?: boolean
}

/**
 * 是否独享卡。后端现在下发显式 exclusive(权威);提供时以它为准,
 * 否则回退老的 weight>=capacity 推断(兼容旧服务端/旧缓存)。
 */
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

function fractionFromBucket(bucket: BucketValue | undefined): DisplayQuotaValue | null {
  if (!bucket || bucket.limit <= 0) return null
  const fraction = Math.max(0, Math.min(1, (bucket.limit - bucket.used) / bucket.limit))
  return { fraction, resetMs: bucket.resetMs }
}

function fractionFromMap(
  bucket: string,
  fractions: Record<string, number> | undefined,
  resets: Record<string, number> | undefined,
): DisplayQuotaValue | null {
  const fraction = fractions?.[bucket]
  if (fraction == null) return null
  return { fraction, resetMs: resets?.[bucket] }
}

function unknownQuota(): DisplayQuotaValue {
  return { fraction: -1, resetMs: undefined }
}

export function cardScopeFiveHour(bucket: string, input: CardScopeQuotaInput): DisplayQuotaValue {
  return (
    fractionFromBucket(input.cardBuckets?.[bucket]) ??
    fractionFromMap(bucket, input.myFractions, input.myResetMs) ??
    unknownQuota()
  )
}

export function cardScopeWeekly(bucket: string, input: CardScopeQuotaInput): DisplayQuotaValue {
  return (
    fractionFromBucket(input.cardWeeklyBuckets?.[bucket]) ??
    fractionFromMap(bucket, input.myWeeklyFractions, input.myWeeklyResetMs) ??
    unknownQuota()
  )
}

function barFromBucket(window: '5h' | '7d', label: string, bucket: BucketValue | undefined): QuotaDisplayBar | null {
  const value = fractionFromBucket(bucket)
  if (!value || !bucket) return null
  return {
    window,
    label,
    fraction: value.fraction,
    resetMs: value.resetMs,
    used: bucket.used,
    limit: bucket.limit,
    hideValues: true,
  }
}

function barFromFraction(
  window: '5h' | '7d',
  label: string,
  fraction: number | undefined,
  resetMs: number | undefined,
): QuotaDisplayBar | null {
  if (fraction == null) return null
  return { window, label, fraction, resetMs, used: null, limit: null, hideValues: true }
}

function mineBars(bucket: string, input: BuildQuotaSectionsInput): QuotaDisplayBar[] {
  const bars: QuotaDisplayBar[] = []
  const fiveHour = barFromBucket('5h', '5h 窗口', input.cardBuckets?.[bucket])
  if (fiveHour) bars.push(fiveHour)
  const weekly = barFromBucket('7d', '周窗口', input.cardWeeklyBuckets?.[bucket])
  if (weekly) bars.push(weekly)
  if (bars.length > 0) return bars

  const myFiveHour = barFromFraction('5h', '5h 份额', input.myFractions?.[bucket], input.myResetMs?.[bucket])
  if (myFiveHour) bars.push(myFiveHour)
  const myWeekly = barFromFraction('7d', '周份额', input.myWeeklyFractions?.[bucket], input.myWeeklyResetMs?.[bucket])
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
  const account = barFromFraction('5h', '5h 窗口', input.accountFractions?.[bucket], input.accountResetMs?.[bucket])
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
