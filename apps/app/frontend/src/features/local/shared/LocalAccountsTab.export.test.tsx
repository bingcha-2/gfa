import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { LocalAccountsTab } from './LocalAccountsTab'
import { codexLocalApi, type LocalAccountView } from '@/services/localApi'

function fakeAccount(over: Partial<LocalAccountView> = {}): LocalAccountView {
  return {
    id: 'a1', email: 'a@x.com', name: '', provider: 'codex', authKind: 'oauth', note: '', planType: 'pro',
    quotaStatus: 'ok', tags: null, poolEnabled: true, priority: false,
    hourlyPercent: 50, weeklyPercent: 50, hourlyResetAt: 0, weeklyResetAt: 0, lastUsedAt: 0, ...over,
  }
}

function installApp(over: Record<string, (...a: unknown[]) => Promise<unknown>> = {}) {
  const base = {
    LocalListCodexAccounts: vi.fn().mockResolvedValue([fakeAccount()]),
    LocalExportCodexAccountsToFile: vi.fn().mockResolvedValue('/Users/me/codex-accounts.json'),
    LocalExportCodexAccounts: vi.fn().mockResolvedValue('[]'),
    ...over,
  }
  ;(window as unknown as { go: { main: { App: typeof base } } }).go = { main: { App: base } }
  return base
}

describe('LocalAccountsTab 导出', () => {
  beforeEach(() => { vi.clearAllMocks() })

  // 回归守门:导出必须走后端原生保存(Wails WebView 里 blob 下载不生效,点了没反应)。
  it('点导出 → 调 LocalExportCodexAccountsToFile 并提示保存路径', async () => {
    const app = installApp()
    render(<LocalAccountsTab title="Codex" api={codexLocalApi} />)
    fireEvent.click(await screen.findByRole('button', { name: '号池更多操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '导出账号' }))

    await waitFor(() => expect(app.LocalExportCodexAccountsToFile).toHaveBeenCalledWith([]))
    // 绝不能再用旧的「返回 JSON 字符串给前端自己下载」那条路。
    expect(app.LocalExportCodexAccounts).not.toHaveBeenCalled()
    expect(await screen.findByText(/已导出.*codex-accounts\.json/)).toBeTruthy()
  })

  // 用户在原生保存框点取消 → 后端返回空串 → 不该弹「已导出」。
  it('用户取消保存 → 不提示已导出', async () => {
    const app = installApp({ LocalExportCodexAccountsToFile: vi.fn().mockResolvedValue('') })
    render(<LocalAccountsTab title="Codex" api={codexLocalApi} />)
    fireEvent.click(await screen.findByRole('button', { name: '号池更多操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '导出账号' }))

    await waitFor(() => expect(app.LocalExportCodexAccountsToFile).toHaveBeenCalled())
    expect(screen.queryByText(/已导出/)).toBeNull()
  })
})
