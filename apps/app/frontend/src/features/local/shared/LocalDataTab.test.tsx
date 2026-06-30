import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { LocalDataTab } from './LocalDataTab'
import type { WebDAVConfig, AntigravitySwitchHistoryItem } from '@/services/localApi'

function fakeWebDAV(over: Partial<WebDAVConfig> = {}): WebDAVConfig {
  return { enabled: false, url: '', username: '', password: '', remoteDir: 'bcai-backup', ...over }
}

function fakeHistory(over: Partial<AntigravitySwitchHistoryItem> = {}): AntigravitySwitchHistoryItem {
  return {
    id: 'h1', timestamp: 1700000000000, accountId: 'a1', targetEmail: 'switched@example.com',
    triggerType: 'manual', triggerSource: 'user', localOk: true, seamlessOk: true, success: true,
    localDurationMs: 120, totalDurationMs: 340,
    ...over,
  }
}

function installApp(over: Record<string, (...a: unknown[]) => Promise<unknown>> = {}) {
  const base = {
    // 数据迁移 bundle
    LocalExportDataBundle: vi.fn().mockResolvedValue('{"version":1,"instances":[]}'),
    LocalImportDataBundle: vi.fn().mockResolvedValue(3),
    // WebDAV
    LocalGetWebDAVConfig: vi.fn().mockResolvedValue(fakeWebDAV()),
    LocalSetWebDAVConfig: vi.fn().mockImplementation((c: WebDAVConfig) => Promise.resolve(c)),
    LocalWebDAVUploadBackup: vi.fn().mockResolvedValue(undefined),
    LocalWebDAVDownloadBackup: vi.fn().mockResolvedValue(2),
    // antigravity runtime + history
    LocalAntigravityRuntimeStatus: vi.fn().mockResolvedValue(true),
    LocalAntigravityStartDefault: vi.fn().mockResolvedValue(undefined),
    LocalAntigravityStopDefault: vi.fn().mockResolvedValue(undefined),
    LocalAntigravityRestartDefault: vi.fn().mockResolvedValue(undefined),
    LocalAntigravityFocusDefault: vi.fn().mockResolvedValue(undefined),
    LocalAntigravitySwitchHistory: vi.fn().mockResolvedValue([fakeHistory()]),
    LocalClearAntigravitySwitchHistory: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
  ;(window as unknown as { go: { main: { App: typeof base } } }).go = { main: { App: base } }
  return base
}

describe('LocalDataTab — 数据迁移 + WebDAV(codex/antigravity 共用)', () => {
  beforeEach(() => {
    installApp()
  })

  it('挂载即读取 WebDAV 配置', async () => {
    const app = installApp()
    render(<LocalDataTab />)
    await waitFor(() => expect(app.LocalGetWebDAVConfig).toHaveBeenCalled())
  })

  it('导出 bundle 调 exportDataBundle 并展示导出文本可复制', async () => {
    const app = installApp()
    render(<LocalDataTab />)
    fireEvent.click(await screen.findByRole('button', { name: /导出/ }))
    await waitFor(() => expect(app.LocalExportDataBundle).toHaveBeenCalled())
    const ta = await screen.findByLabelText('导出的数据') as HTMLTextAreaElement
    expect(ta.value).toContain('"version":1')
  })

  it('粘贴 bundle 文本导入调 importDataBundle 并显示导入实例数', async () => {
    const app = installApp()
    render(<LocalDataTab />)
    const ta = await screen.findByLabelText('待导入的数据')
    fireEvent.change(ta, { target: { value: '{"version":1,"instances":[1,2,3]}' } })
    fireEvent.click(screen.getByRole('button', { name: /^导入$/ }))
    await waitFor(() => expect(app.LocalImportDataBundle).toHaveBeenCalledWith('{"version":1,"instances":[1,2,3]}'))
    expect(await screen.findByText(/导入了 3 个实例/)).toBeInTheDocument()
  })

  it('WebDAV 表单读取当前值,启用开关切换并保存调 setWebDAVConfig', async () => {
    const app = installApp({
      LocalGetWebDAVConfig: vi.fn().mockResolvedValue(fakeWebDAV({ url: 'https://dav.x.com', username: 'u' })),
    })
    render(<LocalDataTab />)
    const urlInput = await screen.findByLabelText('WebDAV 地址') as HTMLInputElement
    expect(urlInput.value).toBe('https://dav.x.com')
    const sw = screen.getByRole('switch', { name: /启用 WebDAV/ })
    expect(sw).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(sw)
    fireEvent.click(screen.getByRole('button', { name: '保存 WebDAV' }))
    await waitFor(() => expect(app.LocalSetWebDAVConfig).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, url: 'https://dav.x.com', username: 'u' }),
    ))
  })

  it('WebDAV 密码输入掩码(type=password)', async () => {
    installApp()
    render(<LocalDataTab />)
    const pw = await screen.findByLabelText('WebDAV 密码') as HTMLInputElement
    expect(pw.type).toBe('password')
  })

  it('WebDAV 上传调 webdavUploadBackup', async () => {
    const app = installApp()
    render(<LocalDataTab />)
    fireEvent.click(await screen.findByRole('button', { name: /上传备份/ }))
    await waitFor(() => expect(app.LocalWebDAVUploadBackup).toHaveBeenCalled())
  })

  it('WebDAV 下载调 webdavDownloadBackup 并显示恢复实例数', async () => {
    const app = installApp()
    render(<LocalDataTab />)
    fireEvent.click(await screen.findByRole('button', { name: /下载恢复/ }))
    await waitFor(() => expect(app.LocalWebDAVDownloadBackup).toHaveBeenCalled())
    expect(await screen.findByText(/恢复了 2 个实例/)).toBeInTheDocument()
  })

  it('codex 模式(showAntigravity=false)不渲染运行时控制/切换历史', async () => {
    installApp()
    render(<LocalDataTab />)
    await screen.findByLabelText('WebDAV 地址')
    expect(screen.queryByText('默认实例运行时')).toBeNull()
    expect(screen.queryByText('切换历史')).toBeNull()
  })

  it('加载失败显示错误条(吞掉不崩)', async () => {
    installApp({ LocalGetWebDAVConfig: vi.fn().mockRejectedValue(new Error('dav boom')) })
    render(<LocalDataTab />)
    expect(await screen.findByText(/dav boom/)).toBeInTheDocument()
  })
})

describe('LocalDataTab — Antigravity 额外:runtime 控制 + 切换历史 + 版本/状态', () => {
  beforeEach(() => {
    installApp()
  })

  it('showAntigravity 时挂载读取运行时状态与切换历史', async () => {
    const app = installApp()
    render(<LocalDataTab showAntigravity />)
    await waitFor(() => expect(app.LocalAntigravityRuntimeStatus).toHaveBeenCalled())
    await waitFor(() => expect(app.LocalAntigravitySwitchHistory).toHaveBeenCalled())
  })

  it('运行时状态为运行中时显示「运行中」', async () => {
    installApp({ LocalAntigravityRuntimeStatus: vi.fn().mockResolvedValue(true) })
    render(<LocalDataTab showAntigravity />)
    expect(await screen.findByText('运行中')).toBeInTheDocument()
  })

  it('运行时状态为停止时显示「已停止」', async () => {
    installApp({ LocalAntigravityRuntimeStatus: vi.fn().mockResolvedValue(false) })
    render(<LocalDataTab showAntigravity />)
    expect(await screen.findByText('已停止')).toBeInTheDocument()
  })

  it('启动按钮调 antigravityStartDefault 并重读状态', async () => {
    const app = installApp({ LocalAntigravityRuntimeStatus: vi.fn().mockResolvedValue(false) })
    render(<LocalDataTab showAntigravity />)
    await screen.findByText('已停止')
    fireEvent.click(screen.getByRole('button', { name: '启动' }))
    await waitFor(() => expect(app.LocalAntigravityStartDefault).toHaveBeenCalled())
    await waitFor(() => expect(app.LocalAntigravityRuntimeStatus).toHaveBeenCalledTimes(2))
  })

  it('停止按钮调 antigravityStopDefault', async () => {
    const app = installApp({ LocalAntigravityRuntimeStatus: vi.fn().mockResolvedValue(true) })
    render(<LocalDataTab showAntigravity />)
    await screen.findByText('运行中')
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    await waitFor(() => expect(app.LocalAntigravityStopDefault).toHaveBeenCalled())
  })

  it('重启按钮调 antigravityRestartDefault', async () => {
    const app = installApp()
    render(<LocalDataTab showAntigravity />)
    fireEvent.click(await screen.findByRole('button', { name: '重启' }))
    await waitFor(() => expect(app.LocalAntigravityRestartDefault).toHaveBeenCalled())
  })

  it('聚焦按钮调 antigravityFocusDefault', async () => {
    const app = installApp()
    render(<LocalDataTab showAntigravity />)
    fireEvent.click(await screen.findByRole('button', { name: /聚焦/ }))
    await waitFor(() => expect(app.LocalAntigravityFocusDefault).toHaveBeenCalled())
  })

  it('切换历史列表渲染目标邮箱与成功态', async () => {
    installApp()
    render(<LocalDataTab showAntigravity />)
    expect(await screen.findByText('switched@example.com')).toBeInTheDocument()
    expect(screen.getByText('成功')).toBeInTheDocument()
  })

  it('切换历史失败条目显示失败与错误信息', async () => {
    installApp({
      LocalAntigravitySwitchHistory: vi.fn().mockResolvedValue([
        fakeHistory({ id: 'h2', success: false, errorMessage: '注入失败', targetEmail: 'bad@example.com' }),
      ]),
    })
    render(<LocalDataTab showAntigravity />)
    expect(await screen.findByText('bad@example.com')).toBeInTheDocument()
    expect(screen.getByText(/注入失败/)).toBeInTheDocument()
  })

  it('切换历史空态文案', async () => {
    installApp({ LocalAntigravitySwitchHistory: vi.fn().mockResolvedValue([]) })
    render(<LocalDataTab showAntigravity />)
    expect(await screen.findByText(/还没有切换记录/)).toBeInTheDocument()
  })

  it('清空切换历史调 clearAntigravitySwitchHistory 并重读', async () => {
    const app = installApp()
    render(<LocalDataTab showAntigravity />)
    await screen.findByText('switched@example.com')
    expect(app.LocalAntigravitySwitchHistory).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '清空历史' }))
    await waitFor(() => expect(app.LocalClearAntigravitySwitchHistory).toHaveBeenCalled())
    await waitFor(() => expect(app.LocalAntigravitySwitchHistory).toHaveBeenCalledTimes(2))
  })
})
