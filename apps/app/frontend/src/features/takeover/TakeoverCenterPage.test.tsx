import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 远程 wails api(接管引擎用)。渲染期不调用,点击 handler 才调。
const { apiMocks } = vi.hoisted(() => ({
  apiMocks: {
    injectSelected: vi.fn(),
    restoreSelected: vi.fn(),
    openSystemPermissionSettings: vi.fn(),
    openURL: vi.fn(),
  },
}))
vi.mock('@/services/wails', () => ({
  injectSelected: apiMocks.injectSelected,
  restoreSelected: apiMocks.restoreSelected,
  openSystemPermissionSettings: apiMocks.openSystemPermissionSettings,
  openURL: apiMocks.openURL,
}))

// 本地号 api(codex / antigravity 的本地模式用)。
const { codexApi, antigravityApi, agTargetMocks } = vi.hoisted(() => {
  const mk = () => ({
    getSource: vi.fn().mockResolvedValue('remote'),
    setSource: vi.fn().mockResolvedValue(undefined),
    gatewayStatus: vi.fn().mockResolvedValue({ running: false, addr: '', port: 0 }),
    listAccounts: vi.fn().mockResolvedValue([]),
  })
  return {
    codexApi: mk(), antigravityApi: mk(),
    agTargetMocks: {
      getAntigravityTarget: vi.fn().mockResolvedValue('ide'),
      setAntigravityTarget: vi.fn().mockResolvedValue(undefined),
    },
  }
})
vi.mock('@/services/localApi', () => ({
  codexLocalApi: codexApi,
  antigravityLocalApi: antigravityApi,
  getAntigravityTarget: agTargetMocks.getAntigravityTarget,
  setAntigravityTarget: agTargetMocks.setAntigravityTarget,
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
    store.state.ideProducts = [
      { id: 'claude_code', name: 'Claude Code (CLI + VSCode)', detected: true, injected: false },
      { id: 'claude_desktop', name: 'Claude Desktop (Code/Cowork)', detected: true, injected: false },
      { id: 'codex', name: 'Codex', detected: true, injected: false },
      { id: 'antigravity_ide', name: 'Antigravity IDE', detected: true, injected: false },
      { id: 'antigravity_hub', name: 'Antigravity Hub', detected: true, injected: false },
    ]
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
    const status = screen.getByText('未安装 / 未检测到')
    const row = status.parentElement!.parentElement!
    expect(within(row).getByRole('button', { name: '接管' })).toBeDisabled()
  })

  it('Store 版 Claude Desktop 确认后打开官方独立版下载地址', async () => {
    setPlatform('Win32')
    apiMocks.injectSelected.mockResolvedValue('STORE_CLAUDE:检测到 Microsoft Store 版 Claude Desktop')
    render(<TakeoverCenterPage />)
    const desktopRow = screen.getByText('Claude Desktop (Code/Cowork)').closest('.flex.items-center.justify-between')
    if (!(desktopRow instanceof HTMLElement)) throw new Error('desktop row not found')
    fireEvent.click(within(desktopRow).getByRole('button', { name: '接管' }))
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
    await within(ag).findByRole('button', { name: '接管' })
    expect(within(ag).getByText(/注入 state\.vscdb.*直连官方/)).toBeInTheDocument()
    expect(within(ag).getByText(/不走反代/)).toBeInTheDocument()
    // 接管语义不应再写「网关 127.0.0.1」/「指向本地反代」
    expect(within(ag).queryByText(/127\.0\.0\.1/)).toBeNull()
    expect(within(ag).queryByText(/指向本地反代/)).toBeNull()
  })

  it('Antigravity 本地卡有「注入到 IDE/独立版」段控,切独立版调 setAntigravityTarget(standalone)', async () => {
    setPlatform('MacIntel')
    render(<TakeoverCenterPage />)
    const ag = screen.getByRole('region', { name: 'Antigravity' })
    fireEvent.click(within(ag).getByRole('button', { name: '本地自有号' }))
    await waitFor(() => expect(agTargetMocks.getAntigravityTarget).toHaveBeenCalled())
    fireEvent.click(await within(ag).findByRole('button', { name: '注入目标 独立版' }))
    await waitFor(() => expect(agTargetMocks.setAntigravityTarget).toHaveBeenCalledWith('standalone'))
    // codex 卡不应有注入目标段控(仅 antigravity)。
    const codex = screen.getByRole('region', { name: 'Codex' })
    fireEvent.click(within(codex).getByRole('button', { name: '本地自有号' }))
    expect(within(codex).queryByRole('button', { name: /注入目标/ })).toBeNull()
  })

  it('Antigravity 已本地接管时显示「已接管 · 直连官方」(不显示网关地址)', async () => {
    setPlatform('MacIntel')
    antigravityApi.getSource.mockResolvedValue('local')
    // 即便 gatewayStatus 谎报 running,也不该显示网关地址(inject 不走网关)
    antigravityApi.gatewayStatus.mockResolvedValue({ running: true, addr: '127.0.0.1:9999', port: 9999 })
    render(<TakeoverCenterPage />)
    const ag = screen.getByRole('region', { name: 'Antigravity' })
    expect(await within(ag).findByText(/已接管 · 直连官方/)).toBeInTheDocument()
    expect(within(ag).queryByText(/127\.0\.0\.1/)).toBeNull()
  })
})
