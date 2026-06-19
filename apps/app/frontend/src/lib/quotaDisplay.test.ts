import { describe, expect, it } from 'vitest'

import {
  buildQuotaSections,
  cardScopeFiveHour,
  cardScopeWeekly,
  formatPercent,
  formatResetDuration,
  isExclusiveCard,
  monotonicQuotaValue,
  nestedBarDisplay,
  shouldUseExclusiveDisplay,
} from './quotaDisplay'

describe('monotonicQuotaValue', () => {
  it('prevents a displayed quota from rebounding inside the same reset window', () => {
    const state: Record<string, number> = {}
    const key = 'anthropic-claude:5h:1800000'

    expect(monotonicQuotaValue(state, key, 0.10)).toBeCloseTo(0.10, 6)
    expect(monotonicQuotaValue(state, key, 0.12)).toBeCloseTo(0.10, 6)
    expect(monotonicQuotaValue(state, key, 0.098)).toBeCloseTo(0.098, 6)
  })

  it('accepts the current value again when the reset window identity changes', () => {
    const state: Record<string, number> = {}

    expect(monotonicQuotaValue(state, 'anthropic-claude:5h:1000', 0.10)).toBeCloseTo(0.10, 6)
    expect(monotonicQuotaValue(state, 'anthropic-claude:5h:1000', 0.12)).toBeCloseTo(0.10, 6)
    expect(monotonicQuotaValue(state, 'anthropic-claude:5h:2000', 0.95)).toBeCloseTo(0.95, 6)
  })

  it('does not cache unknown values', () => {
    const state: Record<string, number> = {}

    expect(monotonicQuotaValue(state, 'anthropic-claude:5h:1000', -1)).toBe(-1)
    expect(state).toEqual({})
  })

  it('keeps independent floors for buckets and windows under interleaved updates', () => {
    const state: Record<string, number> = {}

    expect(monotonicQuotaValue(state, 'acct-a:anthropic-claude:5h:1000:total', 0.10)).toBeCloseTo(0.10, 6)
    expect(monotonicQuotaValue(state, 'acct-a:anthropic-claude:7d:7000:total', 0.70)).toBeCloseTo(0.70, 6)
    expect(monotonicQuotaValue(state, 'acct-b:anthropic-claude:5h:1000:total', 0.30)).toBeCloseTo(0.30, 6)

    expect(monotonicQuotaValue(state, 'acct-a:anthropic-claude:5h:1000:total', 0.12)).toBeCloseTo(0.10, 6)
    expect(monotonicQuotaValue(state, 'acct-a:anthropic-claude:7d:7000:total', 0.80)).toBeCloseTo(0.70, 6)
    expect(monotonicQuotaValue(state, 'acct-b:anthropic-claude:5h:1000:total', 0.35)).toBeCloseTo(0.30, 6)
  })

  it('handles out-of-order higher corrections while still accepting new lows', () => {
    const state: Record<string, number> = {}
    const key = 'anthropic-claude:5h:1000'
    const rendered = [0.12, 0.11, 0.115, 0.09, 0.095].map((value) => monotonicQuotaValue(state, key, value))

    expect(rendered).toEqual([0.12, 0.11, 0.11, 0.09, 0.09])
  })

  it('does not freeze expired or unidentified windows without a display key', () => {
    const state: Record<string, number> = {}

    expect(monotonicQuotaValue(state, undefined, 0.10)).toBeCloseTo(0.10, 6)
    expect(monotonicQuotaValue(state, undefined, 0.95)).toBeCloseTo(0.95, 6)
    expect(state).toEqual({})
  })

  it('starts from the server value after a client restart loses in-memory display state', () => {
    const key = 'anthropic-claude:5h:1000'
    const beforeCrash: Record<string, number> = {}
    expect(monotonicQuotaValue(beforeCrash, key, 0.10)).toBeCloseTo(0.10, 6)
    expect(monotonicQuotaValue(beforeCrash, key, 0.12)).toBeCloseTo(0.10, 6)

    const afterRestart: Record<string, number> = {}
    expect(monotonicQuotaValue(afterRestart, key, 0.12)).toBeCloseTo(0.12, 6)
  })
})

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
  it('carries fair-share resetAt identities into mine bars', () => {
    const got = buildQuotaSections({
      bucket: 'anthropic-claude',
      myFractions: { 'anthropic-claude': 0.8 },
      myResetMs: { 'anthropic-claude': 1000 },
      myResetAt: { 'anthropic-claude': 11_000 },
      myWeeklyFractions: { 'anthropic-claude': 0.6 },
      myWeeklyResetMs: { 'anthropic-claude': 7000 },
      myWeeklyResetAt: { 'anthropic-claude': 77_000 },
    })

    expect((got[0].mine[0] as any).resetAt).toBe(11_000)
    expect((got[0].mine[1] as any).resetAt).toBe(77_000)
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

describe('nestedBarDisplay (客户端遮超卖:8人车口径 + 账号封顶)', () => {
  const seat = { shareSeats: 1, shareCapacity: 8 } // 名义席位 1/8 = 12.5%

  it('N1 5h 健康超卖:我的总剩余按 1/8 放大(满血 12.5%),账号不缩放', () => {
    const d = nestedBarDisplay({ myFraction: 1, accountFraction: 1, ...seat })
    expect(d.nominalShare).toBeCloseTo(0.125, 6)
    expect(d.myTotalRemain).toBeCloseTo(0.125, 6) // 12.5%,不再露出真实 10%
    expect(d.accountRemain).toBeCloseTo(1, 6)
  })

  it('N2 周冷启动低账号:我的总剩余 = 1/8 × 6% = 0.75% ≤ 账号 6%', () => {
    const d = nestedBarDisplay({ myFraction: 0.06, accountFraction: 0.06, ...seat })
    expect(d.myTotalRemain).toBeCloseTo(0.0075, 6)
    expect(d.myTotalRemain).toBeLessThanOrEqual(d.accountRemain + 1e-9)
  })

  it('N3 用了一半(账号健康):12.5% × 50% = 6.25%', () => {
    const d = nestedBarDisplay({ myFraction: 0.5, accountFraction: 0.9, ...seat })
    expect(d.myTotalRemain).toBeCloseTo(0.0625, 6)
  })

  it('N4 独占账号剩余的边界:1/8 放大会超账号 → 封顶到账号(永不穿帮)', () => {
    // 别人都用光、就剩你:账号只剩 10%,1/8×100%=12.5% > 10% → 封顶 10%
    const d = nestedBarDisplay({ myFraction: 1, accountFraction: 0.1, ...seat })
    expect(d.myTotalRemain).toBeCloseTo(0.1, 6) // = 账号,不是 12.5%
    expect(d.myTotalRemain).toBeLessThanOrEqual(d.accountRemain + 1e-9)
  })

  it('N5 独享卡:名义份额=1,我的总剩余 = min(myFraction, 账号)', () => {
    const d = nestedBarDisplay({ myFraction: 0.3, accountFraction: 0.5, shareSeats: 8, shareCapacity: 8, exclusive: true })
    expect(d.nominalShare).toBeCloseTo(1, 6)
    expect(d.myTotalRemain).toBeCloseTo(0.3, 6)
  })

  it('N6 我的份额未知(-1)→ 我的总剩余未知', () => {
    const d = nestedBarDisplay({ myFraction: -1, accountFraction: 0.5, ...seat })
    expect(d.myTotalRemain).toBe(-1)
  })

  it('N7 账号未知(-1)→ 不封顶,纯 1/8 口径', () => {
    const d = nestedBarDisplay({ myFraction: 1, accountFraction: -1, ...seat })
    expect(d.myTotalRemain).toBeCloseTo(0.125, 6)
  })

  it('N8 账号见底(0)→ 我的总剩余归 0', () => {
    const d = nestedBarDisplay({ myFraction: 1, accountFraction: 0, ...seat })
    expect(d.myTotalRemain).toBeCloseTo(0, 6)
  })

  it('N9 多席位(2/8)→ 名义份额 25%', () => {
    const d = nestedBarDisplay({ myFraction: 1, accountFraction: 1, shareSeats: 2, shareCapacity: 8 })
    expect(d.nominalShare).toBeCloseTo(0.25, 6)
    expect(d.myTotalRemain).toBeCloseTo(0.25, 6)
  })

  it('N10 容量缺失(Y=0)守卫:退化成 1(不除零)', () => {
    const d = nestedBarDisplay({ myFraction: 0.5, accountFraction: 0.5, shareSeats: 1, shareCapacity: 0 })
    expect(d.nominalShare).toBeCloseTo(1, 6)
    expect(d.myTotalRemain).toBeCloseTo(0.5, 6)
  })

  it('N11 不变量:已知时我的总剩余恒 ≤ 账号(扫一组)', () => {
    for (const myFraction of [0, 0.13, 0.5, 0.87, 1]) {
      for (const accountFraction of [0, 0.06, 0.5, 1]) {
        for (const shareSeats of [1, 2, 4]) {
          const d = nestedBarDisplay({ myFraction, accountFraction, shareSeats, shareCapacity: 8 })
          expect(d.myTotalRemain).toBeLessThanOrEqual(d.accountRemain + 1e-9)
        }
      }
    }
  })
})

describe('formatPercent (保留小数,整数不带 .0)', () => {
  it('P1 12.5% 不四舍五入成 13', () => {
    expect(formatPercent(0.125)).toBe('12.5')
  })
  it('P2 整数去掉 .0', () => {
    expect(formatPercent(1)).toBe('100')
    expect(formatPercent(0.06)).toBe('6')
    expect(formatPercent(0)).toBe('0')
  })
  it('P3 小值保留 1 位小数', () => {
    expect(formatPercent(0.006)).toBe('0.6')
    expect(formatPercent(0.0075)).toBe('0.8') // 0.75 → 1 位 → 0.8
  })
  it('P4 接近满', () => {
    expect(formatPercent(0.999)).toBe('99.9')
  })
})

describe('formatResetDuration (>24h 显示天)', () => {
  it('F1 不足 1 小时 → 分', () => {
    expect(formatResetDuration(30 * 60_000)).toBe('30m')
  })
  it('F2 小于 24h → 时分', () => {
    expect(formatResetDuration((4 * 60 + 56) * 60_000)).toBe('4h 56m')
  })
  it('F3 整小时 → 只显示时', () => {
    expect(formatResetDuration(5 * 60 * 60_000)).toBe('5h')
  })
  it('F4 恰好 24h → 1天', () => {
    expect(formatResetDuration(24 * 60 * 60_000)).toBe('1天')
  })
  it('F5 167h58m(周窗口)→ 6天23h', () => {
    expect(formatResetDuration((167 * 60 + 58) * 60_000)).toBe('6天23h')
  })
  it('F6 25h → 1天1h', () => {
    expect(formatResetDuration(25 * 60 * 60_000)).toBe('1天1h')
  })
  it('F7 已恢复(≤0)→ 空串', () => {
    expect(formatResetDuration(0)).toBe('')
  })
})
