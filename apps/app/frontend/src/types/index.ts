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
  remainFraction: number | null // 最紧复合桶剩余额度比例(0-1);null=无限额/无数据
  productQuota?: Record<string, ProductQuotaWindow> // 每产品(绑定号)整号 5h/周剩余,逐订阅按产品画血条
}

// 单产品整号 5h/周剩余(百分比 0-100;null=无数据)。与服务端 buildSubscriptionSummary 对齐。
// my* 字段:该订阅在绑定母号上的「我的份额」(fair-share,0-1),逐订阅画双层血条
// (母号 hourlyPercent 打底 + 我的 myHourlyFraction 叠加);myShare=e_i(占整号比例,外层几何)。
// 缺省(老服务端/取不到)→ 退回单层条。
export interface ProductQuotaWindow {
  hourlyPercent: number | null
  weeklyPercent: number | null
  hourlyResetAt: string | null
  weeklyResetAt: string | null
  myHourlyFraction?: number | null
  myWeeklyFraction?: number | null
  // myShare = 双层血条「我那一席」的名义份额 weight/号总份数(遮超卖,超卖前口径),非真实 e_i=w/D。
  myShare?: number | null
  // 独享(营销标签):权威标志。true → 血条画单层「剩余 X%」,不走拼车双层。
  exclusive?: boolean
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
export type PageId = 'home' | 'logs' | 'faq' | 'settings' | 'local_codex'

// ===== Log =====
export interface ParsedLog {
  raw: string
  time: string
  tag: string
  message: string
  level: 'info' | 'error' | 'warn' | 'success' | 'system'
}

