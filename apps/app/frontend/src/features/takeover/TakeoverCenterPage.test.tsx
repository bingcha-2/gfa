import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 远程 wails api(接管引擎用)。渲染期不调用,点击 handler 才调。
const { apiMocks } = vi.hoisted(() => ({
  apiMocks: {
    injectSelected: vi.fn(),
    restoreSelected: vi.fn(),
    openSystemPermissionSettings: vi.fn(),
    openURL: vi.fn(),
    getCodexFastMode: vi.fn().mockResolvedValue(false),
    setCodexFastMode: vi.fn().mockResolvedValue(undefined),
    getHostProtectionStatus: vi.fn().mockResolvedValue({
      mode: 'configure', platform: 'windows', requiresAuthorization: false,
      originalTimezone: 'Asia/Shanghai', exitTimezone: 'Asia/Singapore', appliedTimezone: '',
      timezoneStrategy: 'follow', blockWebRTC: true, blockGeolocation: true, dnsCleared: false,
      targets: ['claude', 'claude_desktop'], lastError: '',
    }),
    probeHostProtectionStatus: vi.fn().mockImplementation(async (targets: string[]) => ({
      mode: 'configure', platform: 'windows', requiresAuthorization: false,
      originalTimezone: 'Asia/Shanghai', exitTimezone: 'Asia/Singapore', appliedTimezone: '',
      timezoneStrategy: 'follow', blockWebRTC: true, blockGeolocation: true, dnsCleared: false,
      targets, lastError: '',
    })),
    applyHostProtection: vi.fn().mockImplementation(async (cfg: Record<string, unknown>) => ({
      ...cfg, mode: 'active', platform: 'windows', requiresAuthorization: false,
      originalTimezone: 'Asia/Shanghai', exitTimezone: 'Asia/Singapore', appliedTimezone: 'Asia/Singapore', dnsCleared: true, lastError: '',
    })),
    restoreHostProtection: vi.fn().mockResolvedValue({
      mode: 'restored', platform: 'windows', requiresAuthorization: false,
      originalTimezone: 'Asia/Shanghai', exitTimezone: 'Asia/Singapore', appliedTimezone: 'Asia/Shanghai',
      timezoneStrategy: 'follow', blockWebRTC: false, blockGeolocation: false, dnsCleared: true,
      targets: ['claude', 'claude_desktop'], lastError: '',
    }),
    releaseHostProtectionTarget: vi.fn(),
    // 默认无第三方中转冲突,不弹 relay 窗;需要测门控的用例用 mockResolvedValueOnce 覆盖。
    detectCompetingClaudeConfig: vi.fn().mockResolvedValue([]),
    sanitizeCompetingClaudeConfig: vi.fn().mockResolvedValue({ cleaned: [], skipped: [], backupTo: '' }),
  },
}))
vi.mock('@/services/wails', () => ({
  injectSelected: apiMocks.injectSelected,
  restoreSelected: apiMocks.restoreSelected,
  openSystemPermissionSettings: apiMocks.openSystemPermissionSettings,
  openURL: apiMocks.openURL,
  getCodexFastMode: apiMocks.getCodexFastMode,
  setCodexFastMode: apiMocks.setCodexFastMode,
  getHostProtectionStatus: apiMocks.getHostProtectionStatus,
  probeHostProtectionStatus: apiMocks.probeHostProtectionStatus,
  applyHostProtection: apiMocks.applyHostProtection,
  restoreHostProtection: apiMocks.restoreHostProtection,
  releaseHostProtectionTarget: apiMocks.releaseHostProtectionTarget,
  detectCompetingClaudeConfig: apiMocks.detectCompetingClaudeConfig,
  sanitizeCompetingClaudeConfig: apiMocks.sanitizeCompetingClaudeConfig,
}))

// 本地号 api(codex / antigravity 的本地模式用)。
const { codexApi, antigravityApi, agLocalMocks } = vi.hoisted(() => {
  const mk = () => ({
    getSource: vi.fn().mockResolvedValue('remote'),
    setSource: vi.fn().mockResolvedValue(undefined),
    gatewayStatus: vi.fn().mockResolvedValue({ running: false, addr: '', port: 0 }),
    listAccounts: vi.fn().mockResolvedValue([]),
  })
  return {
    codexApi: mk(), antigravityApi: mk(),
    agLocalMocks: {
      antigravityLocalInjected: vi.fn().mockResolvedValue(false),
      setAntigravityLocalInjected: vi.fn().mockResolvedValue(undefined),
      listModelProviders: vi.fn().mockResolvedValue([]),
    },
  }
})
vi.mock('@/services/localApi', () => ({
  codexLocalApi: codexApi,
  antigravityLocalApi: antigravityApi,
  antigravityLocalInjected: agLocalMocks.antigravityLocalInjected,
  setAntigravityLocalInjected: agLocalMocks.setAntigravityLocalInjected,
  listModelProviders: agLocalMocks.listModelProviders,
}))

const { store } = vi.hoisted(() => ({
  store: {
    state: {
      config: { userToken: 'tok-xyz' },
      ideProducts: [
        { id: 'claude_code', name: 'Claude Code (CLI + VSCode)', detected: true, injected: false },
        { id: 'claude_desktop', name: 'Claude Desktop (Code/Cowork)', detected: true, injected: false },
        { id: 'codex', name: 'Codex', detected: true, injected: false },
        { id: 'antigravity_ide', name: 'Antigravity IDE', detected: true, injected: false },
        { id: 'antigravity_hub', name: 'Antigravity Hub', detected: true, injected: false },
      ] as Array<Record<string, unknown>>,
      fetchIDEStatus: () => store.state.ideProducts,
      proxyRunning: true,
      proxyPort: 48801,
    },
  },
}))
vi.mock('@/stores/useAppStore', () => ({
  useAppStore: (selector: (s: typeof store.state) => unknown) => selector(store.state),
}))

import { TakeoverCenterPage } from './TakeoverCenterPage'

function setPlatform(p: string) {
  Object.defineProperty(window.navigator, 'platform', { value: p, configurable: true })
}

describe('TakeoverCenterPage — 统一接管中心', () => {
  afterEach(() => {
    vi.clearAllMocks()
    codexApi.getSource.mockResolvedValue('remote')
    antigravityApi.getSource.mockResolvedValue('remote')
    agLocalMocks.antigravityLocalInjected.mockResolvedValue(false)
    agLocalMocks.setAntigravityLocalInjected.mockResolvedValue(undefined)
    agLocalMocks.listModelProviders.mockResolvedValue([])
    store.state.ideProducts = [
      { id: 'claude_code', name: 'Claude Code (CLI + VSCode)', detected: true, injected: false },
      { id: 'claude_desktop', name: 'Claude Desktop (Code/Cowork)', detected: true, injected: false },
      { id: 'codex', name: 'Codex', detected: true, injected: false },
      { id: 'antigravity_ide', name: 'Antigravity IDE', detected: true, injected: false },
      { id: 'antigravity_hub', name: 'Antigravity Hub', detected: true, injected: false },
    ]
    store.state.config = { userToken: 'tok-xyz' }
  })

  it('渲染 Claude / Codex / Antigravity 三张产品卡', () => {
    setPlatform('MacIntel')
    render(<TakeoverCenterPage />)
    expect(screen.getByRole('region', { name: 'Anthropic' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Codex' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Antigravity' })).toBeInTheDocument()
  })

  // Claude 卡:仅远程托管,无模式段控。
  it('Claude 卡无「本地自有号」模式段(仅远程)', () => {
    setPlatform('MacIntel')
    render(<TakeoverCenterPage />)
    const claude = screen.getByRole('region', { name: 'Anthropic' })
    expect(within(claude).queryByRole('button', { name: '本地自有号' })).toBeNull()
  })

  it('未登录时不自动探出口，仍保留点击接管后的登录引导', async () => {
    setPlatform('Win32')
    store.state.config = { userToken: '' }
    apiMocks.getHostProtectionStatus.mockResolvedValueOnce({
      mode: 'configure', platform: 'windows', requiresAuthorization: false,
      originalTimezone: 'Asia/Shanghai', exitTimezone: '', appliedTimezone: '',
      timezoneStrategy: 'follow', blockWebRTC: true, blockGeolocation: true, dnsCleared: false,
      targets: [], lastError: '',
    })
    render(<TakeoverCenterPage />)
    await waitFor(() => expect(apiMocks.getHostProtectionStatus).toHaveBeenCalled())
    const takeover = screen.getByRole('button', { name: /确认并接管/ })
    expect(takeover).not.toBeDisabled()
    fireEvent.click(takeover)
    expect(await screen.findByText('需要登录账号')).toBeInTheDocument()
    expect(apiMocks.probeHostProtectionStatus).not.toHaveBeenCalled()
  })

  // ── 回归守门:Claude Desktop 跨平台显示(从 TokenSourceControl 迁移) ──
  it('Windows 上检测到 Claude Desktop 显示接管入口', () => {
    setPlatform('Win32')
    render(<TakeoverCenterPage />)
    expect(screen.getByText('Claude Desktop (Code/Cowork)')).toBeInTheDocument()
  })

  it('Linux 上不显示 Claude Desktop(无官方桌面端)', () => {
    setPlatform('Linux x86_64')
    render(<TakeoverCenterPage />)
    expect(screen.queryByText('Claude Desktop (Code/Cowork)')).toBeNull()
  })

  it('未检测到 Claude Desktop 时灰显、接管按钮禁用', () => {
    setPlatform('Win32')
    store.state.ideProducts = [
      { id: 'claude_desktop', name: 'Claude Desktop (Code/Cowork)', detected: false, injected: false },
      { id: 'codex', name: 'Codex', detected: true, injected: false },
      { id: 'antigravity_ide', name: 'Antigravity IDE', detected: true, injected: false },
    ]
    render(<TakeoverCenterPage />)
    const desktop = screen.getByRole('button', { name: /Claude Desktop \(Code\/Cowork\)/ })
    expect(desktop).toBeDisabled()
    expect(within(desktop).getByText('未安装 / 未检测到')).toBeInTheDocument()
  })

  it('Store 版 Claude Desktop 确认后打开官方独立版下载地址', async () => {
    setPlatform('Win32')
    apiMocks.injectSelected.mockResolvedValue('STORE_CLAUDE:检测到 Microsoft Store 版 Claude Desktop')
    render(<TakeoverCenterPage />)
    const takeover = screen.getByRole('button', { name: /确认并接管/ })
    await waitFor(() => expect(takeover).not.toBeDisabled())
    // 只接管 Desktop，避免先走 Claude Code 分支。
    fireEvent.click(screen.getByRole('button', { name: /Claude Code \(CLI \+ VSCode\)/ }))
    fireEvent.click(takeover)
    // 桌面端二次确认 → 确认接管 → STORE_CLAUDE 引导 → 下载独立版
    fireEvent.click(await screen.findByRole('button', { name: '确认' }))
    fireEvent.click(await screen.findByRole('button', { name: '下载独立版' }))
    await waitFor(() => {
      expect(apiMocks.openURL).toHaveBeenCalledWith('https://claude.ai/api/desktop/win32/x64/exe/latest/redirect')
    })
  })

  // ── 本地模式切换(接管中心独有) ──
  it('Codex 卡:切到本地自有号并接管 → 调 codexLocalApi.setSource(local)', async () => {
    setPlatform('MacIntel')
    render(<TakeoverCenterPage />)
    const codex = screen.getByRole('region', { name: 'Codex' })
    // 切到本地段
    fireEvent.click(within(codex).getByRole('button', { name: '本地自有号' }))
    // 本地控件出现 → 接管
    const takeoverBtn = await within(codex).findByRole('button', { name: '接管' })
    fireEvent.click(takeoverBtn)
    await waitFor(() => {
      expect(codexApi.setSource).toHaveBeenCalledWith('local')
    })
    // 不应误调远程注入
    expect(apiMocks.injectSelected).not.toHaveBeenCalled()
  })

  it('Codex 已在本地模式时显示「停止」并调 setSource(remote)', async () => {
    setPlatform('MacIntel')
    codexApi.getSource.mockResolvedValue('local')
    codexApi.gatewayStatus.mockResolvedValue({ running: true, addr: '127.0.0.1:8317', port: 8317 })
    render(<TakeoverCenterPage />)
    const codex = screen.getByRole('region', { name: 'Codex' })
    const stopBtn = await within(codex).findByRole('button', { name: '停止' })
    fireEvent.click(stopBtn)
    await waitFor(() => {
      expect(codexApi.setSource).toHaveBeenCalledWith('remote')
    })
  })

  // ── 模型厂商接管(接管中心选厂商) ──
  it('Codex 卡:本地段选自定义厂商并接管 → 调 setSource(provider:<id>)', async () => {
    setPlatform('MacIntel')
    agLocalMocks.listModelProviders.mockResolvedValue([
      { id: 'p1', name: 'MyVend', baseURL: 'https://api.vend.com/v1', apiKey: 'k', wireApi: 'responses', modelCatalog: [], createdAt: 0 },
    ])
    render(<TakeoverCenterPage />)
    const codex = screen.getByRole('region', { name: 'Codex' })
    fireEvent.click(within(codex).getByRole('button', { name: '本地自有号' }))
    // 号源下拉出现,选中厂商 p1
    const select = await within(codex).findByRole('combobox', { name: 'codex 本地接管号源' })
    fireEvent.change(select, { target: { value: 'p1' } })
    // 接管
    fireEvent.click(await within(codex).findByRole('button', { name: '接管' }))
    await waitFor(() => {
      expect(codexApi.setSource).toHaveBeenCalledWith('provider:p1')
    })
  })

  it('Codex 已用厂商接管:回填选中厂商 + 状态显示厂商名', async () => {
    setPlatform('MacIntel')
    codexApi.getSource.mockResolvedValue('provider:p1')
    agLocalMocks.listModelProviders.mockResolvedValue([
      { id: 'p1', name: 'MyVend', baseURL: 'https://api.vend.com/v1', apiKey: 'k', wireApi: 'responses', modelCatalog: [], createdAt: 0 },
    ])
    render(<TakeoverCenterPage />)
    const codex = screen.getByRole('region', { name: 'Codex' })
    // provider 号源被视为本地接管 → 显示「停止」
    const stop = await within(codex).findByRole('button', { name: '停止' })
    expect(within(codex).getByText(/已接管 · 厂商 MyVend/)).toBeInTheDocument()
    const select = within(codex).getByRole('combobox', { name: 'codex 本地接管号源' }) as HTMLSelectElement
    expect(select.value).toBe('p1')
    fireEvent.click(stop)
    await waitFor(() => expect(codexApi.setSource).toHaveBeenCalledWith('remote'))
  })

  // ── 本地语义文案:codex 与 antigravity 都是注入式接管(直连官方),反代是另一回事 ──
  it('Codex 本地模式头部副标题点明「注入 auth.json + 不走反代」(反代是单独功能)', async () => {
    setPlatform('MacIntel')
    render(<TakeoverCenterPage />)
    const codex = screen.getByRole('region', { name: 'Codex' })
    fireEvent.click(within(codex).getByRole('button', { name: '本地自有号' }))
    await within(codex).findByRole('button', { name: '接管' })
    expect(within(codex).getByText(/注入.*auth\.json/)).toBeInTheDocument()
    expect(within(codex).getByText(/不走反代/)).toBeInTheDocument()
    // 接管不再是「指向反代」
    expect(within(codex).queryByText(/指向本地反代/)).toBeNull()
  })

  it('Codex 已本地接管时显示「已接管 · 直连官方」(注入式,不显示网关地址)', async () => {
    setPlatform('MacIntel')
    codexApi.getSource.mockResolvedValue('local')
    render(<TakeoverCenterPage />)
    const codex = screen.getByRole('region', { name: 'Codex' })
    expect(await within(codex).findByText(/已接管 · 直连官方/)).toBeInTheDocument()
    expect(within(codex).queryByText(/127\.0\.0\.1/)).toBeNull()
  })

  it('Antigravity 本地模式头部副标题点明「注入 state.vscdb、直连官方、不走反代」且不提网关地址', async () => {
    setPlatform('MacIntel')
    render(<TakeoverCenterPage />)
    const ag = screen.getByRole('region', { name: 'Antigravity' })
    fireEvent.click(within(ag).getByRole('button', { name: '本地自有号' }))
    // 本地模式两行(IDE + 独立版),各带一个「接管」。
    expect((await within(ag).findAllByRole('button', { name: '接管' })).length).toBe(2)
    expect(within(ag).getByText(/注入 state\.vscdb.*直连官方/)).toBeInTheDocument()
    expect(within(ag).getByText(/不走反代/)).toBeInTheDocument()
    // 接管语义不应再写「网关 127.0.0.1」/「指向本地反代」
    expect(within(ag).queryByText(/127\.0\.0\.1/)).toBeNull()
    expect(within(ag).queryByText(/指向本地反代/)).toBeNull()
  })

  it('Antigravity 本地卡按 app 两行独立接管:点独立版「接管」调 setAntigravityLocalInjected(standalone,true)', async () => {
    setPlatform('MacIntel')
    render(<TakeoverCenterPage />)
    const ag = screen.getByRole('region', { name: 'Antigravity' })
    fireEvent.click(within(ag).getByRole('button', { name: '本地自有号' }))
    // 两行:Antigravity IDE + Antigravity 独立版,和远程那两行对称。
    expect(await within(ag).findByText('Antigravity IDE')).toBeInTheDocument()
    expect(within(ag).getByText('Antigravity 独立版')).toBeInTheDocument()
    const takeovers = within(ag).getAllByRole('button', { name: '接管' })
    expect(takeovers.length).toBe(2)
    fireEvent.click(takeovers[1]) // 独立版(IDE 行在前)
    await waitFor(() => expect(agLocalMocks.setAntigravityLocalInjected).toHaveBeenCalledWith('standalone', true))
    // codex 仍是单按钮(非按 app 两行)。
    const codex = screen.getByRole('region', { name: 'Codex' })
    fireEvent.click(within(codex).getByRole('button', { name: '本地自有号' }))
    expect(within(codex).getAllByRole('button', { name: '接管' }).length).toBe(1)
  })

  it('Antigravity app 已本地接管时该行显示「已接管 · 直连官方」(不显示网关地址)', async () => {
    setPlatform('MacIntel')
    antigravityApi.getSource.mockResolvedValue('local')
    agLocalMocks.antigravityLocalInjected.mockResolvedValue(true) // 两个 app 都已接管
    // 即便 gatewayStatus 谎报 running,也不该显示网关地址(inject 不走网关)
    antigravityApi.gatewayStatus.mockResolvedValue({ running: true, addr: '127.0.0.1:9999', port: 9999 })
    render(<TakeoverCenterPage />)
    const ag = screen.getByRole('region', { name: 'Antigravity' })
    expect((await within(ag).findAllByText(/已接管 · 直连官方/)).length).toBeGreaterThanOrEqual(1)
    // 已接管的 app 行给出「停止」按钮。
    expect(within(ag).getAllByRole('button', { name: '停止' }).length).toBeGreaterThanOrEqual(1)
    expect(within(ag).queryByText(/127\.0\.0\.1/)).toBeNull()
  })

  // ── 接管前第三方中转预检(从 main 合入,接回接管中心)──
  it('接管 Claude 前检测到 cc-switch:弹免责窗,勾选清理后调 sanitize 再接管', async () => {
    setPlatform('Win32')
    apiMocks.detectCompetingClaudeConfig.mockResolvedValueOnce([
      { id: 'cc1', kind: 'cc-switch', detail: 'ANTHROPIC_BASE_URL=https://cc-switch.example' },
    ])
    apiMocks.injectSelected.mockResolvedValueOnce('接管失败') // 快速返回,避免 8s 状态轮询
    render(<TakeoverCenterPage />)
    const takeover = screen.getByRole('button', { name: /确认并接管/ })
    await waitFor(() => expect(takeover).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: /Claude Desktop \(Code\/Cowork\)/ }))
    fireEvent.click(takeover)

    // 检出冲突 → 弹「封号免责」窗;未勾选时「清理」禁用。
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/检测到第三方中转配置/)).toBeInTheDocument()
    const cleanBtn = within(dialog).getByRole('button', { name: '已知晓，清理并接管' })
    expect(cleanBtn).toBeDisabled()

    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(cleanBtn)

    // 清理调 sanitize(空数组=全部),随后才真正接管 claude。
    await waitFor(() => expect(apiMocks.sanitizeCompetingClaudeConfig).toHaveBeenCalledWith([]))
    await waitFor(() => expect(apiMocks.injectSelected).toHaveBeenCalledWith(['claude']))
  })

  it('接管 Claude 前检测到冲突,用户「仍要接管」:不清理但继续接管', async () => {
    setPlatform('Win32')
    apiMocks.detectCompetingClaudeConfig.mockResolvedValueOnce([
      { id: 'cc1', kind: 'cc-switch', detail: 'x' },
    ])
    render(<TakeoverCenterPage />)
    const takeover = screen.getByRole('button', { name: /确认并接管/ })
    await waitFor(() => expect(takeover).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: /Claude Desktop \(Code\/Cowork\)/ }))
    fireEvent.click(takeover)
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '仍要接管' }))
    // 「仍要接管」= skip:不清理,但继续接管。
    await waitFor(() => expect(apiMocks.injectSelected).toHaveBeenCalledWith(['claude']))
    expect(apiMocks.sanitizeCompetingClaudeConfig).not.toHaveBeenCalled()
  })
})
