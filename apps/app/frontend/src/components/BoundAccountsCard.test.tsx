import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const { store } = vi.hoisted(() => ({
  store: {
    state: {
      cardProducts: ['antigravity', 'codex', 'anthropic'],
      boundAccounts: [
        {
          product: 'antigravity',
          accountId: 41,
          emailHint: 'ag@example.com',
          planType: 'premium',
          accessToken: 'ag-token',
          expiresAt: Date.now() + 60_000,
          leasedAt: Date.now(),
        },
        {
          product: 'codex',
          accountId: 42,
          emailHint: 'codex@example.com',
          planType: 'plus',
          accessToken: 'eyJ...',
          expiresAt: Date.now() + 60_000,
          leasedAt: Date.now(),
        },
        {
          product: 'anthropic',
          accountId: 43,
          emailHint: 'anthropic@example.com',
          planType: 'pro',
          accessToken: 'claude-token',
          expiresAt: Date.now() + 60_000,
          leasedAt: Date.now(),
        },
      ],
      account: {
        subscriptions: [{
          id: 'sub-codex-pro',
          status: 'ACTIVE',
          expiresAt: '2030-01-01T00:00:00Z',
          deviceLimit: 1,
          priority: 1,
          products: ['antigravity', 'codex', 'anthropic'],
          levels: { antigravity: 'ultra', codex: 'pro', anthropic: 'max' },
          remainFraction: null,
        }],
      },
    },
  },
}))

vi.mock('@/stores/useAppStore', () => ({
  useAppStore: (selector: (s: typeof store.state) => unknown) => selector(store.state),
}))

import { BoundAccountsCard } from './BoundAccountsCard'

describe('BoundAccountsCard', () => {
  it('shows purchased product level instead of leased account level and hides token details', () => {
    render(<BoundAccountsCard />)

    expect(screen.getByText('Ultra')).toBeInTheDocument()
    expect(screen.getByText('Pro')).toBeInTheDocument()
    expect(screen.getByText('Max')).toBeInTheDocument()
    expect(screen.queryByText('Premium')).toBeNull()
    expect(screen.queryByText('Plus')).toBeNull()
    expect(screen.queryByText('Access Token')).toBeNull()
    expect(screen.queryByText('eyJ...')).toBeNull()
    expect(screen.queryByText('ag-token')).toBeNull()
    expect(screen.queryByText('claude-token')).toBeNull()
  })
})
