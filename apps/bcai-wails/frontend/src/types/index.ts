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
  cardExpiry: string
  poolMode: string
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

// ===== Account Pool =====
export interface AccountInfo {
  id: number
  email: string
  alias: string
  enabled: boolean
  projectId: string
  planType: string
  oauthProfile: string
  hasAccessToken: boolean
  tokenExpiresIn: number
  quotaStatus: string
  quotaReason: string
  exhaustedUntil?: string
  consecutiveErrors: number
  lastUsedAt?: string
  blockedModels?: Record<string, string>
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
