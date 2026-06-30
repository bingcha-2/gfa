import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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
    LocalImportAntigravityAuthFiles: vi.fn().mockResolvedValue(2),
    LocalSyncAntigravityFromIDE: vi.fn().mockResolvedValue(1),
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
    fireEvent.click(screen.getByRole('button', { name: /去接管中心/ }))
    expect(onNav).toHaveBeenCalledWith('takeover')
  })

  it('加号菜单有「从已装 IDE 同步」(antigravity 有 syncFromIDE),点击调 syncFromIDE 并重拉列表', async () => {
    const app = installApp()
    render(<AntigravitySuitePage />)
    await screen.findByText('me@gmail.com')
    expect(app.LocalListAntigravityAccounts).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /加号/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /从已装 IDE 同步/ }))
    await waitFor(() => expect(app.LocalSyncAntigravityFromIDE).toHaveBeenCalled())
    await waitFor(() => expect(app.LocalListAntigravityAccounts).toHaveBeenCalledTimes(2))
  })

  it('加号菜单有「从文件导入」(antigravity 有 importAuthFiles),选文件后读文本数组并调 importAuthFiles', async () => {
    const app = installApp()
    render(<AntigravitySuitePage />)
    await screen.findByText('me@gmail.com')
    fireEvent.click(screen.getByRole('button', { name: /加号/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /从文件导入/ }))
    const input = document.querySelector('input[type=file]') as HTMLInputElement
    expect(input).toBeTruthy()
    const f1 = new File(['tok-1'], 'g1.json', { type: 'application/json' })
    Object.defineProperty(input, 'files', { value: [f1], configurable: true })
    fireEvent.change(input)
    await waitFor(() => expect(app.LocalImportAntigravityAuthFiles).toHaveBeenCalledWith(['tok-1']))
    await waitFor(() => expect(app.LocalListAntigravityAccounts).toHaveBeenCalledTimes(2))
  })

  it('加号菜单不显示 codex 专属的「从本地 ~/.codex 导入」(antigravity 无 importFromLocal)', async () => {
    installApp()
    render(<AntigravitySuitePage />)
    await screen.findByText('me@gmail.com')
    fireEvent.click(screen.getByRole('button', { name: /加号/ }))
    await screen.findByRole('menuitem', { name: /浏览器登录/ })
    expect(screen.queryByRole('menuitem', { name: /从本地.*导入/ })).toBeNull()
  })
})
