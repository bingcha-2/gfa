export interface UsageDayStats {
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  cacheWriteTokens?: number
  savedMoneyUSD?: number
}

export interface ModelUsageStats {
  modelKey: string
  displayName?: string
  family?: string
  requests?: number
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  cacheWriteTokens?: number
  totalTokens?: number
  estimatedCostUSD?: number
}

export interface UsageOverview {
  totalTokens: number
  apiValueUSD: number
  successfulCalls: number
  errors: number
  errorRate: number
  cumulativeApiValueUSD: number
}

export interface ModelUsageRow extends Required<Omit<ModelUsageStats, 'displayName' | 'family'>> {
  displayName: string
  family: string
  costShare: number
}

const safeNumber = (value: unknown): number => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function buildUsageOverview(input: {
  today?: UsageDayStats | null
  successfulCalls: number
  errors: number
  cumulativeApiValueUSD: number
}): UsageOverview {
  const today = input.today || {}
  const successfulCalls = safeNumber(input.successfulCalls)
  const errors = safeNumber(input.errors)
  const attempts = successfulCalls + errors

  return {
    totalTokens:
      safeNumber(today.inputTokens) +
      safeNumber(today.outputTokens) +
      safeNumber(today.cachedTokens) +
      safeNumber(today.cacheWriteTokens),
    apiValueUSD: safeNumber(today.savedMoneyUSD),
    successfulCalls,
    errors,
    errorRate: attempts > 0 ? errors / attempts : 0,
    cumulativeApiValueUSD: safeNumber(input.cumulativeApiValueUSD),
  }
}

export function buildModelUsageRows(
  byModel: Record<string, ModelUsageStats> | undefined | null,
  todayCostUSD: number,
): ModelUsageRow[] {
  const costBase = safeNumber(todayCostUSD)
  return Object.entries(byModel || {})
    .map(([key, raw]) => {
      const inputTokens = safeNumber(raw.inputTokens)
      const outputTokens = safeNumber(raw.outputTokens)
      const cachedTokens = safeNumber(raw.cachedTokens)
      const cacheWriteTokens = safeNumber(raw.cacheWriteTokens)
      const totalTokens = safeNumber(raw.totalTokens) || inputTokens + outputTokens + cachedTokens + cacheWriteTokens
      const estimatedCostUSD = safeNumber(raw.estimatedCostUSD)
      return {
        modelKey: raw.modelKey || key,
        displayName: raw.displayName || raw.modelKey || key,
        family: raw.family || 'other',
        requests: safeNumber(raw.requests),
        inputTokens,
        outputTokens,
        cachedTokens,
        cacheWriteTokens,
        totalTokens,
        estimatedCostUSD,
        costShare: costBase > 0 ? estimatedCostUSD / costBase : 0,
      }
    })
    .sort((a, b) => b.estimatedCostUSD - a.estimatedCostUSD || b.totalTokens - a.totalTokens)
}
