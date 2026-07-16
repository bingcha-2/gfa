import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { LocalSettingsTab } from './LocalSettingsTab'
import type { CodexSettings, CodexQuickConfig, CodexSkinChannelStatus } from '@/services/localApi'

function fakeSettings(over: Partial<CodexSettings> = {}): CodexSettings {
  return {
    codexAppPath: '',
    launchOnSwitch: false,
    restartAppOnSwitch: false,
    restartAppPath: '',
    showApiEntry: true,
    filterMemory: false,
    showCodeReviewQuota: false,
    skinChannelEnabled: false,
    ...over,
  }
}

function fakeSkin(over: Partial<CodexSkinChannelStatus> = {}): CodexSkinChannelStatus {
  return {
    enabled: false,
    live: false,
    port: 9335,
    skillDir: '/home/u/.bingchaai/codex-skin/skill',
    ...over,
  }
}

function fakeQuick(over: Partial<CodexQuickConfig> = {}): CodexQuickConfig {
  return {
    contextWindow1m: false,
    autoCompactTokenLimit: 0,
    ...over,
  }
}

function installApp(over: Record<string, (...a: unknown[]) => Promise<unknown>> = {}) {
  const base = {
    LocalGetCodexSettings: vi.fn().mockResolvedValue(fakeSettings()),
    LocalSaveCodexSettings: vi.fn().mockImplementation((s: CodexSettings) => Promise.resolve(s)),
    LocalGetCodexQuickConfig: vi.fn().mockResolvedValue(
      fakeQuick({ detectedModelContextWindow: 1000000, detectedAutoCompactTokenLimit: 900000 }),
    ),
    LocalSaveCodexQuickConfig: vi.fn().mockImplementation(
      (mcw: number | null, ac: number | null) =>
        Promise.resolve(fakeQuick({ detectedModelContextWindow: mcw ?? undefined, detectedAutoCompactTokenLimit: ac ?? undefined })),
    ),
    LocalBrowseForPath: vi.fn().mockResolvedValue('/Applications/Codex.app'),
    LocalDetectCodexAppPath: vi.fn().mockResolvedValue('/Applications/Codex.app'),
    LocalOpenCodexConfigToml: vi.fn().mockResolvedValue(undefined),
    LocalGetCodexSkinChannel: vi.fn().mockResolvedValue(fakeSkin()),
    LocalSetCodexSkinChannel: vi.fn().mockImplementation(
      (enabled: boolean) => Promise.resolve(fakeSkin({ enabled })),
    ),
    LocalRestartCodexForSkinChannel: vi.fn().mockResolvedValue(fakeSkin({ enabled: true, live: true })),
    LocalOpenCodexSkinSkillFolder: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
  ;(window as unknown as { go: { main: { App: typeof base } } }).go = { main: { App: base } }
  return base
}

function renderTab(onNavigate = vi.fn()) {
  render(<LocalSettingsTab onNavigate={onNavigate} />)
  return onNavigate
}

describe('LocalSettingsTab', () => {
  beforeEach(() => {
    installApp()
  })

  it('loads settings + quick config on mount', async () => {
    const app = installApp()
    renderTab()
    await waitFor(() => expect(app.LocalGetCodexSettings).toHaveBeenCalled())
    await waitFor(() => expect(app.LocalGetCodexQuickConfig).toHaveBeenCalled())
  })

  it('显示 API 服务入口开关读取当前值,切换调 saveCodexSettings(showApiEntry)', async () => {
    const app = installApp({ LocalGetCodexSettings: vi.fn().mockResolvedValue(fakeSettings({ showApiEntry: true })) })
    renderTab()
    const sw = await screen.findByRole('switch', { name: /显示 API 服务入口/ })
    expect(sw).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(sw)
    await waitFor(() =>
      expect(app.LocalSaveCodexSettings).toHaveBeenCalledWith(expect.objectContaining({ showApiEntry: false })),
    )
  })

  it('筛选记忆开关读取当前值,切换调 saveCodexSettings(filterMemory)', async () => {
    const app = installApp({ LocalGetCodexSettings: vi.fn().mockResolvedValue(fakeSettings({ filterMemory: false })) })
    renderTab()
    const sw = await screen.findByRole('switch', { name: /筛选记忆/ })
    expect(sw).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(sw)
    await waitFor(() =>
      expect(app.LocalSaveCodexSettings).toHaveBeenCalledWith(expect.objectContaining({ filterMemory: true })),
    )
  })

  it('显示 Code Review 配额开关读取当前值,切换调 saveCodexSettings(showCodeReviewQuota)', async () => {
    const app = installApp()
    renderTab()
    const sw = await screen.findByRole('switch', { name: /Code Review 配额/ })
    fireEvent.click(sw)
    await waitFor(() =>
      expect(app.LocalSaveCodexSettings).toHaveBeenCalledWith(expect.objectContaining({ showCodeReviewQuota: true })),
    )
  })

  it('切换时自动启动 Codex App 开关调 saveCodexSettings(launchOnSwitch)', async () => {
    const app = installApp()
    renderTab()
    const sw = await screen.findByRole('switch', { name: /切换时自动启动 Codex App/ })
    fireEvent.click(sw)
    await waitFor(() =>
      expect(app.LocalSaveCodexSettings).toHaveBeenCalledWith(expect.objectContaining({ launchOnSwitch: true })),
    )
  })

  it('切换时重启指定应用开关调 saveCodexSettings(restartAppOnSwitch)', async () => {
    const app = installApp()
    renderTab()
    const sw = await screen.findByRole('switch', { name: /切换时重启指定应用/ })
    fireEvent.click(sw)
    await waitFor(() =>
      expect(app.LocalSaveCodexSettings).toHaveBeenCalledWith(expect.objectContaining({ restartAppOnSwitch: true })),
    )
  })

  it('Codex app 路径输入读取当前值,编辑后失焦调 saveCodexSettings(codexAppPath)', async () => {
    const app = installApp({ LocalGetCodexSettings: vi.fn().mockResolvedValue(fakeSettings({ codexAppPath: '/old/Codex.app' })) })
    renderTab()
    const input = await screen.findByLabelText('Codex app 路径') as HTMLInputElement
    expect(input.value).toBe('/old/Codex.app')
    fireEvent.change(input, { target: { value: '/new/Codex.app' } })
    fireEvent.blur(input)
    await waitFor(() =>
      expect(app.LocalSaveCodexSettings).toHaveBeenCalledWith(expect.objectContaining({ codexAppPath: '/new/Codex.app' })),
    )
  })

  it('Codex app 路径「选择」调 browseForPath 并保存回填', async () => {
    const app = installApp()
    renderTab()
    await screen.findByLabelText('Codex app 路径')
    fireEvent.click(screen.getByRole('button', { name: '选择 Codex app 路径' }))
    await waitFor(() => expect(app.LocalBrowseForPath).toHaveBeenCalled())
    await waitFor(() =>
      expect(app.LocalSaveCodexSettings).toHaveBeenCalledWith(expect.objectContaining({ codexAppPath: '/Applications/Codex.app' })),
    )
  })

  it('Codex app 路径「检测」调 detectCodexAppPath 并保存回填', async () => {
    const app = installApp({ LocalDetectCodexAppPath: vi.fn().mockResolvedValue('/Applications/Detected.app') })
    renderTab()
    await screen.findByLabelText('Codex app 路径')
    fireEvent.click(screen.getByRole('button', { name: '检测 Codex app 路径' }))
    await waitFor(() => expect(app.LocalDetectCodexAppPath).toHaveBeenCalled())
    await waitFor(() =>
      expect(app.LocalSaveCodexSettings).toHaveBeenCalledWith(expect.objectContaining({ codexAppPath: '/Applications/Detected.app' })),
    )
  })

  it('「打开 config.toml」按钮调 openCodexConfigToml', async () => {
    const app = installApp()
    renderTab()
    await screen.findByLabelText('Codex app 路径')
    fireEvent.click(screen.getByRole('button', { name: /打开 config.toml/ }))
    await waitFor(() => expect(app.LocalOpenCodexConfigToml).toHaveBeenCalled())
  })

  it('配额刷新间隔为只读跳转,点击调 onNavigate(去保活 tab)', async () => {
    const onNav = vi.fn()
    installApp()
    renderTab(onNav)
    await screen.findByLabelText('Codex app 路径')
    fireEvent.click(screen.getByRole('button', { name: /去保活设置/ }))
    expect(onNav).toHaveBeenCalledWith('wakeup')
  })

  // ── 上下文与压缩阈值预设 ──

  it('上下文预设根据 detected 值高亮 1M(detected=1000000/900000)', async () => {
    installApp()
    renderTab()
    const oneM = await screen.findByRole('button', { name: '1M' })
    expect(oneM).toHaveAttribute('aria-pressed', 'true')
  })

  it('选「默认」预设调 saveCodexQuickConfig(null,null) 删两个键', async () => {
    const app = installApp()
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '默认' }))
    await waitFor(() => expect(app.LocalSaveCodexQuickConfig).toHaveBeenCalledWith(null, null))
  })

  it('选「516K」预设调 saveCodexQuickConfig(516000,460000)', async () => {
    const app = installApp()
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '516K' }))
    await waitFor(() => expect(app.LocalSaveCodexQuickConfig).toHaveBeenCalledWith(516000, 460000))
  })

  it('选「自定义」后两个数字输入可填,保存调 saveCodexQuickConfig(自定义值)', async () => {
    const app = installApp()
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '自定义' }))
    fireEvent.change(await screen.findByLabelText('上下文窗口'), { target: { value: '700000' } })
    fireEvent.change(screen.getByLabelText('压缩阈值'), { target: { value: '640000' } })
    fireEvent.click(screen.getByRole('button', { name: '保存阈值' }))
    await waitFor(() => expect(app.LocalSaveCodexQuickConfig).toHaveBeenCalledWith(700000, 640000))
  })

  it('错误吞掉不崩:加载失败显示错误条', async () => {
    installApp({ LocalGetCodexSettings: vi.fn().mockRejectedValue(new Error('boom')) })
    renderTab()
    expect(await screen.findByText(/boom/)).toBeInTheDocument()
  })

  // ── Codex 皮肤调试通道 ──

  it('皮肤通道开关读取当前值,切换调 setCodexSkinChannel', async () => {
    const app = installApp()
    renderTab()
    const sw = await screen.findByRole('switch', { name: /皮肤调试通道/ })
    expect(sw).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(sw)
    await waitFor(() => expect(app.LocalSetCodexSkinChannel).toHaveBeenCalledWith(true))
  })

  it('开+死 = 等待重启:显示「重启 Codex 生效」并调 restartCodexForSkinChannel', async () => {
    const app = installApp({
      LocalGetCodexSkinChannel: vi.fn().mockResolvedValue(fakeSkin({ enabled: true, live: false })),
    })
    renderTab()
    const btn = await screen.findByRole('button', { name: /重启 Codex 生效/ })
    fireEvent.click(btn)
    await waitFor(() => expect(app.LocalRestartCodexForSkinChannel).toHaveBeenCalled())
    // 重启返回 live=true 后状态行进入「通道已开启」。
    expect(await screen.findByText(/通道已开启/)).toBeInTheDocument()
  })

  it('开+活 = 通道已开启:无重启按钮', async () => {
    installApp({
      LocalGetCodexSkinChannel: vi.fn().mockResolvedValue(fakeSkin({ enabled: true, live: true })),
    })
    renderTab()
    expect(await screen.findByText(/通道已开启/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /重启 Codex 生效/ })).toBeNull()
  })

  it('关+活 = 残留通道:提示重启后关闭并给「重启关闭」按钮', async () => {
    installApp({
      LocalGetCodexSkinChannel: vi.fn().mockResolvedValue(fakeSkin({ enabled: false, live: true })),
    })
    renderTab()
    expect(await screen.findByText(/仍带调试端口运行/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /重启关闭/ })).toBeInTheDocument()
  })

  it('等待重启时自动轮询,Codex 慢启动完成后状态自动翻绿', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(fakeSkin({ enabled: true, live: false }))
      .mockResolvedValue(fakeSkin({ enabled: true, live: true }))
    installApp({ LocalGetCodexSkinChannel: get })
    renderTab()
    expect(await screen.findByText(/等待重启/)).toBeInTheDocument()
    // 3s 轮询命中第二次 mock(live=true)后,无需任何操作状态翻转。
    expect(await screen.findByText(/通道已开启/, undefined, { timeout: 4500 })).toBeInTheDocument()
    expect(get.mock.calls.length).toBeGreaterThanOrEqual(2)
  }, 8000)

  it('skill 路径常驻可见(与通道状态无关),「打开文件夹」调 openCodexSkinSkillFolder', async () => {
    const app = installApp()
    renderTab()
    expect(await screen.findByText('/home/u/.bingchaai/codex-skin/skill')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /打开文件夹/ }))
    await waitFor(() => expect(app.LocalOpenCodexSkinSkillFolder).toHaveBeenCalled())
  })

  it('不渲染 OpenClaw / OpenCode 覆盖开关(明确不做)', async () => {
    installApp()
    renderTab()
    await screen.findByLabelText('Codex app 路径')
    expect(screen.queryByText(/OpenClaw/i)).toBeNull()
    expect(screen.queryByText(/OpenCode/i)).toBeNull()
  })
})
