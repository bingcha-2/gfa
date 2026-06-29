/**
 * 本地接管(自有号)Wails 封装。
 *
 * 这些 App 方法尚未进 wailsjs 生成绑定(需 `wails generate module`),为不依赖
 * 重新生成、又遵守「不让 window.go.* 散落到组件」的约定,集中在此一处封装。
 *
 * 多 provider(codex / antigravity)共用同一套 UI:每个 provider 暴露一个
 * 满足 ProviderLocalApi 的对象,UI 组件只依赖该接口。
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

export interface LocalStatModel { model: string; requests: number; totalTokens: number }
export interface LocalStatAccount { authId: string; email: string; requests: number; totalTokens: number }
export interface LocalStatRecent { atMs: number; authId: string; model: string; failed: boolean; latencyMs: number }
export interface LocalStatsSnapshot {
  totalRequests: number
  totalFailed: number
  totalInputTokens: number
  totalOutputTokens: number
  byAccount: LocalStatAccount[] | null
  byModel: LocalStatModel[] | null
  recent: LocalStatRecent[] | null
}

export interface WakeupConfig { enabled: boolean; intervalMinutes: number }
export interface WakeupRunEntry { atMs: number; accountId: string; email: string; ok: boolean; err?: string }

export interface InstanceProfile {
  id: string
  provider: string
  name: string
  userDataDir: string
  workingDir?: string
  extraArgs?: string
  bindAccountId?: string
  createdAt: number
  lastLaunchedAt?: number
  pid?: number
}

/** 一个 provider 的本地账号能力(UI 组件只依赖此接口)。 */
export interface ProviderLocalApi {
  listAccounts(): Promise<LocalAccountView[]>
  startLogin(): Promise<string>
  waitLogin(loginId: string): Promise<LocalAccountView>
  setPoolEnabled(id: string, enabled: boolean): Promise<void>
  setPriority(id: string): Promise<void>
  deleteAccount(id: string): Promise<void>
  deleteAccounts(ids: string[]): Promise<void>
  gatewayStart(): Promise<LocalGatewayStatus>
  gatewayStop(): Promise<void>
  gatewayStatus(): Promise<LocalGatewayStatus>
  stats(): Promise<LocalStatsSnapshot>
  exportAccounts(ids: string[]): Promise<string>
  importFromJSON(json: string): Promise<number>
  wakeupConfig(): Promise<WakeupConfig>
  setWakeupConfig(enabled: boolean, intervalMinutes: number): Promise<void>
  wakeupRunNow(): Promise<WakeupRunEntry[]>
  wakeupHistory(): Promise<WakeupRunEntry[]>
  instanceList(): Promise<InstanceProfile[]>
  instanceCreate(name: string, userDataDir: string, workingDir: string, extraArgs: string, bindAccountId: string): Promise<InstanceProfile>
  instanceDelete(id: string): Promise<void>
  instanceLaunch(id: string): Promise<void>
  instanceStop(id: string): Promise<void>
  /** 接管号源切换(仅部分 provider 支持,如 codex)。 */
  getSource?(): Promise<string>
  setSource?(source: 'remote' | 'local'): Promise<void>
}

type GoApp = Record<string, (...args: unknown[]) => Promise<unknown>>

function app(): GoApp {
  const w = window as unknown as { go?: { main?: { App?: GoApp } } }
  const a = w?.go?.main?.App
  if (!a) throw new Error('Wails App bindings unavailable')
  return a
}

export const codexLocalApi: ProviderLocalApi = {
  listAccounts: () => app().LocalListCodexAccounts() as Promise<LocalAccountView[]>,
  startLogin: () => app().LocalStartCodexLogin() as Promise<string>,
  waitLogin: (id) => app().LocalWaitCodexLogin(id) as Promise<LocalAccountView>,
  setPoolEnabled: (id, e) => app().LocalSetPoolEnabled(id, e) as Promise<void>,
  setPriority: (id) => app().LocalSetCodexPriority(id) as Promise<void>,
  deleteAccount: (id) => app().LocalDeleteAccount(id) as Promise<void>,
  deleteAccounts: (ids) => app().LocalDeleteAccounts(ids) as Promise<void>,
  gatewayStart: () => app().LocalGatewayStart() as Promise<LocalGatewayStatus>,
  gatewayStop: () => app().LocalGatewayStop() as Promise<void>,
  gatewayStatus: () => app().LocalGatewayStatus() as Promise<LocalGatewayStatus>,
  stats: () => app().LocalCodexStats() as Promise<LocalStatsSnapshot>,
  exportAccounts: (ids) => app().LocalExportCodexAccounts(ids) as Promise<string>,
  importFromJSON: (json) => app().LocalImportCodexFromJSON(json) as Promise<number>,
  wakeupConfig: () => app().LocalCodexWakeupConfig() as Promise<WakeupConfig>,
  setWakeupConfig: (e, i) => app().LocalSetCodexWakeupConfig(e, i) as Promise<void>,
  wakeupRunNow: () => app().LocalCodexWakeupRunNow() as Promise<WakeupRunEntry[]>,
  wakeupHistory: () => app().LocalCodexWakeupHistory() as Promise<WakeupRunEntry[]>,
  instanceList: () => app().LocalInstanceList('codex') as Promise<InstanceProfile[]>,
  instanceCreate: (n, d, w, e, b) => app().LocalInstanceCreate('codex', n, d, w, e, b) as Promise<InstanceProfile>,
  instanceDelete: (id) => app().LocalInstanceDelete(id) as Promise<void>,
  instanceLaunch: (id) => app().LocalInstanceLaunch(id) as Promise<void>,
  instanceStop: (id) => app().LocalInstanceStop(id) as Promise<void>,
  getSource: () => app().LocalGetCodexSource() as Promise<string>,
  setSource: (src) => app().LocalSetCodexSource(src) as Promise<void>,
}

export const antigravityLocalApi: ProviderLocalApi = {
  listAccounts: () => app().LocalListAntigravityAccounts() as Promise<LocalAccountView[]>,
  startLogin: () => app().LocalStartAntigravityLogin() as Promise<string>,
  waitLogin: (id) => app().LocalWaitAntigravityLogin(id) as Promise<LocalAccountView>,
  setPoolEnabled: (id, e) => app().LocalSetPoolEnabled(id, e) as Promise<void>,
  setPriority: (id) => app().LocalSetAntigravityPriority(id) as Promise<void>,
  deleteAccount: (id) => app().LocalDeleteAccount(id) as Promise<void>,
  deleteAccounts: (ids) => app().LocalDeleteAccounts(ids) as Promise<void>,
  gatewayStart: () => app().LocalAntigravityGatewayStart() as Promise<LocalGatewayStatus>,
  gatewayStop: () => app().LocalAntigravityGatewayStop() as Promise<void>,
  gatewayStatus: () => app().LocalAntigravityGatewayStatus() as Promise<LocalGatewayStatus>,
  stats: () => app().LocalAntigravityStats() as Promise<LocalStatsSnapshot>,
  exportAccounts: (ids) => app().LocalExportAntigravityAccounts(ids) as Promise<string>,
  importFromJSON: (json) => app().LocalImportAntigravityFromJSON(json) as Promise<number>,
  wakeupConfig: () => app().LocalAntigravityWakeupConfig() as Promise<WakeupConfig>,
  setWakeupConfig: (e, i) => app().LocalSetAntigravityWakeupConfig(e, i) as Promise<void>,
  wakeupRunNow: () => app().LocalAntigravityWakeupRunNow() as Promise<WakeupRunEntry[]>,
  wakeupHistory: () => app().LocalAntigravityWakeupHistory() as Promise<WakeupRunEntry[]>,
  instanceList: () => app().LocalInstanceList('antigravity') as Promise<InstanceProfile[]>,
  instanceCreate: (n, d, w, e, b) => app().LocalInstanceCreate('antigravity', n, d, w, e, b) as Promise<InstanceProfile>,
  instanceDelete: (id) => app().LocalInstanceDelete(id) as Promise<void>,
  instanceLaunch: (id) => app().LocalInstanceLaunch(id) as Promise<void>,
  instanceStop: (id) => app().LocalInstanceStop(id) as Promise<void>,
}
