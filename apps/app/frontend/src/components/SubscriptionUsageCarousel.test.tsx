import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { SubscriptionUsageCarousel } from './SubscriptionUsageCarousel'
import type { AccountSubscription, BoundAccountInfo } from '@/types'

vi.mock('@/i18n', () => ({ useT: () => (k: string) => k, t: (k: string) => k }))

const baseSub = {
  status: 'ACTIVE',
  expiresAt: '2030-01-01T00:00:00Z',
  deviceLimit: 1,
  remainFraction: 0.8,
}

function sub(partial: Partial<AccountSubscription>): AccountSubscription {
  return {
    id: 'sub-1',
    status: 'ACTIVE',
    expiresAt: '',
    deviceLimit: 1,
    priority: 0,
    products: ['anthropic'],
    levels: {},
    remainFraction: 0.5,
    productQuota: {},
    ...partial,
  }
}

describe('SubscriptionUsageCarousel', () => {
  it('renders double-layer account and personal quota bars when fair-share fields are present', () => {
    render(
      <SubscriptionUsageCarousel
        subscriptions={[
          sub({
            productQuota: {
              anthropic: {
                hourlyPercent: 80,
                weeklyPercent: 60,
                hourlyResetAt: null,
                weeklyResetAt: null,
                myHourlyFraction: 0.9,
                myWeeklyFraction: 0.7,
                myShare: 0.25,
              },
            },
          }),
        ]}
      />,
    )

    expect(screen.getAllByText(/我的总剩余/).length).toBe(2)
    expect(screen.getAllByText(/账号总剩余/).length).toBe(2)
  })

  it('falls back to single-layer account bars when fair-share fields are absent', () => {
    render(
      <SubscriptionUsageCarousel
        subscriptions={[
          sub({
            productQuota: {
              anthropic: {
                hourlyPercent: 80,
                weeklyPercent: 60,
                hourlyResetAt: null,
                weeklyResetAt: null,
              },
            },
          }),
        ]}
      />,
    )

    expect(screen.queryByText(/我的总剩余/)).not.toBeInTheDocument()
  })

  it('renders separate quota cards for Codex and Anthropic subscriptions at the same time', () => {
    const subscriptions: AccountSubscription[] = [
      {
        ...baseSub,
        id: 'sub-codex-1234',
        priority: 1,
        products: ['codex'],
        levels: { codex: 'pro' },
        productQuota: {
          codex: {
            hourlyPercent: 72,
            weeklyPercent: 91,
            hourlyResetAt: null,
            weeklyResetAt: null,
          },
        },
      },
      {
        ...baseSub,
        id: 'sub-anthropic-5678',
        priority: 2,
        products: ['anthropic'],
        levels: { anthropic: 'max-20x' },
        productQuota: {
          anthropic: {
            hourlyPercent: 64,
            weeklyPercent: 88,
            hourlyResetAt: null,
            weeklyResetAt: null,
          },
        },
      },
    ]

    render(<SubscriptionUsageCarousel subscriptions={subscriptions} />)

    expect(screen.getAllByText('Codex').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Anthropic').length).toBeGreaterThan(0)
    expect(screen.getByText('#1234')).toBeInTheDocument()
    expect(screen.getByText('#5678')).toBeInTheDocument()
    expect(screen.queryByLabelText('next subscription')).toBeNull()
  })

  it('shows the bound account email inline beside each product, joined by product', () => {
    const subscriptions: AccountSubscription[] = [
      sub({ id: 'sub-codex-1234', products: ['codex'], levels: { codex: 'pro' } }),
    ]
    const boundAccounts: BoundAccountInfo[] = [
      {
        product: 'codex',
        accountId: 42,
        emailHint: 'codex@example.com',
        planType: 'plus',
        accessToken: 'tok',
        expiresAt: Date.now() + 60_000,
        leasedAt: Date.now(),
      },
    ]

    render(<SubscriptionUsageCarousel subscriptions={subscriptions} boundAccounts={boundAccounts} />)

    expect(screen.getByText('codex@example.com')).toBeInTheDocument()
  })

  it('joins legacy claude product to anthropic bound account', () => {
    const subscriptions: AccountSubscription[] = [
      sub({ id: 'sub-claude', products: ['claude'], levels: { claude: 'max' } }),
    ]
    const boundAccounts: BoundAccountInfo[] = [
      {
        product: 'anthropic',
        accountId: 43,
        emailHint: 'anthropic@example.com',
        planType: 'max',
        accessToken: 'tok',
        expiresAt: Date.now() + 60_000,
        leasedAt: Date.now(),
      },
    ]

    render(<SubscriptionUsageCarousel subscriptions={subscriptions} boundAccounts={boundAccounts} />)

    expect(screen.getByText('anthropic@example.com')).toBeInTheDocument()
  })
})
