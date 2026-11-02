import { describe, expect, it } from 'vitest'
import { selectUsageDays, usageRangeBounds, formatUsageTokens } from './usageRange'
describe('usage periods', () => {
  const monday = new Date('2026-11-02T12:00:00Z')
  it('distinguishes rolling days from calendar weeks and months', () => {
    expect(usageRangeBounds('3day', monday, true)).toEqual({ start: '2026-10-31', end: '2026-11-02' })
    expect(usageRangeBounds('week', monday, true)).toEqual({ start: '2026-10-27', end: '2026-11-02' })
    expect(usageRangeBounds('thisWeek', monday, true)).toEqual({ start: '2026-11-02', end: '2026-11-02' })
    expect(usageRangeBounds('lastWeek', monday, true)).toEqual({ start: '2026-10-26', end: '2026-11-01' })
    expect(usageRangeBounds('month', monday, true)).toEqual({ start: '2026-11-01', end: '2026-11-02' })
    expect(usageRangeBounds('month', new Date('2026-10-31T23:00:00Z'), true).start).toBe('2026-10-01')
  })
  it('includes both boundaries and sorts days without mutating the source', () => {
    const rows = [{ date: '2026-11-02' }, { date: '2026-11-01' }, { date: '2026-10-26' }, { date: '2026-10-25' }]
    expect(selectUsageDays(rows, 'lastWeek', true, monday)).toEqual([{ date: '2026-10-26' }, { date: '2026-11-01' }])
    expect(rows[0].date).toBe('2026-11-02')
  })
})

it('keeps small nonzero counts visible and abbreviates large counts', () => {
 expect(formatUsageTokens(4)).toBe('4'); expect(formatUsageTokens(179149)).toBe('179.15K'); expect(formatUsageTokens(1200000)).toBe('1.2M')
})
