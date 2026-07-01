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
    // ── 账号组织(分组 + 显式当前号 + 重排序)(Wave I · 共享) ──
    LocalListAccountGroups: vi.fn().mockResolvedValue([
      { id: 'gr1', name: '主力', sortOrder: 0, accountIds: ['g1'], createdAt: 1700000000000 },
    ]),
    LocalCreateAccountGroup: vi.fn().mockResolvedValue({ id: 'gr2', name: '备用', sortOrder: 1, accountIds: [], createdAt: 1700000100000 }),
    LocalRenameAccountGroup: vi.fn().mockResolvedValue(null),
    LocalUpdateAccountGroupSortOrder: vi.fn().mockResolvedValue(null),
    LocalDeleteAccountGroup: vi.fn().mockResolvedValue(undefined),
    LocalAssignAccountsToGroup: vi.fn().mockResolvedValue(null),
    LocalRemoveAccountsFromGroup: vi.fn().mockResolvedValue(null),
    LocalResolveAccountGroups: vi.fn().mockResolvedValue({ g1: 'gr1' }),
    LocalCurrentAntigravityAccount: vi.fn().mockResolvedValue(null),
    LocalSetCurrentAntigravityAccount: vi.fn().mockResolvedValue(undefined),
    LocalReorderAntigravityAccounts: vi.fn().mockResolvedValue(undefined),
    // ── 实例 tab(antigravity 额外:默认实例运行时 + 切换历史)──
    LocalAntigravityRuntimeStatus: vi.fn().mockResolvedValue(true),
    LocalAntigravityStartDefault: vi.fn().mockResolvedValue(undefined),
    LocalAntigravityStopDefault: vi.fn().mockResolvedValue(undefined),
    LocalAntigravityRestartDefault: vi.fn().mockResolvedValue(undefined),
    LocalAntigravityFocusDefault: vi.fn().mockResolvedValue(undefined),
    LocalAntigravityApps: vi.fn().mockResolvedValue([
      { variant: 'ide', name: 'Antigravity IDE', detected: true, running: true },
      { variant: 'standalone', name: 'Antigravity', detected: true, running: false },
    ]),
    LocalAntigravityAppStart: vi.fn().mockResolvedValue(undefined),
    LocalAntigravityAppStop: vi.fn().mockResolvedValue(undefined),
    LocalAntigravityAppRestart: vi.fn().mockResolvedValue(undefined),
    LocalAntigravityAppFocus: vi.fn().mockResolvedValue(undefined),
    LocalAntigravitySwitchHistory: vi.fn().mockResolvedValue([
      { id: 'h1', timestamp: 1700000000000, accountId: 'g1', targetEmail: 'switched@gmail.com', triggerType: 'manual', triggerSource: 'user', localOk: true, seamlessOk: true, success: true, localDurationMs: 100, totalDurationMs: 200 },
    ]),
    LocalClearAntigravitySwitchHistory: vi.fn().mockResolvedValue(undefined),
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

  // antigravity 没有自定义模型供应商(只 codex 有 OpenAI 兼容供应商喂号)。
  it('无「供应商」tab(antigravity 不支持自定义模型供应商)', async () => {
    render(<AntigravitySuitePage />)
    await screen.findByText('me@gmail.com')
    expect(screen.queryByRole('button', { name: '供应商' })).toBeNull()
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

  // ── 账号组织:分组 + 显式当前号 + 重排序(antigravity 走 provider=antigravity 绑定)──

  it('账号 tab 渲染分组筛选条,新建分组调 createAccountGroup', async () => {
    const app = installApp()
    render(<AntigravitySuitePage />)
    await screen.findByText('me@gmail.com')
    await waitFor(() => expect(app.LocalListAccountGroups).toHaveBeenCalled())
    expect(await screen.findByRole('button', { name: '全部账号' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /新建分组/ }))
    fireEvent.change(await screen.findByLabelText('分组名称'), { target: { value: '备用' } })
    fireEvent.click(screen.getByRole('button', { name: '创建分组' }))
    await waitFor(() => expect(app.LocalCreateAccountGroup).toHaveBeenCalledWith('备用'))
  })

  it('账号行「设为当前号」走 antigravity 绑定 setCurrentAntigravityAccount', async () => {
    const app = installApp()
    render(<AntigravitySuitePage />)
    await screen.findByText('me@gmail.com')
    fireEvent.click(screen.getByRole('button', { name: '设为当前号' }))
    await waitFor(() => expect(app.LocalSetCurrentAntigravityAccount).toHaveBeenCalledWith('g1'))
  })

  it('重排序走 antigravity 绑定 reorderAntigravityAccounts', async () => {
    const app = installApp()
    ;(app.LocalListAntigravityAccounts as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'g1', email: 'a@x.com', name: '', provider: 'antigravity', authKind: 'oauth', note: '', planType: 'pro', quotaStatus: 'ok', tags: [], poolEnabled: true, priority: false, hourlyPercent: 1, weeklyPercent: 1, hourlyResetAt: 0, weeklyResetAt: 0, lastUsedAt: 0 },
      { id: 'g2', email: 'b@x.com', name: '', provider: 'antigravity', authKind: 'oauth', note: '', planType: 'pro', quotaStatus: 'ok', tags: [], poolEnabled: true, priority: false, hourlyPercent: 1, weeklyPercent: 1, hourlyResetAt: 0, weeklyResetAt: 0, lastUsedAt: 0 },
    ])
    render(<AntigravitySuitePage />)
    await screen.findByText('a@x.com')
    fireEvent.click(screen.getAllByRole('button', { name: '下移' })[0])
    await waitFor(() => expect(app.LocalReorderAntigravityAccounts).toHaveBeenCalledWith(['g2', 'g1']))
  })

  // ── 实例 tab(antigravity 额外:默认实例运行时 + 切换历史,原在已删的「数据」tab)──

  it('实例 tab 挂载读取运行时状态 + 切换历史', async () => {
    const app = installApp()
    render(<AntigravitySuitePage />)
    await screen.findByText('me@gmail.com')
    fireEvent.click(screen.getByRole('button', { name: '实例' }))
    await waitFor(() => expect(app.LocalAntigravityApps).toHaveBeenCalled())
    await waitFor(() => expect(app.LocalAntigravitySwitchHistory).toHaveBeenCalled())
  })

  it('实例 tab 显示两个 app(IDE + 独立版),对独立版启动调 AppStart(standalone)', async () => {
    const app = installApp()
    render(<AntigravitySuitePage />)
    await screen.findByText('me@gmail.com')
    fireEvent.click(screen.getByRole('button', { name: '实例' }))
    // 两张 app 卡:IDE(唯一名)+ 独立版;各带「启动」。
    expect(await screen.findByText('Antigravity IDE')).toBeInTheDocument()
    const starts = await screen.findAllByRole('button', { name: /启动/ })
    expect(starts.length).toBeGreaterThanOrEqual(2)
    fireEvent.click(starts[1]) // 独立版(IDE 卡在前)
    await waitFor(() => expect(app.LocalAntigravityAppStart).toHaveBeenCalledWith('standalone'))
  })

  it('实例 tab 切换历史显示目标号,清空调 clearAntigravitySwitchHistory', async () => {
    const app = installApp()
    render(<AntigravitySuitePage />)
    await screen.findByText('me@gmail.com')
    fireEvent.click(screen.getByRole('button', { name: '实例' }))
    expect(await screen.findByText('switched@gmail.com')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '清空历史' }))
    await waitFor(() => expect(app.LocalClearAntigravitySwitchHistory).toHaveBeenCalled())
  })
})
