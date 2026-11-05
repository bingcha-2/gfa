/**
 * TypeScript 类型定义
 * 从 Wails 生成的 models.ts 重新导出 + 前端专用类型
 */

// Re-export Wails generated types
export { main as WailsModels } from '../../wailsjs/go/models'

// ===== Config =====
export interface Config {
  // Legacy card fields (kept for parsing old configs; not used for runtime auth)
  accountCard: string
  cardExpiry: string
  deviceId: string
  proxyPort: number
  idePath: string
  hubPath: string
  codexAppPath: string
  claudeDesktopPath: string
  // Account-login fields
  userToken: string
  userTokenExpiry: string
  userEmail: string
  planName: string
  planExpiry: string
  planDeviceMax: number
  deviceName: string
  codexMode: string
  codexRelayBase: string
  codexRelayKey: string
  codexRelayProtocol: string
  codexModelMap: Record<string, string>
  subscriptions: AccountSubscription[]
}

// ===== Account Subscription (多订阅快照·按 priority 升序) =====
export interface AccountSubscription {
  id: string
  status: string
  expiresAt: string // ISO-8601;空串表示长期有效
  deviceLimit: number
  priority: number
  products: string[] // antigravity | codex | anthropic
  levels?: Record<string, string> // purchased bind level per product, e.g. { codex: "pro" }
  usdQuotaByProduct?: Record<string, SubscriptionProductUsdQuota> // 产品间额度互相独立
  exclusive?: boolean
  shareSeats?: number
}

export interface SubscriptionProductUsdQuota {
  fiveHour: SubscriptionUsdQuotaWindow | null
  weekly: SubscriptionUsdQuotaWindow | null
}

export interface SubscriptionUsdQuotaWindow {
  used: number
  limit: number
  resetAt: string | null
}

// ===== Account State =====
export interface AccountState {
  loggedIn: boolean
  email: string
  planName: string
  planExpiry: string
  planDeviceMax: number
  deviceName: string
  tokenExpiry: string
  tokenExpired: boolean
  sessionUnusable: boolean
  subscriptions: AccountSubscription[]
}

// ===== IDE =====
export interface IDEProduct {
  id: string
  name: string
  detected: boolean
  detectedPath: string
  injected: boolean
  supportsInjection: boolean
  injectionType: string
}

export interface IDEStatus {
  products: IDEProduct[]
  proxyUrl: string
  isLsProxyApplied: boolean
}

// ===== Update =====
export interface UpdateStatus {
  status: string
  version: string
  current: string
  changelog: string
  percent: number
  error: string
  canSkip: boolean
}

// ===== Pages =====
export type PageId = 'takeover' | 'self-accounts' | 'remote' | 'logs' | 'settings'

// ===== Local Codex accounts =====
export interface SelfAccountQuotaWindow {
  remaining: number
  resetAt: number
  known: boolean
}

export interface SelfAccountQuota {
  fiveHour?: SelfAccountQuotaWindow | null
  weekly?: SelfAccountQuotaWindow | null
  fetchedAt?: number
  error?: string
}

export interface SelfAccount {
  id: string
  alias: string
  email: string
  accountId: string
  planType: string
  current: boolean
  quota?: SelfAccountQuota | null
  createdAt: number
  updatedAt: number
  lastUsedAt: number
}

export interface SelfAccountState {
  accounts: SelfAccount[]
  activeId: string
  alert: { enabled: boolean; threshold: number }
  storage: { localOnly: boolean; encrypted: boolean }
}

export interface SelfAccountSwitchResult {
  account: SelfAccount
  reloadMode: 'not_running' | 'daemon_restarted' | 'app_restarted'
  takeoverDisabled: boolean
}

// ===== Log =====
export interface ParsedLog {
  raw: string
  time: string
  tag: string
  message: string
  level: 'info' | 'error' | 'warn' | 'success' | 'system'
}
