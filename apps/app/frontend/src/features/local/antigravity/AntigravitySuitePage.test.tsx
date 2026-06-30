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
    LocalGetAntigravitySource: vi.fn().mockResolvedValue('remote'),
    LocalSetAntigravitySource: vi.fn().mockResolvedValue(undefined),
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
    expect(screen.getByText('仅自有号')).toBeInTheDocument()
  })

  // antigravity 走注入、没有反代 —— 不应有「反代」tab(只 codex 有)。
  it('无「反代」tab(antigravity 不走反代)', async () => {
    render(<AntigravitySuitePage />)
    await screen.findByText('me@gmail.com')
    expect(screen.queryByRole('button', { name: '反代' })).toBeNull()
    // 账号/统计/保活/实例 仍在
    expect(screen.getByRole('button', { name: '账号' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '统计' })).toBeInTheDocument()
  })

  // 接管模式(远程/本地)切换已上移至「接管中心」;suite 头部只读 + 去接管中心链接。
  it('suite 头部无接管模式段控,去接管中心链接可导航', async () => {
    const onNav = vi.fn()
    render(<AntigravitySuitePage onNavigate={onNav} />)
    await screen.findByText('me@gmail.com')
    expect(screen.queryByText('接管模式')).toBeNull()
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.click(screen.getByRole('button', { name: /去接管中心/ }))
    expect(onNav).toHaveBeenCalledWith('takeover')
  })
})
