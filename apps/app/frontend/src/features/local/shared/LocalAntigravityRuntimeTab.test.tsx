import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocalAntigravityRuntimeTab } from './LocalAntigravityRuntimeTab'

function installApp(over: Record<string, unknown> = {}) {
  const base = {
    LocalAntigravityRuntimeStatus: vi.fn().mockResolvedValue(true),
    LocalAntigravitySwitchHistory: vi.fn().mockResolvedValue([
      { id: 'h1', timestamp: 1_700_000_000_000, targetEmail: 'switched@gmail.com', accountId: 'a1', success: true },
    ]),
    LocalAntigravityStartDefault: vi.fn().mockResolvedValue(undefined),
    LocalAntigravityStopDefault: vi.fn().mockResolvedValue(undefined),
    LocalAntigravityRestartDefault: vi.fn().mockResolvedValue(undefined),
    LocalAntigravityFocusDefault: vi.fn().mockResolvedValue(undefined),
    LocalClearAntigravitySwitchHistory: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
  ;(window as unknown as { go: { main: { App: typeof base } } }).go = { main: { App: base } }
  return base
}

describe('LocalAntigravityRuntimeTab —— 默认实例运行时 + 切换历史', () => {
  beforeEach(() => {
    ;(window as unknown as { go?: unknown }).go = undefined
  })

  it('挂载即读运行时状态与切换历史,并渲染目标号', async () => {
    const app = installApp()
    render(<LocalAntigravityRuntimeTab />)
    await waitFor(() => expect(app.LocalAntigravityRuntimeStatus).toHaveBeenCalled())
    expect(app.LocalAntigravitySwitchHistory).toHaveBeenCalled()
    expect(await screen.findByText('运行中')).toBeInTheDocument()
    expect(await screen.findByText('switched@gmail.com')).toBeInTheDocument()
  })

  it('启/停/重启/聚焦分别调对应绑定', async () => {
    const app = installApp()
    render(<LocalAntigravityRuntimeTab />)
    await screen.findByText('默认实例运行时')
    fireEvent.click(screen.getByRole('button', { name: '启动' }))
    await waitFor(() => expect(app.LocalAntigravityStartDefault).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    await waitFor(() => expect(app.LocalAntigravityStopDefault).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: '重启' }))
    await waitFor(() => expect(app.LocalAntigravityRestartDefault).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: '聚焦窗口' }))
    await waitFor(() => expect(app.LocalAntigravityFocusDefault).toHaveBeenCalled())
  })

  it('清空历史调 clearAntigravitySwitchHistory', async () => {
    const app = installApp()
    render(<LocalAntigravityRuntimeTab />)
    await screen.findByText('switched@gmail.com')
    fireEvent.click(screen.getByRole('button', { name: '清空历史' }))
    await waitFor(() => expect(app.LocalClearAntigravitySwitchHistory).toHaveBeenCalled())
  })
})
