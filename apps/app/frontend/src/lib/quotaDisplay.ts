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
}

export function isExclusiveCard(cardWeight: number, cardShareCapacity: number): boolean {
  return cardShareCapacity > 0 && cardWeight >= cardShareCapacity
}

export function shouldUseExclusiveDisplay({
  cardWeight,
  cardShareCapacity,
  accountProblem,
}: {
  cardWeight: number
  cardShareCapacity: number
  accountProblem: boolean
}): boolean {
  return isExclusiveCard(cardWeight, cardShareCapacity) && !accountProblem
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
