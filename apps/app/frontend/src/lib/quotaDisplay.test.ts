import { describe, expect, it } from 'vitest'

import {
  buildQuotaSections,
  cardScopeFiveHour,
  cardScopeWeekly,
  isExclusiveCard,
  shouldUseExclusiveDisplay,
} from './quotaDisplay'

describe('isExclusiveCard', () => {
  it('treats full-capacity cards as exclusive', () => {
    expect(isExclusiveCard(8, 8)).toBe(true)
    expect(isExclusiveCard(9, 8)).toBe(true)
  })

  it('does not treat shared or missing-capacity cards as exclusive', () => {
    expect(isExclusiveCard(1, 8)).toBe(false)
    expect(isExclusiveCard(8, 0)).toBe(false)
  })

  it('honors the explicit exclusive flag as authoritative over the weight heuristic', () => {
    // 后端现在下发显式 exclusive(权威),不再靠 weight>=capacity 推断。
    expect(isExclusiveCard(1, 8, true)).toBe(true) // 显式独享:即便 weight<capacity
    expect(isExclusiveCard(8, 8, false)).toBe(false) // 显式非独享:即便占满容量
  })
})

describe('shouldUseExclusiveDisplay', () => {
  it('requires both exclusivity and no account problem', () => {
    expect(shouldUseExclusiveDisplay({ cardWeight: 8, cardShareCapacity: 8, accountProblem: false })).toBe(true)
    expect(shouldUseExclusiveDisplay({ cardWeight: 8, cardShareCapacity: 8, accountProblem: true })).toBe(false)
    expect(shouldUseExclusiveDisplay({ cardWeight: 1, cardShareCapacity: 8, accountProblem: false })).toBe(false)
  })

  it('uses the explicit exclusive flag when provided', () => {
    expect(shouldUseExclusiveDisplay({ cardWeight: 1, cardShareCapacity: 8, exclusive: true, accountProblem: false })).toBe(true)
    expect(shouldUseExclusiveDisplay({ cardWeight: 8, cardShareCapacity: 8, exclusive: false, accountProblem: false })).toBe(false)
  })
})

describe('cardScopeFiveHour', () => {
  it('uses static card bucket data before account fractions', () => {
    const got = cardScopeFiveHour('codex-gpt', {
      cardBuckets: {
        'codex-gpt': { used: 25, limit: 100, resetMs: 1234 },
      },
      myFractions: {
        'codex-gpt': 0.2,
      },
      myResetMs: {
        'codex-gpt': 9999,
      },
    })

    expect(got).toEqual({ fraction: 0.75, resetMs: 1234 })
  })

  it('uses dynamic fair-share data when no static bucket exists', () => {
    const got = cardScopeFiveHour('anthropic-claude', {
      myFractions: {
        'anthropic-claude': 0.4,
      },
      myResetMs: {
        'anthropic-claude': 2222,
      },
    })

    expect(got).toEqual({ fraction: 0.4, resetMs: 2222 })
  })

  it('returns unknown when exclusive display has no card-scope data', () => {
    const got = cardScopeFiveHour('antigravity-gemini', {
      cardBuckets: {},
      myFractions: {},
      myResetMs: {},
    })

    expect(got).toEqual({ fraction: -1, resetMs: undefined })
  })
})

describe('cardScopeWeekly', () => {
  it('uses static weekly bucket data before dynamic weekly fair-share data', () => {
    const got = cardScopeWeekly('codex-gpt', {
      cardWeeklyBuckets: {
        'codex-gpt': { used: 40, limit: 100, resetMs: 7777 },
      },
      myWeeklyFractions: {
        'codex-gpt': 0.1,
      },
      myWeeklyResetMs: {
        'codex-gpt': 1111,
      },
    })

    expect(got).toEqual({ fraction: 0.6, resetMs: 7777 })
  })

  it('uses dynamic weekly fair-share data when no static weekly bucket exists', () => {
    const got = cardScopeWeekly('anthropic-claude', {
      myWeeklyFractions: {
        'anthropic-claude': 0.35,
      },
      myWeeklyResetMs: {
        'anthropic-claude': 3333,
      },
    })

    expect(got).toEqual({ fraction: 0.35, resetMs: 3333 })
  })

  it('returns unknown when weekly card-scope data is absent', () => {
    const got = cardScopeWeekly('codex-gpt', {})

    expect(got).toEqual({ fraction: -1, resetMs: undefined })
  })
})

describe('buildQuotaSections', () => {
  it('builds separate seat and service-account bars for one bucket', () => {
    const got = buildQuotaSections({
      bucket: 'anthropic-claude',
      seatLabel: 'Claude · 2/8 席',
      cardBuckets: { 'anthropic-claude': { used: 5, limit: 20, resetMs: 1000 } },
      cardWeeklyBuckets: { 'anthropic-claude': { used: 10, limit: 100, resetMs: 7000 } },
      accountFractions: { 'anthropic-claude': 0.5 },
      accountResetMs: { 'anthropic-claude': 2000 },
    })

    expect(got).toMatchObject([
      {
        title: 'Claude · 2/8 席',
        mine: [{ window: '5h', hideValues: true }, { window: '7d', hideValues: true }],
        serviceAccount: [{ window: '5h', fraction: 0.5, resetMs: 2000 }],
      },
    ])
  })

  it('prefers split Codex service-account windows over account fractions', () => {
    const got = buildQuotaSections({
      bucket: 'codex-gpt',
      seatLabel: 'Codex · 1/8 席',
      myFractions: { 'codex-gpt': 0.8 },
      myResetMs: { 'codex-gpt': 1000 },
      accountFractions: { 'codex-gpt': 0.2 },
      accountResetMs: { 'codex-gpt': 2000 },
      codexQuota: { hourlyFraction: 0.7, weeklyFraction: 0.4, hourlyResetMs: 3000, weeklyResetMs: 9000 },
    })

    expect(got[0].mine).toMatchObject([{ window: '5h', fraction: 0.8, resetMs: 1000 }])
    expect(got[0].serviceAccount).toMatchObject([
      { window: '5h', fraction: 0.7, resetMs: 3000 },
      { window: '7d', fraction: 0.4, resetMs: 9000 },
    ])
  })
})

describe('exclusive account display selection', () => {
  it('lets dashboard replace account 5h display with card-scope 5h display', () => {
    const exclusive = shouldUseExclusiveDisplay({ cardWeight: 8, cardShareCapacity: 8, accountProblem: false })
    const accountFraction = 0.05
    const display = exclusive
      ? cardScopeFiveHour('codex-gpt', {
          myFractions: { 'codex-gpt': 0.8 },
          myResetMs: { 'codex-gpt': 5000 },
        })
      : { fraction: accountFraction, resetMs: 1000 }

    expect(display).toEqual({ fraction: 0.8, resetMs: 5000 })
  })

  it('keeps non-exclusive dashboard display on real account data', () => {
    const exclusive = shouldUseExclusiveDisplay({ cardWeight: 1, cardShareCapacity: 8, accountProblem: false })
    const accountFraction = 0.05
    const display = exclusive
      ? cardScopeFiveHour('codex-gpt', {
          myFractions: { 'codex-gpt': 0.8 },
          myResetMs: { 'codex-gpt': 5000 },
        })
      : { fraction: accountFraction, resetMs: 1000 }

    expect(display).toEqual({ fraction: 0.05, resetMs: 1000 })
  })

  it('lets dashboard replace account weekly display with card-scope weekly display', () => {
    const exclusive = shouldUseExclusiveDisplay({ cardWeight: 8, cardShareCapacity: 8, accountProblem: false })
    const display = exclusive
      ? cardScopeWeekly('anthropic-claude', {
          myWeeklyFractions: { 'anthropic-claude': 0.7 },
          myWeeklyResetMs: { 'anthropic-claude': 7000 },
        })
      : { fraction: 0.2, resetMs: 2000 }

    expect(display).toEqual({ fraction: 0.7, resetMs: 7000 })
  })
})
