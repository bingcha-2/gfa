import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 隔离 wails 运行时:组件 `import * as api`,渲染期不会调用(仅点击 handler 才调),
// mock 掉避免引入 window.go 运行时依赖。
vi.mock('@/services/wails', () => ({
  injectSelected: vi.fn(),
  restoreSelected: vi.fn(),
  openSystemPermissionSettings: vi.fn(),
}))

// zustand store 以 selector 形式读取;mock 成"对给定 state 跑 selector"。
// 用 vi.hoisted 让 mock 工厂(被提升到 import 之上)能拿到这份可变 state。
const { store } = vi.hoisted(() => ({
  store: {
    state: {
      config: { accountCard: 'CARD-XYZ' },
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

  // detected 仍是真正的开关:没检测到桌面端就不显示(平台无关)。
  it('未检测到 Claude Desktop 时不显示', () => {
    setPlatform('Win32')
    store.state.ideProducts = [
      { id: 'claude_desktop', name: DESKTOP_LABEL, detected: false, injected: false },
    ]
    render(<TokenSourceControl />)
    expect(screen.queryByText(DESKTOP_LABEL)).toBeNull()
  })
})
