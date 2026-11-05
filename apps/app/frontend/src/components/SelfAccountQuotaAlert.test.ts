import { describe, expect, it } from 'vitest'

import { findLowSelfAccountWindows } from './SelfAccountQuotaAlert'
import { quotaReminderKey } from '@/lib/selfAccounts'
import { selfAccountQuotaStatus } from '@/pages/SelfAccountsPage'
import type { SelfAccount } from '@/types'

function account(overrides: Partial<SelfAccount> = {}): SelfAccount {
  return {
    id: 'a1', alias: '', email: 'a@example.com', accountId: 'upstream-a1', planType: 'plus', current: true,
    createdAt: 0, updatedAt: 0, lastUsedAt: 0,
    quota: {
      fiveHour: { remaining: 20, resetAt: 100, known: true },
      weekly: { remaining: 42, resetAt: 200, known: true },
    },
    ...overrides,
  }
}

describe('findLowSelfAccountWindows', () => {
  it('includes a known window at the configured threshold', () => {
    expect(findLowSelfAccountWindows(account(), 20).map((window) => window.name)).toEqual(['5 小时'])
  })

  it('does not treat an unknown quota as empty', () => {
    const value = account({ quota: { fiveHour: { remaining: 0, resetAt: 0, known: false } } })
    expect(findLowSelfAccountWindows(value, 20)).toEqual([])
  })

  it('uses a bounded fallback cycle when reset time is missing', () => {
    const quota = { remaining: 12, resetAt: 0, known: true }
    const first = quotaReminderKey('a1', '5 小时', quota, 10 * 60 * 60 * 1000)
    const sameCycle = quotaReminderKey('a1', '5 小时', quota, 14 * 60 * 60 * 1000)
    const nextCycle = quotaReminderKey('a1', '5 小时', quota, 15 * 60 * 60 * 1000)
    expect(sameCycle).toBe(first)
    expect(nextCycle).not.toBe(first)
  })

  it('keeps the last successful update visible after a refresh error', () => {
    const value = account({ quota: {
      fiveHour: { remaining: 20, resetAt: 100, known: true },
      fetchedAt: 1_800_000_000_000,
      error: '额度请求失败',
    } })
    const status = selfAccountQuotaStatus(value)
    expect(status).toContain('额度请求失败')
    expect(status).toContain('上次更新')
  })
})
