import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { LocalSessionsTab } from './LocalSessionsTab'
import type { SessionRecord, TrashedSessionRecord, HistoryVisibilitySummary } from '@/services/localApi'

function fakeSession(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: 's1',
    title: '会话一',
    cwd: '/tmp/proj',
    updatedAt: null,
    locationCount: 1,
    locations: null,
    ...over,
  }
}

function fakeTrashed(over: Partial<TrashedSessionRecord> = {}): TrashedSessionRecord {
  return {
    sessionId: 't1',
    title: '废弃会话',
    cwd: '/tmp/proj',
    deletedAt: null,
    locationCount: 1,
    locations: null,
    ...over,
  }
}

function fakeSummary(over: Partial<HistoryVisibilitySummary> = {}): HistoryVisibilitySummary {
  return {
    targetProvider: 'openai',
    changedRolloutFiles: 2,
    updatedSqliteRows: 3,
    skippedSqlite: false,
    ...over,
  }
}

function installApp(over: Record<string, (...a: unknown[]) => Promise<unknown>> = {}) {
  const base = {
    LocalListCodexSessions: vi.fn().mockResolvedValue([fakeSession({ sessionId: 's1' }), fakeSession({ sessionId: 's2', title: '会话二' })]),
    LocalCodexSessionTokenStats: vi.fn().mockResolvedValue([]),
    LocalMoveCodexSessionsToTrash: vi.fn().mockResolvedValue({}),
    LocalListTrashedCodexSessions: vi.fn().mockResolvedValue([fakeTrashed()]),
    LocalRestoreCodexSessionsFromTrash: vi.fn().mockResolvedValue({}),
    LocalRepairCodexSessionVisibility: vi.fn().mockResolvedValue(fakeSummary()),
    ...over,
  }
  ;(window as unknown as { go: { main: { App: typeof base } } }).go = { main: { App: base } }
  return base
}

describe('LocalSessionsTab', () => {
  beforeEach(() => {
    installApp()
  })

  it('全选勾选当前视图全部会话,再点一次全部取消', async () => {
    installApp()
    render(<LocalSessionsTab />)
    const checkboxes = await screen.findAllByRole('checkbox')
    expect(checkboxes).toHaveLength(2)
    checkboxes.forEach((cb) => expect(cb).not.toBeChecked())

    fireEvent.click(screen.getByRole('button', { name: '全选' }))
    checkboxes.forEach((cb) => expect(cb).toBeChecked())

    fireEvent.click(screen.getByRole('button', { name: '全选' }))
    checkboxes.forEach((cb) => expect(cb).not.toBeChecked())
  })

  it('刷新重新拉取当前视图(活动会话)', async () => {
    const app = installApp()
    render(<LocalSessionsTab />)
    await screen.findAllByRole('checkbox')
    expect(app.LocalListCodexSessions).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(app.LocalListCodexSessions).toHaveBeenCalledTimes(2))
  })

  it('刷新在废纸篓视图下重新拉取废纸篓列表', async () => {
    const app = installApp()
    render(<LocalSessionsTab />)
    await screen.findAllByRole('checkbox')
    fireEvent.click(screen.getByRole('button', { name: '废纸篓' }))
    await waitFor(() => expect(app.LocalListTrashedCodexSessions).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(app.LocalListTrashedCodexSessions).toHaveBeenCalledTimes(2))
  })

  it('修复可见性调用后端并展示修复摘要', async () => {
    const app = installApp({ LocalRepairCodexSessionVisibility: vi.fn().mockResolvedValue(fakeSummary({ changedRolloutFiles: 5, updatedSqliteRows: 7 })) })
    render(<LocalSessionsTab />)
    await screen.findAllByRole('checkbox')

    fireEvent.click(screen.getByRole('button', { name: '修复可见性' }))
    await waitFor(() => expect(app.LocalRepairCodexSessionVisibility).toHaveBeenCalled())
    expect(await screen.findByText(/5/)).toBeInTheDocument()
    expect(screen.getByText(/7/)).toBeInTheDocument()
  })

  it('修复可见性失败时显示错误条', async () => {
    installApp({ LocalRepairCodexSessionVisibility: vi.fn().mockRejectedValue(new Error('repair-boom')) })
    render(<LocalSessionsTab />)
    await screen.findAllByRole('checkbox')

    fireEvent.click(screen.getByRole('button', { name: '修复可见性' }))
    expect(await screen.findByText(/repair-boom/)).toBeInTheDocument()
  })
})
