import { describe, expect, it } from 'vitest'

import { formatResetDuration, quotaRemainingPercent } from './quotaDisplay'

describe('formatResetDuration', () => {
  it('formats five-hour and weekly reset windows', () => {
    expect(formatResetDuration(5 * 60 * 60_000)).toBe('5h')
    expect(formatResetDuration((167 * 60 + 58) * 60_000)).toBe('6天23h')
    expect(formatResetDuration(0)).toBe('')
  })
})

describe('quotaRemainingPercent', () => {
  it('returns a clamped integer remaining percentage without exposing amounts', () => {
    expect(quotaRemainingPercent(32.5, 800)).toBe(96)
    expect(quotaRemainingPercent(105, 100)).toBe(0)
    expect(quotaRemainingPercent(0, 0)).toBe(100)
  })
})
