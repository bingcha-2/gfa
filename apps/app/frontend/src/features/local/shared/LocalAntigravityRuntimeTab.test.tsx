import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocalAntigravityRuntimeTab } from './LocalAntigravityRuntimeTab'

function installApp(over: Record<string, unknown> = {}) {
  const base = {
    LocalAntigravityApps: vi.fn().mockResolvedValue([
      { variant: 'ide', name: 'Antigravity IDE', detected: true, running: true },
      { variant: 'standalone', name: 'Antigravity', detected: true, running: false },
    ]),
    LocalAntigravitySwitchHistory: vi.fn().mockResolvedValue([
      { id: 'h1', timestamp: 1_700_000_000_000, targetEmail: 'switched@gmail.com', accountId: 'a1', success: true },
    ]),
    LocalAntigravityAppStart: vi.fn().mockResolvedValue(undefined),
    LocalAntigravityAppStop: vi.fn().mockResolvedValue(undefined),
    LocalAntigravityAppRestart: vi.fn().mockResolvedValue(undefined),
    LocalAntigravityAppFocus: vi.fn().mockResolvedValue(undefined),
    LocalGetAntigravityTarget: vi.fn().mockResolvedValue('ide'),
    LocalSetAntigravityTarget: vi.fn().mockResolvedValue(undefined),
    LocalClearAntigravitySwitchHistory: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
  ;(window as unknown as { go: { main: { App: typeof base } } }).go = { main: { App: base } }
  return base
}

describe('LocalAntigravityRuntimeTab —— 双 app 运行时 + 切换历史', () => {
  beforeEach(() => {
    ;(window as unknown as { go?: unknown }).go = undefined
  })

  it('同时渲染 Antigravity IDE 与独立版 Antigravity 两张卡', async () => {
    const app = installApp()
    render(<LocalAntigravityRuntimeTab />)
    await waitFor(() => expect(app.LocalAntigravityApps).toHaveBeenCalled())
    expect(await screen.findByText('Antigravity IDE')).toBeInTheDocument()
    expect(await screen.findByText('Antigravity')).toBeInTheDocument()
    // 切换历史目标号也在。
    expect(await screen.findByText('switched@gmail.com')).toBeInTheDocument()
  })

  it('对独立版点启动,透传 variant=standalone', async () => {
    const app = installApp()
    render(<LocalAntigravityRuntimeTab />)
    await screen.findByText('Antigravity')
    // 独立版卡在第二张;两张卡各有「启动」,取第二个。
    const starts = await screen.findAllByRole('button', { name: /启动/ })
    fireEvent.click(starts[1])
    await waitFor(() => expect(app.LocalAntigravityAppStart).toHaveBeenCalledWith('standalone'))
  })

  it('未安装的 app 其控制按钮禁用', async () => {
    const app = installApp({
      LocalAntigravityApps: vi.fn().mockResolvedValue([
        { variant: 'ide', name: 'Antigravity IDE', detected: true, running: false },
        { variant: 'standalone', name: 'Antigravity', detected: false, running: false },
      ]),
    })
    render(<LocalAntigravityRuntimeTab />)
    await waitFor(() => expect(app.LocalAntigravityApps).toHaveBeenCalled())
    await screen.findByText('未安装')
    const starts = await screen.findAllByRole('button', { name: /启动/ })
    expect(starts[1]).toBeDisabled() // standalone 未安装 → 禁用
  })

  it('切注入目标到独立版调 setAntigravityTarget(standalone)', async () => {
    const app = installApp()
    render(<LocalAntigravityRuntimeTab />)
    await waitFor(() => expect(app.LocalGetAntigravityTarget).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: '独立版' }))
    await waitFor(() => expect(app.LocalSetAntigravityTarget).toHaveBeenCalledWith('standalone'))
  })

  it('清空历史调 clearAntigravitySwitchHistory', async () => {
    const app = installApp()
    render(<LocalAntigravityRuntimeTab />)
    await screen.findByText('switched@gmail.com')
    fireEvent.click(screen.getByRole('button', { name: '清空历史' }))
    await waitFor(() => expect(app.LocalClearAntigravitySwitchHistory).toHaveBeenCalled())
  })
})
