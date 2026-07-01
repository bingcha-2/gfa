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
    LocalSetCodexAccountServiceTier: vi.fn().mockResolvedValue(undefined),
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
    // ── 自定义模型供应商(Wave F)──
    LocalListModelProviders: vi.fn().mockResolvedValue([
      { id: 'p1', name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-prov-abcd1234efgh', wireApi: 'chat_completions', modelCatalog: ['deepseek-chat', 'deepseek-reasoner'], createdAt: 1700000000000 },
    ]),
    LocalSaveModelProvider: vi.fn().mockResolvedValue({ id: 'p2', name: '新供应商', baseURL: 'https://api.x.com/v1', apiKey: 'sk-new', wireApi: 'responses', modelCatalog: [], createdAt: 1700000100000 }),
    LocalDeleteModelProvider: vi.fn().mockResolvedValue(undefined),
    LocalTestModelProvider: vi.fn().mockResolvedValue({ ok: true, status: 200, latencyMs: 88, err: '', model: 'deepseek-chat' }),
    LocalListModelProviderModels: vi.fn().mockResolvedValue({ models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }], latencyMs: 120 }),
    // ── 经济与自动化(Wave G · codex-only)──
    LocalGetAlertConfig: vi.fn().mockResolvedValue({ enabled: false, thresholdPct: 10 }),
    LocalSetAlertConfig: vi.fn().mockResolvedValue({ enabled: true, thresholdPct: 20 }),
    LocalGetSwitchConfig: vi.fn().mockResolvedValue({ enabled: false, thresholdPct: 5, scopeMode: 'all', selectedAccountIds: null }),
    LocalSetSwitchConfig: vi.fn().mockResolvedValue({ enabled: true, thresholdPct: 5, scopeMode: 'all', selectedAccountIds: null }),
    LocalGetAppSpeed: vi.fn().mockResolvedValue({ contextPreset: 'default', tier: 'standard' }),
    LocalSetAppSpeed: vi.fn().mockResolvedValue({ contextPreset: 'preset_1m', tier: 'fast' }),
    // ── codex 上游业务(Wave G · codex-only)──
    LocalRefreshCodexSubscription: vi.fn().mockResolvedValue({ AccountID: 'a1', PlanType: 'pro', SubscriptionActiveUntil: '2026-12-31' }),
    LocalGetCodexResetCredits: vi.fn().mockResolvedValue({ available_count: 2, credits: [], next_expires_at: 0 }),
    LocalConsumeCodexResetCredit: vi.fn().mockResolvedValue(undefined),
    LocalCodexReferralEligibility: vi.fn().mockResolvedValue({ should_show: true, remaining_referrals: 3, referral_key: 'rk' }),
    LocalCodexReferralRules: vi.fn().mockResolvedValue({ requires_explicit_confirmation: false, rules: [], time_frame_rules: [] }),
    LocalSendCodexReferralInvites: vi.fn().mockResolvedValue({ invites: [{ email: 'friend@x.com' }] }),
    // ── Codex 设置面板(Wave H · codex-only)──
    LocalGetCodexSettings: vi.fn().mockResolvedValue({
      codexAppPath: '', launchOnSwitch: false, restartAppOnSwitch: false, restartAppPath: '',
      showApiEntry: true, filterMemory: false, showCodeReviewQuota: false,
    }),
    LocalSaveCodexSettings: vi.fn().mockImplementation((s: unknown) => Promise.resolve(s)),
    LocalGetCodexQuickConfig: vi.fn().mockResolvedValue({ contextWindow1m: false, autoCompactTokenLimit: 0 }),
    LocalSaveCodexQuickConfig: vi.fn().mockResolvedValue({ contextWindow1m: false, autoCompactTokenLimit: 0 }),
    LocalBrowseForPath: vi.fn().mockResolvedValue('/Applications/Codex.app'),
    LocalDetectCodexAppPath: vi.fn().mockResolvedValue('/Applications/Codex.app'),
    LocalOpenCodexConfigToml: vi.fn().mockResolvedValue(undefined),
    // ── 账号组织(分组 + 显式当前号 + 重排序)(Wave I · 共享) ──
    LocalListAccountGroups: vi.fn().mockResolvedValue([
      { id: 'gr1', name: '主力', sortOrder: 0, accountIds: ['a1'], createdAt: 1700000000000 },
    ]),
    LocalCreateAccountGroup: vi.fn().mockResolvedValue({ id: 'gr2', name: '备用', sortOrder: 1, accountIds: [], createdAt: 1700000100000 }),
    LocalRenameAccountGroup: vi.fn().mockResolvedValue({ id: 'gr1', name: '改名后', sortOrder: 0, accountIds: ['a1'], createdAt: 1700000000000 }),
    LocalUpdateAccountGroupSortOrder: vi.fn().mockResolvedValue(null),
    LocalDeleteAccountGroup: vi.fn().mockResolvedValue(undefined),
    LocalAssignAccountsToGroup: vi.fn().mockResolvedValue({ id: 'gr1', name: '主力', sortOrder: 0, accountIds: ['a1'], createdAt: 1700000000000 }),
    LocalRemoveAccountsFromGroup: vi.fn().mockResolvedValue({ id: 'gr1', name: '主力', sortOrder: 0, accountIds: [], createdAt: 1700000000000 }),
    LocalResolveAccountGroups: vi.fn().mockResolvedValue({ a1: 'gr1' }),
    LocalCurrentCodexAccount: vi.fn().mockResolvedValue(fakeAccount()),
    LocalSetCurrentCodexAccount: vi.fn().mockResolvedValue(undefined),
    LocalReorderCodexAccounts: vi.fn().mockResolvedValue(undefined),
    // ── 实例增强 + 跨实例会话(Wave I/J · codex)──
    LocalInstanceSetQuickConfig: vi.fn().mockResolvedValue(undefined),
    LocalListCodexSessions: vi.fn().mockResolvedValue([
      {
        sessionId: 's1', title: '重构网关', cwd: '/work/gfa', updatedAt: 1700000000000,
        locationCount: 2,
        locations: [
          { instanceId: 'i1', instanceName: '工作', running: true },
          { instanceId: 'i2', instanceName: '副本', running: false },
        ],
      },
    ]),
    LocalCodexSessionTokenStats: vi.fn().mockResolvedValue([
      { sessionId: 's1', inputTokens: 1200, outputTokens: 340, totalTokens: 1540 },
    ]),
    LocalMoveCodexSessionsToTrash: vi.fn().mockResolvedValue({
      requestedSessionCount: 1, trashedSessionCount: 1, trashedInstanceCount: 2,
      trashDir: '/hub/trash', message: '已移入废纸篓',
    }),
    LocalListTrashedCodexSessions: vi.fn().mockResolvedValue([
      {
        sessionId: 's9', title: '旧会话', cwd: '/work/old', deletedAt: 1699999999000,
        locationCount: 1, locations: [{ instanceId: 'i1', instanceName: '工作' }],
      },
    ]),
    LocalRestoreCodexSessionsFromTrash: vi.fn().mockResolvedValue({
      requestedSessionCount: 1, restoredSessionCount: 1, restoredInstanceCount: 1,
      message: '已恢复',
    }),
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

  // ── 实例增强:启动方式 / 跟随当前账号 / 快捷上下文(Wave I)──

  async function openInstances() {
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: '实例' }))
    await screen.findByText('工作')
  }

  it('实例行可展开配置面板,启动方式段控切 CLI 调 instanceSetQuickConfig(launchMode=cli)', async () => {
    const app = installApp()
    await openInstances()
    fireEvent.click(screen.getByRole('button', { name: '配置实例' }))
    // 当前 gui(默认)→ GUI 段控高亮
    expect((await screen.findByRole('button', { name: 'GUI' })).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'CLI' }))
    await waitFor(() =>
      expect(app.LocalInstanceSetQuickConfig).toHaveBeenCalledWith('i1', 'cli', expect.any(String), expect.any(Boolean), null, null),
    )
  })

  it('实例配置面板「跟随当前账号」开关 off→on 调 instanceSetQuickConfig(followLocalAccount=true)', async () => {
    const app = installApp()
    await openInstances()
    fireEvent.click(screen.getByRole('button', { name: '配置实例' }))
    const sw = await screen.findByRole('switch', { name: /跟随当前账号/ })
    expect(sw).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(sw)
    await waitFor(() =>
      expect(app.LocalInstanceSetQuickConfig).toHaveBeenCalledWith('i1', expect.any(String), expect.any(String), true, null, null),
    )
  })

  it('实例配置面板改上下文窗口/压缩阈值失焦调 instanceSetQuickConfig(带数值)', async () => {
    const app = installApp()
    await openInstances()
    fireEvent.click(screen.getByRole('button', { name: '配置实例' }))
    const ctx = await screen.findByLabelText('上下文窗口') as HTMLInputElement
    const compact = screen.getByLabelText('压缩阈值') as HTMLInputElement
    fireEvent.change(ctx, { target: { value: '516000' } })
    fireEvent.change(compact, { target: { value: '460000' } })
    fireEvent.blur(compact)
    await waitFor(() =>
      expect(app.LocalInstanceSetQuickConfig).toHaveBeenCalledWith('i1', expect.any(String), expect.any(String), expect.any(Boolean), 516000, 460000),
    )
  })

  it('实例配置面板:已配置实例回填 launchMode/follow/上下文当前值', async () => {
    installApp({
      LocalInstanceList: vi.fn().mockResolvedValue([
        { id: 'i1', provider: 'codex', name: '工作', userDataDir: '/tmp/w', launchMode: 'cli', followLocalAccount: true, quickContextWindow: 516000, quickAutoCompact: 460000, createdAt: 1 },
      ]),
    })
    await openInstances()
    fireEvent.click(screen.getByRole('button', { name: '配置实例' }))
    expect((await screen.findByRole('button', { name: 'CLI' })).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('switch', { name: /跟随当前账号/ })).toHaveAttribute('aria-checked', 'true')
    expect((screen.getByLabelText('上下文窗口') as HTMLInputElement).value).toBe('516000')
    expect((screen.getByLabelText('压缩阈值') as HTMLInputElement).value).toBe('460000')
  })

  // ── 跨实例会话:列会话 / token 统计 / 移回收站 / 废纸篓恢复(Wave J)──

  async function openSessions() {
    await openInstances()
    fireEvent.click(screen.getByRole('button', { name: /跨实例会话/ }))
  }

  it('跨实例会话:打开调 listCodexSessions,列出会话(标题/cwd/落点数)', async () => {
    const app = installApp()
    await openSessions()
    await waitFor(() => expect(app.LocalListCodexSessions).toHaveBeenCalledWith('', ''))
    expect(await screen.findByText('重构网关')).toBeInTheDocument()
    expect(screen.getByText('/work/gfa')).toBeInTheDocument()
    // 落点数 = 2(出现在 2 个实例)
    expect(screen.getByText(/2 个实例/)).toBeInTheDocument()
  })

  it('跨实例会话:输入标题过滤重新查询 listCodexSessions(带 titleQuery)', async () => {
    const app = installApp()
    await openSessions()
    await waitFor(() => expect(app.LocalListCodexSessions).toHaveBeenCalled())
    fireEvent.change(await screen.findByLabelText('会话标题过滤'), { target: { value: '网关' } })
    await waitFor(() => expect(app.LocalListCodexSessions).toHaveBeenCalledWith('网关', ''))
  })

  it('跨实例会话:勾选后「统计 token」调 codexSessionTokenStats 并显示用量', async () => {
    const app = installApp()
    await openSessions()
    await screen.findByText('重构网关')
    fireEvent.click(screen.getByRole('checkbox', { name: /选择会话/ }))
    fireEvent.click(screen.getByRole('button', { name: /统计 token/ }))
    await waitFor(() => expect(app.LocalCodexSessionTokenStats).toHaveBeenCalledWith(['s1']))
    // 累计 token 展示
    expect(await screen.findByText(/1540/)).toBeInTheDocument()
  })

  it('跨实例会话:勾选后「移入废纸篓」调 moveCodexSessionsToTrash 并重拉列表', async () => {
    const app = installApp()
    await openSessions()
    await screen.findByText('重构网关')
    expect(app.LocalListCodexSessions).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('checkbox', { name: /选择会话/ }))
    fireEvent.click(screen.getByRole('button', { name: '移入废纸篓' }))
    await waitFor(() => expect(app.LocalMoveCodexSessionsToTrash).toHaveBeenCalledWith(['s1']))
    await waitFor(() => expect(app.LocalListCodexSessions).toHaveBeenCalledTimes(2))
  })

  it('跨实例会话:切到废纸篓调 listTrashedCodexSessions,恢复调 restoreCodexSessionsFromTrash', async () => {
    const app = installApp()
    await openSessions()
    await screen.findByText('重构网关')
    fireEvent.click(screen.getByRole('button', { name: '废纸篓' }))
    await waitFor(() => expect(app.LocalListTrashedCodexSessions).toHaveBeenCalled())
    expect(await screen.findByText('旧会话')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: /选择会话/ }))
    fireEvent.click(screen.getByRole('button', { name: /恢复/ }))
    await waitFor(() => expect(app.LocalRestoreCodexSessionsFromTrash).toHaveBeenCalledWith(['s9']))
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

  // ── 自定义模型供应商 tab(Wave F · codex-only)──

  async function openProviders(app: ReturnType<typeof installApp>) {
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: '供应商' }))
    await waitFor(() => expect(app.LocalListModelProviders).toHaveBeenCalled())
  }

  it('codex 有「供应商」tab,列出供应商(名称/baseURL/模型数,apiKey 掩码不暴露)', async () => {
    const app = installApp()
    await openProviders(app)
    expect(await screen.findByText('DeepSeek')).toBeInTheDocument()
    expect(screen.getByText('https://api.deepseek.com/v1')).toBeInTheDocument()
    // 模型数 = 2(modelCatalog 长度)
    expect(screen.getByText(/2 个模型/)).toBeInTheDocument()
    // apiKey 不以明文暴露
    expect(screen.queryByText('sk-prov-abcd1234efgh')).toBeNull()
  })

  it('供应商 tab 新建弹窗:填名称/baseURL/apiKey/wireApi/模型目录后调 saveModelProvider', async () => {
    const app = installApp()
    await openProviders(app)
    fireEvent.click(screen.getByRole('button', { name: /新建供应商/ }))
    fireEvent.change(await screen.findByLabelText('供应商名称'), { target: { value: '新供应商' } })
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://api.x.com/v1' } })
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-new' } })
    fireEvent.change(screen.getByLabelText('模型目录(逗号分隔)'), { target: { value: 'gpt-4o, o1' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(app.LocalSaveModelProvider).toHaveBeenCalledWith(
      expect.objectContaining({ name: '新供应商', baseURL: 'https://api.x.com/v1', apiKey: 'sk-new', modelCatalog: ['gpt-4o', 'o1'] }),
    ))
  })

  it('供应商 tab apiKey 输入掩码展示(type=password)', async () => {
    const app = installApp()
    await openProviders(app)
    fireEvent.click(screen.getByRole('button', { name: /新建供应商/ }))
    const keyInput = await screen.findByLabelText('API Key') as HTMLInputElement
    expect(keyInput.type).toBe('password')
  })

  it('供应商 tab 拉取模型列表调 listModelProviderModels(回填模型目录)', async () => {
    const app = installApp()
    await openProviders(app)
    await screen.findByText('DeepSeek')
    fireEvent.click(screen.getByRole('button', { name: '拉取模型列表' }))
    await waitFor(() => expect(app.LocalListModelProviderModels).toHaveBeenCalledWith('p1'))
  })

  it('供应商 tab 连通测试调 testModelProvider 并显示结果', async () => {
    const app = installApp()
    await openProviders(app)
    await screen.findByText('DeepSeek')
    fireEvent.click(screen.getByRole('button', { name: '连通测试' }))
    await waitFor(() => expect(app.LocalTestModelProvider).toHaveBeenCalledWith('p1'))
    const result = await screen.findByText(/连通正常/)
    expect(result.textContent).toMatch(/200/)
    expect(result.textContent).toMatch(/88/)
  })

  it('供应商 tab 删除调 deleteModelProvider 并重拉列表', async () => {
    const app = installApp()
    await openProviders(app)
    await screen.findByText('DeepSeek')
    expect(app.LocalListModelProviders).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '删除供应商' }))
    await waitFor(() => expect(app.LocalDeleteModelProvider).toHaveBeenCalledWith('p1'))
    await waitFor(() => expect(app.LocalListModelProviders).toHaveBeenCalledTimes(2))
  })

  it('供应商 tab 空态:无供应商时给空态文案', async () => {
    const app = installApp({ LocalListModelProviders: vi.fn().mockResolvedValue([]) })
    await openProviders(app)
    expect(await screen.findByText(/还没有自定义供应商/)).toBeInTheDocument()
  })

  // ── 经济与自动化 UI(Wave G · codex-only,不污染 antigravity)──

  it('账号 tab 顶部读取 alert/switch/speed 当前值', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    await waitFor(() => expect(app.LocalGetAlertConfig).toHaveBeenCalled())
    await waitFor(() => expect(app.LocalGetSwitchConfig).toHaveBeenCalled())
    await waitFor(() => expect(app.LocalGetAppSpeed).toHaveBeenCalled())
    // 当前 default 速度档 → 「默认」段控高亮
    expect((await screen.findByRole('button', { name: '默认' })).getAttribute('aria-pressed')).toBe('true')
  })

  it('超额预警开关 off→on 调 setAlertConfig(带当前阈值)', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    const sw = await screen.findByRole('switch', { name: /超额预警/ })
    expect(sw).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(sw)
    await waitFor(() => expect(app.LocalSetAlertConfig).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, thresholdPct: 10 })))
  })

  it('改预警阈值输入框失焦调 setAlertConfig(带新阈值)', async () => {
    const app = installApp({ LocalGetAlertConfig: vi.fn().mockResolvedValue({ enabled: true, thresholdPct: 10 }) })
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    const input = await screen.findByLabelText('预警阈值') as HTMLInputElement
    fireEvent.change(input, { target: { value: '25' } })
    fireEvent.blur(input)
    await waitFor(() => expect(app.LocalSetAlertConfig).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, thresholdPct: 25 })))
  })

  it('自动切号开关 off→on 调 setSwitchConfig', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    const sw = await screen.findByRole('switch', { name: /自动切号/ })
    fireEvent.click(sw)
    await waitFor(() => expect(app.LocalSetSwitchConfig).toHaveBeenCalledWith(expect.objectContaining({ enabled: true })))
  })

  it('速度档段控点「快速」调 setAppSpeed(tier=fast)', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(await screen.findByRole('button', { name: '快速' }))
    await waitFor(() => expect(app.LocalSetAppSpeed).toHaveBeenCalledWith(expect.objectContaining({ tier: 'fast' })))
  })

  it('codex OAuth 号行按号服务档点「快速」调 setCodexAccountServiceTier(id, fast)', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    // 用带 aria-label 的按号档控件消歧(与顶部全局速度档区分)。
    fireEvent.click(await screen.findByRole('button', { name: '按号服务档 快速' }))
    await waitFor(() => expect(app.LocalSetCodexAccountServiceTier).toHaveBeenCalledWith('a1', 'fast'))
  })

  it('速度档选「自定义」露出上下文阈值输入,改值调 setAppSpeed(custom)', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(await screen.findByRole('button', { name: '自定义' }))
    const ctx = await screen.findByLabelText('自定义上下文窗口') as HTMLInputElement
    fireEvent.change(ctx, { target: { value: '516000' } })
    fireEvent.blur(ctx)
    await waitFor(() => expect(app.LocalSetAppSpeed).toHaveBeenCalledWith(
      expect.objectContaining({ contextPreset: 'custom', customContextWindow: 516000 }),
    ))
  })

  it('账号行「刷新订阅」调 refreshCodexSubscription(id) 并显示 plan', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(await screen.findByRole('button', { name: '刷新订阅' }))
    await waitFor(() => expect(app.LocalRefreshCodexSubscription).toHaveBeenCalledWith('a1'))
    expect(await screen.findByText(/2026-12-31/)).toBeInTheDocument()
  })

  it('账号行展开后读取 reset 次数(显示可用次数),消费调 consumeCodexResetCredit', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    await waitFor(() => expect(app.LocalGetCodexResetCredits).toHaveBeenCalledWith('a1'))
    expect(await screen.findByText(/可用 2 次/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /消费一次/ }))
    await waitFor(() => expect(app.LocalConsumeCodexResetCredit).toHaveBeenCalledWith('a1', ''))
  })

  it('账号行邀请返利:查资格→填邮箱→发送调 sendCodexReferralInvites', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(await screen.findByRole('button', { name: /邀请返利/ }))
    await waitFor(() => expect(app.LocalCodexReferralEligibility).toHaveBeenCalledWith('a1', ''))
    expect(await screen.findByText(/剩余 3/)).toBeInTheDocument()
    fireEvent.change(await screen.findByLabelText('邀请邮箱'), { target: { value: 'friend@x.com' } })
    fireEvent.click(screen.getByRole('button', { name: '发送邀请' }))
    await waitFor(() => expect(app.LocalSendCodexReferralInvites).toHaveBeenCalledWith('a1', '', ['friend@x.com']))
  })

  // ── Codex 设置 tab(Wave H · codex-only,不污染 antigravity)──

  it('codex 有「设置」tab(hasSettings),打开后加载 codex 设置面板', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    await waitFor(() => expect(app.LocalGetCodexSettings).toHaveBeenCalled())
    expect(await screen.findByLabelText('Codex app 路径')).toBeInTheDocument()
  })

  it('设置 tab 切「显示 API 服务入口」开关调 saveCodexSettings', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    const sw = await screen.findByRole('switch', { name: /显示 API 服务入口/ })
    fireEvent.click(sw)
    await waitFor(() =>
      expect(app.LocalSaveCodexSettings).toHaveBeenCalledWith(expect.objectContaining({ showApiEntry: false })),
    )
  })

  it('设置 tab「去保活设置」切到 suite 内「保活」tab', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(await screen.findByRole('button', { name: /去保活设置/ }))
    // 切到保活 tab:保活 tab 会拉 wakeupConfig
    await waitFor(() => expect(app.LocalCodexWakeupConfig).toHaveBeenCalled())
  })

  // ── 账号组织:分组 + 显式当前号 + 重排序(Wave I · 共享)──

  it('账号 tab 加载时拉分组与归属映射,渲染分组筛选条', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    await waitFor(() => expect(app.LocalListAccountGroups).toHaveBeenCalled())
    await waitFor(() => expect(app.LocalResolveAccountGroups).toHaveBeenCalled())
    // 分组筛选条:全部 + 已建分组「主力」
    expect(await screen.findByRole('button', { name: '全部账号' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /主力/ })).toBeInTheDocument()
  })

  it('新建分组:填名称调 createAccountGroup 并重拉分组', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    await waitFor(() => expect(app.LocalListAccountGroups).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: /新建分组/ }))
    fireEvent.change(await screen.findByLabelText('分组名称'), { target: { value: '备用' } })
    fireEvent.click(screen.getByRole('button', { name: '创建分组' }))
    await waitFor(() => expect(app.LocalCreateAccountGroup).toHaveBeenCalledWith('备用'))
    await waitFor(() => expect(app.LocalListAccountGroups).toHaveBeenCalledTimes(2))
  })

  it('按分组筛选:点「主力」只显示该组账号,点「全部」恢复', async () => {
    installApp({
      LocalListCodexAccounts: vi.fn().mockResolvedValue([
        fakeAccount({ id: 'a1', email: 'in-group@x.com' }),
        fakeAccount({ id: 'a2', email: 'no-group@x.com', priority: false }),
      ]),
      LocalResolveAccountGroups: vi.fn().mockResolvedValue({ a1: 'gr1' }),
    })
    render(<CodexSuitePage />)
    await screen.findByText('in-group@x.com')
    expect(screen.getByText('no-group@x.com')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /主力/ }))
    await waitFor(() => expect(screen.queryByText('no-group@x.com')).toBeNull())
    expect(screen.getByText('in-group@x.com')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '全部账号' }))
    expect(await screen.findByText('no-group@x.com')).toBeInTheDocument()
  })

  it('编辑账号弹窗可选所属分组,改组调 assignAccountsToGroup', async () => {
    const app = installApp()
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    fireEvent.click(screen.getByRole('button', { name: '编辑账号' }))
    const sel = await screen.findByLabelText('所属分组') as HTMLSelectElement
    // 当前归属 gr1(主力)
    expect(sel.value).toBe('gr1')
    // 选另一组(创建一个后切;此处先建组使其出现在下拉)—— 直接切到「无分组」走移除
    fireEvent.change(sel, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(app.LocalRemoveAccountsFromGroup).toHaveBeenCalledWith('gr1', ['a1']))
  })

  it('账号行「设为当前号」调 setCurrentAccount 并重拉列表', async () => {
    const app = installApp({
      LocalListCodexAccounts: vi.fn().mockResolvedValue([
        fakeAccount({ id: 'a2', email: 'not-current@x.com', priority: false }),
      ]),
    })
    render(<CodexSuitePage />)
    await screen.findByText('not-current@x.com')
    expect(app.LocalListCodexAccounts).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '设为当前号' }))
    await waitFor(() => expect(app.LocalSetCurrentCodexAccount).toHaveBeenCalledWith('a2'))
    await waitFor(() => expect(app.LocalListCodexAccounts).toHaveBeenCalledTimes(2))
  })

  it('已是当前号(priority)时不显示「设为当前号」,显示「当前」标记', async () => {
    installApp({
      LocalListCodexAccounts: vi.fn().mockResolvedValue([fakeAccount({ id: 'a1', priority: true })]),
    })
    render(<CodexSuitePage />)
    await screen.findByText('yifan@example.com')
    expect(screen.queryByRole('button', { name: '设为当前号' })).toBeNull()
    expect(screen.getByText('当前号')).toBeInTheDocument()
  })

  it('↑↓ 重排序:点「下移」按新顺序调 reorderAccounts 并重拉列表', async () => {
    const app = installApp({
      LocalListCodexAccounts: vi.fn().mockResolvedValue([
        fakeAccount({ id: 'a1', email: 'first@x.com', priority: false }),
        fakeAccount({ id: 'a2', email: 'second@x.com', priority: false }),
      ]),
    })
    render(<CodexSuitePage />)
    await screen.findByText('first@x.com')
    // 第一行的「下移」:a1 与 a2 互换 → 顺序 ['a2','a1']
    const downButtons = screen.getAllByRole('button', { name: '下移' })
    fireEvent.click(downButtons[0])
    await waitFor(() => expect(app.LocalReorderCodexAccounts).toHaveBeenCalledWith(['a2', 'a1']))
    await waitFor(() => expect(app.LocalListCodexAccounts).toHaveBeenCalledTimes(2))
  })

  it('首行「上移」与末行「下移」禁用(无法越界)', async () => {
    installApp({
      LocalListCodexAccounts: vi.fn().mockResolvedValue([
        fakeAccount({ id: 'a1', email: 'first@x.com', priority: false }),
        fakeAccount({ id: 'a2', email: 'second@x.com', priority: false }),
      ]),
    })
    render(<CodexSuitePage />)
    await screen.findByText('first@x.com')
    const ups = screen.getAllByRole('button', { name: '上移' })
    const downs = screen.getAllByRole('button', { name: '下移' })
    expect(ups[0]).toBeDisabled()
    expect(downs[downs.length - 1]).toBeDisabled()
  })

  // codex 无独立「数据」tab(数据迁移/WebDAV 已移除);antigravity 的运行时/切换历史见 AntigravitySuitePage 测试。
})
