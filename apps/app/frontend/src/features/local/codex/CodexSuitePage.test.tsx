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
    LocalRefreshAccountQuota: vi.fn().mockResolvedValue(undefined),
    LocalRefreshAllQuotas: vi.fn().mockResolvedValue(1),
    LocalGetRefreshConfig: vi.fn().mockResolvedValue({ quotaMinutes: 10, currentMinutes: 1 }),
    LocalSetRefreshConfig: vi.fn().mockResolvedValue({ quotaMinutes: 30, currentMinutes: 5 }),
    // ── 反代运营(Wave E)──
    LocalSetGatewayPort: vi.fn().mockResolvedValue({ running: true, addr: '127.0.0.1:19528', port: 19528 }),
    LocalGetRoutingStrategy: vi.fn().mockResolvedValue('priority'),
    LocalSetRoutingStrategy: vi.fn().mockResolvedValue(undefined),
    LocalGetGatewayAccessScope: vi.fn().mockResolvedValue('local'),
    LocalSetGatewayAccessScope: vi.fn().mockResolvedValue(undefined),
    LocalListGatewayKeys: vi.fn().mockResolvedValue([
      { id: 'k1', name: '默认', value: 'sk-local-abcd1234efgh5678', createdAt: 1700000000000 },
    ]),
    LocalCreateGatewayKey: vi.fn().mockResolvedValue({ id: 'k2', name: '团队', value: 'sk-local-newkey99', createdAt: 1700000100000 }),
    LocalDeleteGatewayKey: vi.fn().mockResolvedValue(undefined),
    LocalRotateGatewayKey: vi.fn().mockResolvedValue({ id: 'k1', name: '默认', value: 'sk-local-rotated55', createdAt: 1700000000000 }),
    LocalQueryGatewayLogs: vi.fn().mockResolvedValue({
      total: 2,
      entries: [
        { atMs: 1700000000000, authId: 'a1', email: 'yifan@example.com', model: 'gpt-5-codex', failed: false, latencyMs: 1200 },
        { atMs: 1700000001000, authId: 'a1', email: 'yifan@example.com', model: 'gpt-5-codex', failed: true, latencyMs: 80 },
      ],
    }),
    LocalClearGatewayStats: vi.fn().mockResolvedValue(undefined),
    LocalGatewayConnTest: vi.fn().mockResolvedValue({ ok: true, status: 200, latencyMs: 42, err: '' }),
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
    // source=local → 头部显示「本地接管中 · 已注入」(注入式接管,不再显示网关地址)
    expect(screen.getByText(/本地接管中 · 已注入/)).toBeInTheDocument()
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

  async function openGateway() {
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: '反代' }))
    await screen.findByText('本地反代')
  }

  it('反代 tab 显示网关运行态 + OpenAI 兼容地址', async () => {
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: '反代' }))
    expect(await screen.findByText('本地反代')).toBeInTheDocument()
    // 网关运行中(mock addr 127.0.0.1:19528)→ 暴露 base URL
    expect(await screen.findByText('http://127.0.0.1:19528/v1')).toBeInTheDocument()
  })

  it('反代 tab 读取路由策略当前值,切换调 setRoutingStrategy', async () => {
    const app = installApp()
    await openGateway()
    await waitFor(() => expect(app.LocalGetRoutingStrategy).toHaveBeenCalled())
    // 当前 priority → 段控里「优先」高亮(aria-pressed)
    const fairBtn = await screen.findByRole('button', { name: '公平分摊' })
    fireEvent.click(fairBtn)
    await waitFor(() => expect(app.LocalSetRoutingStrategy).toHaveBeenCalledWith('fair'))
  })

  it('反代 tab 局域网开关读取范围,开启调 setGatewayAccessScope(lan) 并给安全提示', async () => {
    const app = installApp()
    await openGateway()
    await waitFor(() => expect(app.LocalGetGatewayAccessScope).toHaveBeenCalled())
    const lanSwitch = await screen.findByRole('switch', { name: /局域网访问/ })
    expect(lanSwitch).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(lanSwitch)
    await waitFor(() => expect(app.LocalSetGatewayAccessScope).toHaveBeenCalledWith('lan'))
    // 开局域网给一句安全提示
    expect(await screen.findByText(/局域网内任何设备/)).toBeInTheDocument()
  })

  it('反代 tab 列出网关 key(掩码),可新建/轮换/删除', async () => {
    const app = installApp()
    await openGateway()
    await waitFor(() => expect(app.LocalListGatewayKeys).toHaveBeenCalled())
    expect(await screen.findByText('默认')).toBeInTheDocument()
    // 掩码:不暴露完整值,但展示首尾
    expect(screen.queryByText('sk-local-abcd1234efgh5678')).toBeNull()
    // 新建
    fireEvent.change(await screen.findByLabelText('新 key 名称'), { target: { value: '团队' } })
    fireEvent.click(screen.getByRole('button', { name: /新建 key/ }))
    await waitFor(() => expect(app.LocalCreateGatewayKey).toHaveBeenCalledWith('团队'))
    // 轮换 / 删除
    fireEvent.click(screen.getByRole('button', { name: '轮换 key' }))
    await waitFor(() => expect(app.LocalRotateGatewayKey).toHaveBeenCalledWith('k1'))
    fireEvent.click(screen.getByRole('button', { name: '删除 key' }))
    await waitFor(() => expect(app.LocalDeleteGatewayKey).toHaveBeenCalledWith('k1'))
  })

  it('反代 tab 请求日志可过滤(仅失败)并清空', async () => {
    const app = installApp()
    await openGateway()
    await waitFor(() => expect(app.LocalQueryGatewayLogs).toHaveBeenCalled())
    // 初次拉取:offset 0,空过滤
    expect(app.LocalQueryGatewayLogs).toHaveBeenCalledWith(0, expect.any(Number), '')
    // 勾「仅失败」→ 带 failedOnly 过滤重新查询
    fireEvent.click(screen.getByRole('checkbox', { name: '仅失败' }))
    await waitFor(() =>
      expect(app.LocalQueryGatewayLogs).toHaveBeenCalledWith(0, expect.any(Number), expect.stringContaining('failedOnly')),
    )
    // 清空
    fireEvent.click(screen.getByRole('button', { name: '清空日志' }))
    await waitFor(() => expect(app.LocalClearGatewayStats).toHaveBeenCalled())
  })

  it('反代 tab 连通测试按钮调 gatewayConnTest 并显示结果', async () => {
    const app = installApp()
    await openGateway()
    fireEvent.click(screen.getByRole('button', { name: /连通测试/ }))
    await waitFor(() => expect(app.LocalGatewayConnTest).toHaveBeenCalled())
    // 显示 ok + 状态码 + 延迟(连通正常文案区分于请求日志里的延迟数字)
    const result = await screen.findByText(/连通正常/)
    expect(result).toBeInTheDocument()
    expect(result.textContent).toMatch(/200/)
    expect(result.textContent).toMatch(/42/)
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

  it('账号行可单号刷新额度(调 refreshQuota,刷新后重拉列表)', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    expect(app.LocalListCodexAccounts).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '刷新额度' }))
    await waitFor(() => expect(app.LocalRefreshAccountQuota).toHaveBeenCalledWith('a1'))
    // 刷新后回填:重新拉取账号列表展示新百分比
    await waitFor(() => expect(app.LocalListCodexAccounts).toHaveBeenCalledTimes(2))
  })

  it('头部「全部刷新额度」调 refreshAllQuotas(provider=codex)', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: /全部刷新额度/ }))
    await waitFor(() => expect(app.LocalRefreshAllQuotas).toHaveBeenCalledWith('codex'))
  })

  it('保活 tab 顶部有两个间隔下拉,读取 getRefreshConfig 当前值', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: '保活' }))
    await waitFor(() => expect(app.LocalGetRefreshConfig).toHaveBeenCalled())
    const quotaSel = await screen.findByLabelText('配额自动刷新间隔') as HTMLSelectElement
    const currentSel = screen.getByLabelText('当前账号刷新间隔') as HTMLSelectElement
    expect(quotaSel.value).toBe('10')
    expect(currentSel.value).toBe('1')
  })

  it('改配额自动刷新间隔下拉,调 setRefreshConfig(保留另一项)', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: '保活' }))
    const quotaSel = await screen.findByLabelText('配额自动刷新间隔')
    fireEvent.change(quotaSel, { target: { value: '30' } })
    await waitFor(() => expect(app.LocalSetRefreshConfig).toHaveBeenCalledWith(30, 1))
  })

  it('改当前账号刷新间隔下拉,调 setRefreshConfig(保留另一项)', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: '保活' }))
    const currentSel = await screen.findByLabelText('当前账号刷新间隔')
    fireEvent.change(currentSel, { target: { value: '5' } })
    await waitFor(() => expect(app.LocalSetRefreshConfig).toHaveBeenCalledWith(10, 5))
  })

  it('加号菜单有「从本地 ~/.codex 导入」(codex 有 importFromLocal),点击调 importFromLocal 并重拉列表', async () => {
    const importFromLocal = vi.fn().mockResolvedValue(2)
    const app = installApp({ LocalImportCodexFromLocal: importFromLocal })
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    expect(app.LocalListCodexAccounts).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /加号/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /从本地.*导入/ }))
    await waitFor(() => expect(importFromLocal).toHaveBeenCalled())
    // 导入后回填:重新拉取账号列表
    await waitFor(() => expect(app.LocalListCodexAccounts).toHaveBeenCalledTimes(2))
  })

  it('加号菜单有「从文件导入」(codex 有 importAuthFiles),选文件后读文本数组并调 importAuthFiles', async () => {
    const importAuthFiles = vi.fn().mockResolvedValue(2)
    const app = installApp({ LocalImportCodexAuthFiles: importAuthFiles })
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: /加号/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /从文件导入/ }))
    const input = document.querySelector('input[type=file]') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.multiple).toBe(true)
    const f1 = new File(['{"a":1}'], 'a.json', { type: 'application/json' })
    const f2 = new File(['{"b":2}'], 'b.json', { type: 'application/json' })
    Object.defineProperty(input, 'files', { value: [f1, f2], configurable: true })
    fireEvent.change(input)
    await waitFor(() => expect(importAuthFiles).toHaveBeenCalledWith(['{"a":1}', '{"b":2}']))
    // 导入后回填:重新拉取账号列表
    await waitFor(() => expect(app.LocalListCodexAccounts).toHaveBeenCalledTimes(2))
  })

  it('加号菜单不显示 antigravity 专属的「从已装 IDE 同步」(codex 无 syncFromIDE)', async () => {
    installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: /加号/ }))
    await screen.findByRole('menuitem', { name: /浏览器登录/ })
    expect(screen.queryByRole('menuitem', { name: /从已装 IDE 同步/ })).toBeNull()
  })
})
