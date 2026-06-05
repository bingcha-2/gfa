/**
 * TypeScript 类型定义
 * 从 Wails 生成的 models.ts 重新导出 + 前端专用类型
 */

// Re-export Wails generated types
export { main as WailsModels } from '../../wailsjs/go/models'

// ===== Config =====
export interface Config {
  accountCard: string
  deviceId: string
  proxyPort: number
  upstreamProxy: string
  idePath: string
  hubPath: string
  codexAppPath: string
  cardExpiry: string
  poolMode: string
  codexMode: string
  codexRelayBase: string
  codexRelayKey: string
  codexRelayProtocol: string
  codexModelMap: Record<string, string>
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

// ===== Quota =====
export interface QuotaEntry {
  key: string
  label: string
  percent: number
  isBlocked: boolean
  resetTime: string
  provider: string
}

export interface QuotaGroup {
  provider: string
  percent: number
  resetTime: string
  modelCount: number
  blockedCount: number
  entries: QuotaEntry[]
}

// ===== Account Pool =====
export interface AccountInfo {
  id: number
  email: string
  alias: string
  enabled: boolean
  projectId: string
  planType: string
  hasAccessToken: boolean
  tokenExpiresIn: number
  quotaStatus: string
  quotaReason: string
  exhaustedUntil?: string
  consecutiveErrors: number
  lastUsedAt?: string
  blockedModels?: Record<string, string>
  // ── 新增字段 ──
  isActive: boolean
  isLocked: boolean
  successRate: number | null
  qualityTier: string
  requestStats: { total: number; successes: number; failures: number }
  quotaGroups: QuotaGroup[]
  quotaRefreshedAt?: string
  accountStatusLabel: string
  accountStatusTone: string
  credits?: CreditsInfo | null
}

export interface CreditsInfo {
  known: boolean
  available: boolean
  creditAmount: number
  minCreditAmount: number
  paidTierID: string
}

// ===== Bound Account (绑定卡每个产品当前租到的账号 + token) =====
export interface BoundAccountInfo {
  product: string // antigravity | codex | anthropic
  accountId: number
  emailHint: string
  planType: string // 会员等级:antigravity ultra/premium/…; codex plus/pro; anthropic max/pro
  accessToken: string
  expiresAt: number
  leasedAt: number
  projectId?: string
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
export type PageId = 'home' | 'pool' | 'logs' | 'settings'

// ===== Log =====
export interface ParsedLog {
  raw: string
  time: string
  tag: string
  message: string
  level: 'info' | 'error' | 'warn' | 'success' | 'system'
}

// ===== Active Account (本地号池当前账号额度摘要) =====
export interface ActiveAccountSummary {
  accountId: number
  email: string
  alias?: string
  planType: string
  credits?: CreditsInfo | null
  quotaGroups: QuotaGroup[]
  quotaRefreshedAt: number
}
