import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SubscriptionUsageCarousel } from './SubscriptionUsageCarousel'
import type { AccountSubscription } from '@/types'

vi.mock('@/i18n', () => ({ useT: () => (k: string) => k, t: (k: string) => k }))

function sub(partial: Partial<AccountSubscription>): AccountSubscription {
  return {
    id: 'sub-1', status: 'ACTIVE', expiresAt: '', deviceLimit: 1, priority: 0,
    products: ['anthropic'], levels: {}, remainFraction: 0.5, productQuota: {},
    ...partial,
  }
}

describe('SubscriptionUsageCarousel double-layer', () => {
  it('renders 双层血条(母号 + 我的) per window when fair-share my* present', () => {
    const s = sub({
      productQuota: {
        anthropic: {
          hourlyPercent: 80, weeklyPercent: 60, hourlyResetAt: null, weeklyResetAt: null,
          myHourlyFraction: 0.9, myWeeklyFraction: 0.7, myShare: 0.25,
        },
      },
    })
    render(<SubscriptionUsageCarousel subscriptions={[s]} />)
    // NestedShareBar 渲染「我的总剩余」「账号总剩余」两层文案,5h + 周各一条
    expect(screen.getAllByText(/我的总剩余/).length).toBe(2)
    expect(screen.getAllByText(/账号总剩余/).length).toBe(2)
  })

  it('falls back to single-layer account bar when my* absent (老服务端/取不到)', () => {
    const s = sub({
      productQuota: {
        anthropic: { hourlyPercent: 80, weeklyPercent: 60, hourlyResetAt: null, weeklyResetAt: null },
      },
    })
    render(<SubscriptionUsageCarousel subscriptions={[s]} />)
    expect(screen.queryByText(/我的总剩余/)).not.toBeInTheDocument()
  })
})
