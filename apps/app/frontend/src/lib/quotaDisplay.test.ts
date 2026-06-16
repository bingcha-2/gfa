import { describe, expect, it } from 'vitest'

import {
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
})

describe('shouldUseExclusiveDisplay', () => {
  it('requires both exclusivity and no account problem', () => {
    expect(shouldUseExclusiveDisplay({ cardWeight: 8, cardShareCapacity: 8, accountProblem: false })).toBe(true)
    expect(shouldUseExclusiveDisplay({ cardWeight: 8, cardShareCapacity: 8, accountProblem: true })).toBe(false)
    expect(shouldUseExclusiveDisplay({ cardWeight: 1, cardShareCapacity: 8, accountProblem: false })).toBe(false)
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
