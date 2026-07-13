import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { LocalGatewayTab } from './LocalGatewayTab'
import { codexLocalApi, type GatewayOpsConfig, type ImageGenMode } from '@/services/localApi'

function fakeOps(mode: ImageGenMode): GatewayOpsConfig {
  return { timeouts: { streamKeepaliveSeconds: 0, streamBootstrapRetries: 0, maxRetryCredentials: 0, maxRetryIntervalSeconds: 0 }, timeoutPresets: [], activePresetId: '', upstreamProxyUrl: '', imageGenerationMode: mode }
}

function installApp(over: Record<string, (...a: unknown[]) => Promise<unknown>> = {}) {
  const save = vi.fn().mockImplementation((m: ImageGenMode) => Promise.resolve(fakeOps(m)))
  const base = {
    LocalGetRoutingStrategy: vi.fn().mockResolvedValue('priority'),
    LocalGetGatewayAccessScope: vi.fn().mockResolvedValue('local'),
    LocalListGatewayKeys: vi.fn().mockResolvedValue([]),
    LocalGetGatewayOpsConfig: vi.fn().mockResolvedValue(fakeOps('on')),
    LocalSaveGatewayImageGenMode: save,
    LocalGatewayStatus: vi.fn().mockResolvedValue({ running: false, addr: '', port: 0 }),
    LocalListCodexAccounts: vi.fn().mockResolvedValue([]),
    LocalQueryGatewayLogs: vi.fn().mockResolvedValue({ entries: [], total: 0 }),
    ...over,
  }
  ;(window as unknown as { go: { main: { App: typeof base } } }).go = { main: { App: base } }
  return base
}

describe('LocalGatewayTab 生图注入开关', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('渲染三态并高亮当前模式(on)', async () => {
    installApp()
    render(<LocalGatewayTab api={codexLocalApi} />)
    await waitFor(() => expect(screen.getByRole('group', { name: '生图注入模式' })).toBeTruthy())
    expect(screen.getByRole('button', { name: '开(全部)' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '关' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('点击「关」调用 LocalSaveGatewayImageGenMode("off") 并切换高亮', async () => {
    const app = installApp()
    render(<LocalGatewayTab api={codexLocalApi} />)
    await waitFor(() => expect(screen.getByRole('group', { name: '生图注入模式' })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: '关' }))
    await waitFor(() => expect(app.LocalSaveGatewayImageGenMode).toHaveBeenCalledWith('off'))
    await waitFor(() => expect(screen.getByRole('button', { name: '关' }).getAttribute('aria-pressed')).toBe('true'))
  })

  it('点击「仅图像接口」传 images-only', async () => {
    const app = installApp()
    render(<LocalGatewayTab api={codexLocalApi} />)
    await waitFor(() => expect(screen.getByRole('group', { name: '生图注入模式' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '仅图像接口' }))
    await waitFor(() => expect(app.LocalSaveGatewayImageGenMode).toHaveBeenCalledWith('images-only'))
  })
})
