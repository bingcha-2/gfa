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
  idePath: string
  hubPath: string
  codexAppPath: string
  claudeDesktopPath: string
  cardExpiry: string
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
export type PageId = 'home' | 'logs' | 'faq' | 'settings'

// ===== Log =====
export interface ParsedLog {
  raw: string
  time: string
  tag: string
  message: string
  level: 'info' | 'error' | 'warn' | 'success' | 'system'
}

