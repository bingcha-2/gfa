/**
 * 本地接管(自有号)Wails 封装。
 *
 * 这些 App 方法尚未进 wailsjs 生成绑定(需 `wails generate module`),为不依赖
 * 重新生成、又遵守「不让 window.go.* 散落到组件」的约定,集中在此一处封装。
 * 待生成绑定补齐后,可平滑改为从 wailsjs/go/main/App 直接 import。
 */

export interface LocalAccountView {
  id: string
  email: string
  provider: string
  authKind: string
  planType: string
  quotaStatus: string
  tags: string[] | null
  poolEnabled: boolean
  priority: boolean
  hourlyPercent: number
  weeklyPercent: number
  hourlyResetAt: number
  weeklyResetAt: number
  lastUsedAt: number
}

export interface LocalGatewayStatus {
  running: boolean
  addr: string
  port: number
}

export interface CodexStatModel { model: string; requests: number; totalTokens: number }
export interface CodexStatAccount { authId: string; email: string; requests: number; totalTokens: number }
export interface CodexStatRecent { atMs: number; authId: string; model: string; failed: boolean; latencyMs: number }
export interface CodexStatsSnapshot {
  totalRequests: number
  totalFailed: number
  totalInputTokens: number
  totalOutputTokens: number
  byAccount: CodexStatAccount[] | null
  byModel: CodexStatModel[] | null
  recent: CodexStatRecent[] | null
}

type GoApp = Record<string, (...args: unknown[]) => Promise<unknown>>

function app(): GoApp {
  const w = window as unknown as { go?: { main?: { App?: GoApp } } }
  const a = w?.go?.main?.App
  if (!a) throw new Error('Wails App bindings unavailable')
  return a
}

export const localApi = {
  listCodexAccounts: () => app().LocalListCodexAccounts() as Promise<LocalAccountView[]>,
  startCodexLogin: () => app().LocalStartCodexLogin() as Promise<string>,
  waitCodexLogin: (loginId: string) => app().LocalWaitCodexLogin(loginId) as Promise<LocalAccountView>,
  deleteAccount: (id: string) => app().LocalDeleteAccount(id) as Promise<void>,
  setPoolEnabled: (id: string, enabled: boolean) => app().LocalSetPoolEnabled(id, enabled) as Promise<void>,
  setCodexPriority: (id: string) => app().LocalSetCodexPriority(id) as Promise<void>,
  gatewayStart: () => app().LocalGatewayStart() as Promise<LocalGatewayStatus>,
  gatewayStop: () => app().LocalGatewayStop() as Promise<void>,
  gatewayStatus: () => app().LocalGatewayStatus() as Promise<LocalGatewayStatus>,
  getCodexSource: () => app().LocalGetCodexSource() as Promise<string>,
  setCodexSource: (source: 'remote' | 'local') => app().LocalSetCodexSource(source) as Promise<void>,
  codexStats: () => app().LocalCodexStats() as Promise<CodexStatsSnapshot>,
}
