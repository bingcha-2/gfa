import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { CodexSuitePage } from './CodexSuitePage'
import type { LocalAccountView } from '@/services/localApi'

function fakeAccount(over: Partial<LocalAccountView> = {}): LocalAccountView {
  return {
    id: 'a1', email: 'yifan@example.com', provider: 'codex', authKind: 'oauth',
    planType: 'pro', quotaStatus: 'ok', tags: ['主力'], poolEnabled: true, priority: true,
    hourlyPercent: 34, weeklyPercent: 61, hourlyResetAt: 0, weeklyResetAt: 0, lastUsedAt: 0,
    ...over,
  }
}

function installApp(over: Record<string, (...a: unknown[]) => Promise<unknown>> = {}) {
  const base = {
    LocalListCodexAccounts: vi.fn().mockResolvedValue([fakeAccount()]),
    LocalGatewayStatus: vi.fn().mockResolvedValue({ running: true, addr: '127.0.0.1:19528', port: 19528 }),
    LocalGetCodexSource: vi.fn().mockResolvedValue('local'),
    LocalSetCodexSource: vi.fn().mockResolvedValue(undefined),
    LocalStartCodexLogin: vi.fn().mockResolvedValue('login-1'),
    LocalWaitCodexLogin: vi.fn().mockResolvedValue(fakeAccount()),
    LocalSetPoolEnabled: vi.fn().mockResolvedValue(undefined),
    LocalSetCodexPriority: vi.fn().mockResolvedValue(undefined),
    LocalDeleteAccount: vi.fn().mockResolvedValue(undefined),
    LocalGatewayStart: vi.fn().mockResolvedValue({ running: true, addr: '127.0.0.1:19528', port: 19528 }),
    LocalGatewayStop: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
  ;(window as unknown as { go: { main: { App: typeof base } } }).go = { main: { App: base } }
  return base
}

describe('CodexSuitePage', () => {
  beforeEach(() => {
    installApp()
  })

  it('renders own accounts with quota and gateway status', async () => {
    render(<CodexSuitePage />)
    expect(await screen.findByText('yifan@example.com')).toBeInTheDocument()
    expect(screen.getByText(/网关 127\.0\.0\.1:19528/)).toBeInTheDocument()
    expect(screen.getByText('仅自有号')).toBeInTheDocument()
    // 配额百分比展示
    expect(screen.getByText('34%')).toBeInTheDocument()
    expect(screen.getByText('61%')).toBeInTheDocument()
  })

  it('shows empty state when there are no accounts', async () => {
    installApp({ LocalListCodexAccounts: vi.fn().mockResolvedValue([]) })
    render(<CodexSuitePage />)
    expect(await screen.findByText('还没有本地账号')).toBeInTheDocument()
  })

  it('switches account source via the segmented control', async () => {
    const app = installApp({ LocalGetCodexSource: vi.fn().mockResolvedValue('remote') })
    render(<CodexSuitePage />)
    // 等加载完成(远程态)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: '本地自有号' }))
    await waitFor(() => expect(app.LocalSetCodexSource).toHaveBeenCalledWith('local'))
  })
})
