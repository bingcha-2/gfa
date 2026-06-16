import { describe, expect, it } from 'vitest'

import { buildModelUsageRows, buildUsageOverview } from './usageSummary'

describe('usage summary helpers', () => {
  it('builds the user-facing overview without billable tokens', () => {
    const overview = buildUsageOverview({
      today: {
        inputTokens: 100,
        outputTokens: 200,
        cachedTokens: 30,
        cacheWriteTokens: 40,
        savedMoneyUSD: 0.5,
      },
      successfulCalls: 3,
      errors: 1,
      cumulativeApiValueUSD: 12.34,
    })

    expect(overview.totalTokens).toBe(370)
    expect(overview.apiValueUSD).toBe(0.5)
    expect(overview.successfulCalls).toBe(3)
    expect(overview.errors).toBe(1)
    expect(overview.errorRate).toBe(0.25)
    expect(overview.cumulativeApiValueUSD).toBe(12.34)
  })

  it('sorts model rows by API value and computes today cost share', () => {
    const rows = buildModelUsageRows({
      'claude-sonnet-4': {
        modelKey: 'claude-sonnet-4',
        displayName: 'Claude Sonnet',
        family: 'claude',
        requests: 2,
        inputTokens: 100,
        outputTokens: 80,
        cachedTokens: 10,
        cacheWriteTokens: 20,
        totalTokens: 210,
        estimatedCostUSD: 0.8,
      },
      'gpt-5-codex': {
        modelKey: 'gpt-5-codex',
        displayName: 'GPT Codex',
        family: 'gpt',
        requests: 1,
        inputTokens: 70,
        outputTokens: 30,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 100,
        estimatedCostUSD: 0.2,
      },
    }, 1)

    expect(rows.map((r) => r.modelKey)).toEqual(['claude-sonnet-4', 'gpt-5-codex'])
    expect(rows[0].totalTokens).toBe(210)
    expect(rows[0].costShare).toBe(0.8)
    expect(rows[1].costShare).toBe(0.2)
  })
})
