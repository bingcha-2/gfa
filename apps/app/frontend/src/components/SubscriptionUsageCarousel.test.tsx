import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { SubscriptionUsageCarousel } from './SubscriptionUsageCarousel'
import type { AccountSubscription } from '@/types'

vi.mock('@/i18n', () => ({ useT: () => (key: string) => key, t: (key: string) => key }))

function sub(partial: Partial<AccountSubscription> = {}): AccountSubscription {
  return {
    id: 'sub-codex-1234',
    status: 'ACTIVE',
    expiresAt: '',
    deviceLimit: 1,
    priority: 0,
    products: ['codex'],
    levels: { codex: 'pro-20x' },
    usdQuotaByProduct: {
      codex: {
        fiveHour: { used: 32.5, limit: 800, resetAt: null },
        weekly: { used: 712.25, limit: 7000, resetAt: null },
      },
    },
    exclusive: false,
    shareSeats: 2,
    ...partial,
  }
}

describe('SubscriptionUsageCarousel', () => {
  it('renders only percentage quota bars without exposing monetary amounts', () => {
    render(<SubscriptionUsageCarousel subscriptions={[sub()]} />)

    expect(screen.getByText('5 小时额度')).toBeInTheDocument()
    expect(screen.getByText('每周额度')).toBeInTheDocument()
    expect(screen.getByText('2 份')).toBeInTheDocument()
    expect(screen.getByText('96%')).toBeInTheDocument()
    expect(screen.getByText('90%')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: '5 小时额度剩余' })).toHaveAttribute('aria-valuenow', '96')
    expect(screen.queryByText(/\$|单份|总额|已用金额/)).not.toBeInTheDocument()
    expect(screen.queryByText(/母号|绑定账号|账号总剩余/)).not.toBeInTheDocument()
  })

  it('clamps overage to zero percent without exposing the overage amount', () => {
    render(<SubscriptionUsageCarousel subscriptions={[sub({
      usdQuotaByProduct: { codex: { fiveHour: { used: 105, limit: 100, resetAt: null }, weekly: null } },
      shareSeats: 1,
    })]} />)

    expect(screen.getByText('0%')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
    expect(screen.queryByText(/\$|105|100/)).not.toBeInTheDocument()
  })

  it('maps remaining quota boundaries to semantic bar and high-contrast text colors', () => {
    const withRemaining = (remaining: number): AccountSubscription => sub({
      usdQuotaByProduct: {
        codex: {
          fiveHour: null,
          weekly: { used: 100 - remaining, limit: 100, resetAt: null },
        },
      },
      shareSeats: 1,
    })
    const { rerender } = render(<SubscriptionUsageCarousel subscriptions={[withRemaining(100)]} />)

    const assertTone = (
      remaining: number,
      tone: 'normal' | 'warning' | 'danger',
      barColor: string,
      textColor: string,
      label: string,
    ) => {
      rerender(<SubscriptionUsageCarousel subscriptions={[withRemaining(remaining)]} />)
      const bar = screen.getByRole('progressbar', { name: '每周额度剩余' })
      expect(bar).toHaveAttribute('data-quota-tone', tone)
      expect(bar).toHaveAttribute('aria-valuetext', `剩余 ${remaining}%，${label}`)
      expect(bar.firstElementChild).toHaveStyle({ backgroundColor: barColor })
      expect(screen.getByText(`${remaining}%`)).toHaveStyle({ color: textColor })
    }

    assertTone(100, 'normal', 'var(--success)', 'var(--success-strong)', '正常')
    assertTone(40, 'normal', 'var(--success)', 'var(--success-strong)', '正常')
    assertTone(39, 'warning', 'var(--warning)', 'var(--warning-deep)', '提醒')
    assertTone(15, 'warning', 'var(--warning)', 'var(--warning-deep)', '提醒')
    assertTone(14, 'danger', 'var(--danger)', 'var(--danger)', '危险')
    assertTone(0, 'danger', 'var(--danger)', 'var(--danger)', '危险')
  })

  it('supports plans configured with only one window', () => {
    render(<SubscriptionUsageCarousel subscriptions={[sub({
      usdQuotaByProduct: { codex: { fiveHour: null, weekly: { used: 80, limit: 875, resetAt: null } } },
      shareSeats: 1,
    })]} />)

    expect(screen.queryByText('5 小时额度')).not.toBeInTheDocument()
    expect(screen.getByText('每周额度')).toBeInTheDocument()
  })

  it('shows a neutral message for subscriptions that do not use dollar quotas', () => {
    render(<SubscriptionUsageCarousel subscriptions={[sub({ products: ['antigravity'], usdQuotaByProduct: {} })]} />)

    expect(screen.getByText('该产品暂未配置额度')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('uses the explicit subscription-level exclusive flag', () => {
    render(<SubscriptionUsageCarousel subscriptions={[sub({ exclusive: true })]} />)
    expect(screen.getByText(/尊贵 · 独享/)).toBeInTheDocument()
  })

  it('keeps separate cards for multiple subscriptions in priority order', () => {
    render(<SubscriptionUsageCarousel subscriptions={[
      sub({
        id: 'sub-anthropic-5678', priority: 2, products: ['anthropic'], levels: { anthropic: 'max-20x' },
        usdQuotaByProduct: {
          anthropic: {
            fiveHour: { used: 20, limit: 400, resetAt: null },
            weekly: { used: 300, limit: 2000, resetAt: null },
          },
        },
      }),
      sub({ id: 'sub-codex-1234', priority: 1 }),
    ]} />)

    expect(screen.getByText('#1234')).toBeInTheDocument()
    expect(screen.getByText('#5678')).toBeInTheDocument()
    expect(screen.getAllByRole('progressbar')).toHaveLength(4)
  })

  it('keeps Codex and Anthropic quotas independent inside one subscription', () => {
    render(<SubscriptionUsageCarousel subscriptions={[sub({
      products: ['codex', 'anthropic'],
      levels: { codex: 'pro-20x', anthropic: 'max-20x' },
      shareSeats: 2,
      usdQuotaByProduct: {
        codex: {
          fiveHour: { used: 20, limit: 800, resetAt: null },
          weekly: { used: 400, limit: 7000, resetAt: null },
        },
        anthropic: {
          fiveHour: { used: 30, limit: 800, resetAt: null },
          weekly: { used: 500, limit: 4000, resetAt: null },
        },
      },
    })]} />)

    expect(screen.getByText(/Codex/)).toBeInTheDocument()
    expect(screen.getByText(/Anthropic/)).toBeInTheDocument()
    expect(screen.getAllByText(/2 份/)).toHaveLength(2)
    expect(screen.getAllByRole('progressbar')).toHaveLength(4)
  })
})
