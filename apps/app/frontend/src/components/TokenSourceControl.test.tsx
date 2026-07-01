import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 隔离 wails 运行时:组件 `import * as api`,渲染期不会调用(仅点击 handler 才调),
// mock 掉避免引入 window.go 运行时依赖。
const { apiMocks } = vi.hoisted(() => ({
  apiMocks: {
    injectSelected: vi.fn(),
    restoreSelected: vi.fn(),
    openSystemPermissionSettings: vi.fn(),
    installStandaloneClaude: vi.fn(),
    openURL: vi.fn(),
    detectCompetingClaudeConfig: vi.fn().mockResolvedValue([]),
    sanitizeCompetingClaudeConfig: vi.fn(),
  },
}))

vi.mock('@/services/wails', () => ({
  injectSelected: apiMocks.injectSelected,
  restoreSelected: apiMocks.restoreSelected,
  openSystemPermissionSettings: apiMocks.openSystemPermissionSettings,
  installStandaloneClaude: apiMocks.installStandaloneClaude,
  openURL: apiMocks.openURL,
  detectCompetingClaudeConfig: apiMocks.detectCompetingClaudeConfig,
  sanitizeCompetingClaudeConfig: apiMocks.sanitizeCompetingClaudeConfig,
}))

// zustand store 以 selector 形式读取;mock 成"对给定 state 跑 selector"。
// 用 vi.hoisted 让 mock 工厂(被提升到 import 之上)能拿到这份可变 state。
const { store } = vi.hoisted(() => ({
  store: {
    state: {
      config: { userToken: 'tok-xyz' },
      ideProducts: [
        { id: 'claude_desktop', name: 'Claude Desktop (Code/Cowork)', detected: true, injected: false },
      ] as Array<Record<string, unknown>>,
      fetchIDEStatus: () => {},
      proxyRunning: true,
      proxyPort: 48801,
    },
  },
}))
vi.mock('@/stores/useAppStore', () => ({
  useAppStore: (selector: (s: typeof store.state) => unknown) => selector(store.state),
}))

import { TokenSourceControl } from './TokenSourceControl'

const DESKTOP_LABEL = 'Claude Desktop (Code/Cowork)'

function setPlatform(p: string) {
  Object.defineProperty(window.navigator, 'platform', { value: p, configurable: true })
}

describe('TokenSourceControl — Claude Desktop 接管入口跨平台', () => {
  afterEach(() => {
    vi.clearAllMocks()
    // 复位 detected,避免测试间串味。
    store.state.ideProducts = [
      { id: 'claude_desktop', name: DESKTOP_LABEL, detected: true, injected: false },
    ]
  })

  // 回归守门:Windows 上检测到桌面端就该显示接管入口(此前被 `isMac &&` 挡掉,只有 mac 显示)。
  it('Windows 上检测到 Claude Desktop 时显示接管入口', () => {
    setPlatform('Win32')
    render(<TokenSourceControl />)
    expect(screen.getByText(DESKTOP_LABEL)).toBeInTheDocument()
  })

  it('macOS 上同样显示(去门后两平台一致)', () => {
    setPlatform('MacIntel')
    render(<TokenSourceControl />)
    expect(screen.getByText(DESKTOP_LABEL)).toBeInTheDocument()
  })

  // 未检测到也「常显示」——灰一行「未安装 / 未检测到」、接管按钮禁用,而不是整块隐藏。
  // 隐藏才是反馈里「Claude 开着才冒出来」死循环的源头,故改为常显示 + 设置里可手动指定路径。
  it('未检测到 Claude Desktop 时仍显示(灰显未安装,按钮禁用)', () => {
    setPlatform('Win32')
    store.state.ideProducts = [
      { id: 'claude_desktop', name: DESKTOP_LABEL, detected: false, injected: false },
    ]
    render(<TokenSourceControl />)
    expect(screen.getByText(DESKTOP_LABEL)).toBeInTheDocument()
    // 「未安装 / 未检测到」是 claude_desktop 行独有的状态文案,用它定位本行(其它产品行文案不同)。
    const status = screen.getByText('未安装 / 未检测到')
    const row = status.parentElement!.parentElement!
    // 接管按钮禁用:接管不存在的东西没意义。
    expect(within(row).getByRole('button', { name: '接管' })).toBeDisabled()
  })

  // Claude 桌面端无官方 Linux 版 → 非 mac/win 平台不显示该入口。
  it('Linux 上不显示(无官方桌面端)', () => {
    setPlatform('Linux x86_64')
    render(<TokenSourceControl />)
    expect(screen.queryByText(DESKTOP_LABEL)).toBeNull()
  })

  it('一键体检检出 cc-switch:免责窗需勾选才能清理,勾选后调用清理', async () => {
    setPlatform('MacIntel')
    apiMocks.detectCompetingClaudeConfig.mockResolvedValue([
      { id: 'cc-switch', kind: 'cc-switch', scope: 'user', location: '/home/x/.cc-switch', detail: 'cc-switch（第三方账号切换工具）', severity: 'blocking' },
    ])
    apiMocks.sanitizeCompetingClaudeConfig.mockResolvedValue({ cleaned: ['cc-switch'], skipped: [], backupTo: '/home/x/.bcai/sanitize-backup', needsUac: false })

    render(<TokenSourceControl />)
    fireEvent.click(screen.getByRole('button', { name: '一键体检' }))

    // cc-switch 被点名 + 「清理」按钮初始禁用(未勾选「我已知晓」)
    const cleanBtn = await screen.findByRole('button', { name: '已知晓，清理并接管' })
    expect(cleanBtn).toBeDisabled()

    fireEvent.click(screen.getByRole('checkbox'))
    expect(cleanBtn).not.toBeDisabled()
    fireEvent.click(cleanBtn)

    await waitFor(() => expect(apiMocks.sanitizeCompetingClaudeConfig).toHaveBeenCalledWith([]))
  })

  it('一键体检无冲突:提示环境干净,不触发清理', async () => {
    setPlatform('MacIntel')
    apiMocks.detectCompetingClaudeConfig.mockResolvedValue([])

    render(<TokenSourceControl />)
    fireEvent.click(screen.getByRole('button', { name: '一键体检' }))

    expect(await screen.findByText('未检测到第三方中转配置，环境是干净的。')).toBeInTheDocument()
    expect(apiMocks.sanitizeCompetingClaudeConfig).not.toHaveBeenCalled()
  })

  it('Store 版 Claude Desktop 弹窗确认后打开官方独立版 exe 下载地址', async () => {
    setPlatform('Win32')
    apiMocks.injectSelected.mockResolvedValue('STORE_CLAUDE:检测到 Microsoft Store 版 Claude Desktop')
    apiMocks.installStandaloneClaude.mockResolvedValue(undefined)

    render(<TokenSourceControl />)

    const desktopRow = screen.getByText(DESKTOP_LABEL).closest('.flex.items-center.justify-between')
    if (!(desktopRow instanceof HTMLElement)) {
      throw new Error('desktop row not found')
    }
    fireEvent.click(within(desktopRow).getByRole('button', { name: '接管' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认' }))
    fireEvent.click(await screen.findByRole('button', { name: '下载独立版' }))

    await waitFor(() => {
      expect(apiMocks.openURL).toHaveBeenCalledWith('https://claude.ai/api/desktop/win32/x64/exe/latest/redirect')
    })
    expect(apiMocks.installStandaloneClaude).not.toHaveBeenCalled()
  })
})
