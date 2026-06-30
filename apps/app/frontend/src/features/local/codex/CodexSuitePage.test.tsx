import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { CodexSuitePage } from './CodexSuitePage'
import type { LocalAccountView } from '@/services/localApi'

function fakeAccount(over: Partial<LocalAccountView> = {}): LocalAccountView {
  return {
    id: 'a1', email: 'yifan@example.com', name: '', provider: 'codex', authKind: 'oauth', note: '',
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
    LocalCodexStats: vi.fn().mockResolvedValue({
      totalRequests: 3, totalFailed: 1, totalInputTokens: 310, totalOutputTokens: 115,
      byAccount: [{ authId: 'a1', email: 'yifan@example.com', requests: 2, totalTokens: 410 }],
      byModel: [{ model: 'gpt-5-codex', requests: 2, totalTokens: 410 }],
      recent: [{ atMs: 1700000000000, authId: 'a1', model: 'gpt-5-codex', failed: false, latencyMs: 1200 }],
    }),
    LocalExportCodexAccounts: vi.fn().mockResolvedValue('[]'),
    LocalImportCodexFromJSON: vi.fn().mockResolvedValue(1),
    LocalDeleteAccounts: vi.fn().mockResolvedValue(undefined),
    LocalAddCodexToken: vi.fn().mockResolvedValue(fakeAccount({ id: 'a2', email: 'tok@x.com' })),
    LocalAddCodexApiKey: vi.fn().mockResolvedValue(fakeAccount({ id: 'a3', email: 'key@x.com', authKind: 'apikey' })),
    LocalRenameAccount: vi.fn().mockResolvedValue(undefined),
    LocalSetAccountNote: vi.fn().mockResolvedValue(undefined),
    LocalSetAccountTags: vi.fn().mockResolvedValue(undefined),
    LocalCodexWakeupConfig: vi.fn().mockResolvedValue({ enabled: false, intervalMinutes: 240 }),
    LocalSetCodexWakeupConfig: vi.fn().mockResolvedValue(undefined),
    LocalCodexWakeupRunNow: vi.fn().mockResolvedValue([]),
    LocalCodexWakeupHistory: vi.fn().mockResolvedValue([{ atMs: 1700000000000, accountId: 'a1', email: 'yifan@example.com', ok: true }]),
    LocalInstanceList: vi.fn().mockResolvedValue([{ id: 'i1', provider: 'codex', name: '工作', userDataDir: '/tmp/w', createdAt: 1 }]),
    LocalInstanceCreate: vi.fn().mockResolvedValue({ id: 'i2', provider: 'codex', name: '新', userDataDir: '/tmp/n', createdAt: 2 }),
    LocalInstanceDelete: vi.fn().mockResolvedValue(undefined),
    LocalInstanceUpdate: vi.fn().mockResolvedValue(undefined),
    LocalInstanceLaunch: vi.fn().mockResolvedValue(undefined),
    LocalInstanceStop: vi.fn().mockResolvedValue(undefined),
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
    // 使用风险提示横幅常驻
    expect(screen.getByText('使用风险提示')).toBeInTheDocument()
    // 配额百分比展示
    expect(screen.getByText('34%')).toBeInTheDocument()
    expect(screen.getByText('61%')).toBeInTheDocument()
  })

  it('shows empty state when there are no accounts', async () => {
    installApp({ LocalListCodexAccounts: vi.fn().mockResolvedValue([]) })
    render(<CodexSuitePage />)
    expect(await screen.findByText('还没有本地账号')).toBeInTheDocument()
  })

  // 接管模式切换已上移至「接管中心」:suite 头部只读 + 去接管中心链接,不再有段控。
  it('suite 头部只读、无接管模式段控,去接管中心链接可导航', async () => {
    const onNav = vi.fn()
    installApp({ LocalGetCodexSource: vi.fn().mockResolvedValue('remote') })
    render(<CodexSuitePage onNavigate={onNav} />)
    await screen.findByText('yifan@example.com')
    expect(screen.queryByText('接管模式')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /去接管中心/ }))
    expect(onNav).toHaveBeenCalledWith('takeover')
  })

  it('反代 tab 显示网关运行态 + OpenAI 兼容地址', async () => {
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: '反代' }))
    expect(await screen.findByText('本地反代')).toBeInTheDocument()
    // 网关运行中(mock addr 127.0.0.1:19528)→ 暴露 base URL
    expect(await screen.findByText('http://127.0.0.1:19528/v1')).toBeInTheDocument()
  })

  it('shows the stats tab with gateway usage', async () => {
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: '统计' }))
    expect(await screen.findByText(/来源:本地网关/)).toBeInTheDocument()
    expect(screen.getByText('请求数')).toBeInTheDocument()
    expect(screen.getByText('错误率')).toBeInTheDocument()
    // 按账号 / 按模型 区块渲染
    expect(screen.getByText('按账号')).toBeInTheDocument()
    expect(screen.getByText('按模型')).toBeInTheDocument()
    // gpt-5-codex 在按模型与最近请求都出现
    expect((await screen.findAllByText('gpt-5-codex')).length).toBeGreaterThanOrEqual(1)
  })

  it('imports accounts from pasted JSON', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: /导入/ }))
    const textarea = await screen.findByPlaceholderText(/you@example.com/)
    fireEvent.change(textarea, { target: { value: '[{"email":"new@x.com","authKind":"oauth"}]' } })
    // 头部与弹窗各有一个「导入」按钮;弹窗确认是最后一个
    const importButtons = screen.getAllByRole('button', { name: '导入' })
    fireEvent.click(importButtons[importButtons.length - 1])
    await waitFor(() => expect(app.LocalImportCodexFromJSON).toHaveBeenCalledWith('[{"email":"new@x.com","authKind":"oauth"}]'))
  })

  it('shows the wakeup tab and can toggle + run now', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: '保活' }))
    // 开关 + 立即运行
    expect(await screen.findByRole('switch')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(app.LocalSetCodexWakeupConfig).toHaveBeenCalledWith(true, 240))
    fireEvent.click(screen.getByRole('button', { name: /立即运行/ }))
    await waitFor(() => expect(app.LocalCodexWakeupRunNow).toHaveBeenCalled())
  })

  it('batch deletes selected accounts', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByLabelText('选择账号'))
    expect(await screen.findByText('已选 1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '批量删除' }))
    await waitFor(() => expect(app.LocalDeleteAccounts).toHaveBeenCalledWith(['a1']))
  })

  it('shows the instances tab and can create a profile', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: '实例' }))
    expect(await screen.findByText('工作')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('实例名称'), { target: { value: '新实例' } })
    fireEvent.change(screen.getByLabelText('user-data 目录'), { target: { value: '/tmp/x' } })
    fireEvent.click(screen.getByRole('button', { name: /创建/ }))
    await waitFor(() => expect(app.LocalInstanceCreate).toHaveBeenCalledWith('codex', '新实例', '/tmp/x', '', '', ''))
    // 启动既有实例(无 pid → 显示启动)
    fireEvent.click(screen.getByRole('button', { name: /启动/ }))
    await waitFor(() => expect(app.LocalInstanceLaunch).toHaveBeenCalledWith('i1'))
    // 改绑账号(内联下拉)
    fireEvent.change(screen.getByLabelText('改绑账号'), { target: { value: 'a1' } })
    await waitFor(() => expect(app.LocalInstanceUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'i1', bindAccountId: 'a1' })))
  })

  it('加号菜单可粘贴 token 加号(调 addByToken)', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: /加号/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /粘贴 token/ }))
    fireEvent.change(await screen.findByLabelText('Refresh Token'), { target: { value: 'rt-1' } })
    fireEvent.change(screen.getByLabelText('Access Token'), { target: { value: 'at-1' } })
    fireEvent.change(screen.getByLabelText('邮箱(可选)'), { target: { value: 'me@x.com' } })
    fireEvent.click(screen.getByRole('button', { name: '添加账号' }))
    await waitFor(() => expect(app.LocalAddCodexToken).toHaveBeenCalledWith('rt-1', 'at-1', 'me@x.com'))
  })

  it('加号菜单可粘贴 API Key 加号(调 addByApiKey)', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: /加号/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /粘贴 API Key/ }))
    fireEvent.change(await screen.findByLabelText('API Key'), { target: { value: 'sk-1' } })
    fireEvent.change(screen.getByLabelText('Base URL(可选)'), { target: { value: 'https://api.x.com' } })
    fireEvent.change(screen.getByLabelText('邮箱(可选)'), { target: { value: 'k@x.com' } })
    fireEvent.click(screen.getByRole('button', { name: '添加账号' }))
    await waitFor(() => expect(app.LocalAddCodexApiKey).toHaveBeenCalledWith('sk-1', 'https://api.x.com', 'k@x.com'))
  })

  it('加号菜单第一项仍是浏览器登录(沿用 onLogin)', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: /加号/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /浏览器登录/ }))
    await waitFor(() => expect(app.LocalStartCodexLogin).toHaveBeenCalled())
  })

  it('账号行有 name 时标题显示 name', async () => {
    installApp({ LocalListCodexAccounts: vi.fn().mockResolvedValue([fakeAccount({ name: '我的主号' })]) })
    render(<CodexSuitePage />)
    expect(await screen.findByText('我的主号')).toBeInTheDocument()
  })

  it('账号行无 name 时标题回退到 email', async () => {
    installApp({ LocalListCodexAccounts: vi.fn().mockResolvedValue([fakeAccount({ name: '' })]) })
    render(<CodexSuitePage />)
    expect(await screen.findByText('yifan@example.com')).toBeInTheDocument()
  })

  it('账号行可重命名(调 rename)', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: '编辑账号' }))
    fireEvent.change(await screen.findByLabelText('名称'), { target: { value: '新名字' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(app.LocalRenameAccount).toHaveBeenCalledWith('a1', '新名字'))
  })

  it('账号行可改备注与标签(调 setNote/setTags)', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: '编辑账号' }))
    fireEvent.change(await screen.findByLabelText('备注'), { target: { value: '这是备注' } })
    fireEvent.change(screen.getByLabelText('标签(逗号分隔)'), { target: { value: 'a, b ,c' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(app.LocalSetAccountNote).toHaveBeenCalledWith('a1', '这是备注'))
    await waitFor(() => expect(app.LocalSetAccountTags).toHaveBeenCalledWith('a1', ['a', 'b', 'c']))
  })
})
