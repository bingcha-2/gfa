import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { AntigravitySuitePage } from './AntigravitySuitePage'

function installApp() {
  const base = {
    LocalListAntigravityAccounts: vi.fn().mockResolvedValue([
      { id: 'g1', email: 'me@gmail.com', provider: 'antigravity', authKind: 'oauth', planType: 'pro', quotaStatus: 'ok', tags: [], poolEnabled: true, priority: false, hourlyPercent: 20, weeklyPercent: 40, hourlyResetAt: 0, weeklyResetAt: 0, lastUsedAt: 0 },
    ]),
    LocalAntigravityGatewayStatus: vi.fn().mockResolvedValue({ running: true, addr: '127.0.0.1:19529', port: 19529 }),
    LocalAntigravityStats: vi.fn().mockResolvedValue({ totalRequests: 0, totalFailed: 0, totalInputTokens: 0, totalOutputTokens: 0, byAccount: [], byModel: [], recent: [] }),
    LocalStartAntigravityLogin: vi.fn().mockResolvedValue('lg'),
    LocalWaitAntigravityLogin: vi.fn(),
    LocalSetPoolEnabled: vi.fn().mockResolvedValue(undefined),
    LocalSetAntigravityPriority: vi.fn().mockResolvedValue(undefined),
    LocalDeleteAccount: vi.fn().mockResolvedValue(undefined),
    LocalDeleteAccounts: vi.fn().mockResolvedValue(undefined),
    LocalAntigravityGatewayStart: vi.fn(),
    LocalAntigravityGatewayStop: vi.fn(),
    LocalExportAntigravityAccounts: vi.fn(),
    LocalImportAntigravityFromJSON: vi.fn(),
  }
  ;(window as unknown as { go: { main: { App: typeof base } } }).go = { main: { App: base } }
  return base
}

describe('AntigravitySuitePage', () => {
  beforeEach(() => { installApp() })

  it('renders own antigravity accounts via the shared suite', async () => {
    render(<AntigravitySuitePage />)
    expect(await screen.findByText('me@gmail.com')).toBeInTheDocument()
    expect(screen.getByText('Antigravity')).toBeInTheDocument()
    expect(screen.getByText(/网关 127\.0\.0\.1:19529/)).toBeInTheDocument()
  })

  it('does not show the source toggle (antigravity has no remote/local switch yet)', async () => {
    render(<AntigravitySuitePage />)
    await screen.findByText('me@gmail.com')
    expect(screen.queryByText('接管模式')).toBeNull()
  })
})
