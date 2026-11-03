/**
 * Wails API 封装层
 * 前端所有 Wails 调用统一从这里导出，不直接使用 window.go.*
 */

import type { ModelUsageStats } from '@/lib/usageSummary'
import type { SubscriptionProductUsdQuota } from '@/types'

import {
  GetConfig,
  SaveConfig as _SaveConfig,
  GetStats,
  RefreshQuota as _RefreshQuota,
  RestartProxy as _RestartProxy,
  ForceReleaseProxyPort as _ForceReleaseProxyPort,
  GetLogs,
  ClearLogs as _ClearLogs,
  ExportDiagnosticBundle as _ExportDiagnosticBundle,
  GetIDEStatus,
  OpenSystemPermissionSettings as _OpenSystemPermissionSettings,
  InstallStandaloneClaude as _InstallStandaloneClaude,
  HostClaudeGateway as _HostClaudeGateway,
  ClearDesktopPolicyConflict as _ClearDesktopPolicyConflict,
  InjectSelected as _InjectSelected,
  RestoreSelected as _RestoreSelected,
  DetectCompetingClaudeConfig as _DetectCompetingClaudeConfig,
  SanitizeCompetingClaudeConfig as _SanitizeCompetingClaudeConfig,
  GetDetectedPaths,
  BrowseForPath as _BrowseForPath,
  CheckForUpdate as _CheckForUpdate,
  DownloadUpdate as _DownloadUpdate,
  RestartToUpdate as _RestartToUpdate,
  GetAppVersion,
  GetAnnouncement,
  GetCodexFastMode as _GetCodexFastMode,
  SetCodexFastMode as _SetCodexFastMode,
  UserLogin as _UserLogin,
  UserLogout as _UserLogout,
  GetAccountState as _GetAccountState,
  GetReferralInfo as _GetReferralInfo,
  HeartbeatCheck as _HeartbeatCheck,
  RefreshUsageSummary as _RefreshUsageSummary,
  RepairCodexAuth as _RepairCodexAuth,
  SetSubscriptionPriority as _SetSubscriptionPriority,
  ActivateCode as _ActivateCode,
} from '../../wailsjs/go/main/App'

// ===== Portal / Site URLs =====
// 构建时通过 VITE_PORTAL_BASE / VITE_APEX_BASE 注入（见 build-wails.yml）；
// 本地 dev：dev-local.sh 注入 VITE_PORTAL_BASE=http://127.0.0.1:3000，把链接指到本地 web。
const PORTAL_BASE = import.meta.env.VITE_PORTAL_BASE || 'https://my.bcai.lol'
const APEX_BASE = import.meta.env.VITE_APEX_BASE || 'https://bcai.lol'

export const PORTAL_URLS = {
  home: `${PORTAL_BASE}/account`, // 用户中心首页(意见反馈入口指向这里)
  register: `${PORTAL_BASE}/account/register`,
  forgot: `${PORTAL_BASE}/account/forgot`,
  billing: `${PORTAL_BASE}/account/billing`,
  bind: `${PORTAL_BASE}/account/billing`,
  devices: `${PORTAL_BASE}/account/devices`,
  tickets: `${PORTAL_BASE}/account/tickets`, // 工单/客服:订阅失效等问题的人工支持入口
  support: `${PORTAL_BASE}/account/support`,
} as const

export const SITE_URLS = {
} as const

import { BrowserOpenURL } from '../../wailsjs/runtime/runtime'

import type { main } from '../../wailsjs/go/models'
import type { Config, IDEStatus, UpdateStatus, AccountState } from '@/types'

// ===== Config =====
export async function getConfig(): Promise<Config> {
  // GetConfig 返回 Wails 生成模型；手写 Config 是同一 JSON 数据的前端镜像。
  return GetConfig() as unknown as Config
}

export async function saveConfig(cfg: Config): Promise<void> {
  // 运行时 cfg 即 GetConfig 返回的 main.Config 实例(自带 convertValues);手写 Config
  // interface 字段已与之对齐,仅缺该方法签名,故断言 —— wails 生成 class 与手写镜像的固有差异。
  await _SaveConfig(cfg as unknown as main.Config)
}

// ===== Account Login =====
export async function userLogin(email: string, password: string): Promise<Record<string, unknown>> {
  return _UserLogin(email, password)
}

export async function userLogout(): Promise<void> {
  await _UserLogout()
}

export async function getAccountState(): Promise<AccountState> {
  return _GetAccountState() as Promise<AccountState>
}

export interface ReferralInvitee {
  email: string
  registeredAt: string
  rewarded: boolean
}
export interface ReferralInfo {
  referralCode: string
  referralLink: string
  invitees: ReferralInvitee[]
  rewards: { totalCents: number; grantedCount: number }
  creditCents: number
}

// 分享/邀请信息:POST /api/app/referral(后端复用 toC ReferralService)。未登录时 Go 侧 reject。
export async function getReferralInfo(): Promise<ReferralInfo> {
  return _GetReferralInfo() as Promise<ReferralInfo>
}

// 服务端心跳:校验会话/订阅是否仍有效。致命类(SESSION_INVALID / DEVICE_REVOKED /
// SUBSCRIPTION_EXPIRED)由 Go 侧处理(清会话 / 标记不可用)并以 reject 返回;
// 瞬时网络错误同样 reject 但不动本地会话。
export async function heartbeatCheck(): Promise<Record<string, unknown>> {
  return _HeartbeatCheck()
}

// 用户主动刷新时绕过服务端五分钟用量缓存；会话与订阅校验逻辑与普通心跳相同。
export async function refreshUsageSummary(): Promise<Record<string, unknown>> {
  return _RefreshUsageSummary()
}

export async function repairCodexAuth(): Promise<string> {
  return _RepairCodexAuth()
}

// 调整订阅接力优先级(↑↓);成功后调用方应 heartbeat() 刷新本地多订阅快照。
export async function setSubscriptionPriority(subscriptionId: string, priority: number): Promise<void> {
  await _SetSubscriptionPriority(subscriptionId, priority)
}

// 激活码兑换结果:开通的(独立)订阅摘要,供成功态展示。
export interface ActivateCodeResult {
  alreadyActivated: boolean
  subscription: {
    id: string
    expiresAt: string
    products: string[]
    deviceLimit: number
  }
}

// 兑换激活码 → 开通一条独立订阅。成功后调用方应 heartbeat() 刷新本地多订阅快照,
// 让新订阅立即出现。失败时 Go 侧把后端可读错误码透传为 "CODE_X: 消息",调用方按码映射文案。
export async function activateCode(code: string): Promise<ActivateCodeResult> {
  return _ActivateCode(code) as Promise<ActivateCodeResult>
}

// ===== Stats =====
export type GatewayModelUsage = { model: string; requests: number; inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWrite5m: number | null; cacheWrite1h: number | null; costUsd: number | null }

export interface GatewaySummary {
  dailyHistory?: { date: string; inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number; requests: number; costUsd: number; byModel?: Record<string, GatewayModelUsage> }[]
  loading?: boolean
  error?: string
  configured?: boolean
  subscriptionValid?: boolean
  enabled?: boolean
  upstreamEnabled?: boolean
  limitUsd?: number
  usedUsd?: number
  remainingUsd?: number
  totalUsedUsd?: number
  totalRequests?: number
  windows?: { period: string; remaining: number | null; resetAt: number | null; state?: "limited" | "unlimited" | "unknown"; exhausted?: boolean; freshness?: string; calibrationStatus?: string | null; uncertain?: boolean }[]
  models?: GatewayModelUsage[]
}
export interface StatsResponse {
  gateway?: GatewaySummary | null
  proxyRunning: boolean
  proxyPort: number
  stats: Record<string, number>
  leaser: {
    serviceState: string
    accountId: number
    autoLeaseRunning: boolean
    cardUnusable?: boolean
    boundResetMs?: number
    hasToken: boolean
    lastError: string
    activationExpiresAt: string
    entitledProducts?: string[]
    accessKeyStatus: {
      id?: string
      products?: string[]
      usdQuotaByProduct?: Record<string, SubscriptionProductUsdQuota>
      opusTokensUsed?: number
      opusTokenLimit?: number
      geminiTokensUsed?: number
      geminiTokenLimit?: number
      tokenWindowResetMs?: number
      tokenWindowResetAt?: string
    }
    localQuota?: {
      opusTokensUsed?: number
      opusTokenLimit?: number
      geminiTokensUsed?: number
      geminiTokenLimit?: number
      codexTokensUsed?: number
      codexTokenLimit?: number
      windowResetMs?: number
      windowMs?: number
    }
  }
  today: {
    requests: number
    errors: number
    inputTokens: number
    outputTokens: number
    cachedTokens: number
    cacheWriteTokens: number
    billableTokens: number
    generations: number
    retries: number
    savedMoneyUSD?: number
    byModel?: Record<string, ModelUsageStats>
  }
  dailyHistory: { date: string; inputTokens: number; outputTokens: number; cachedTokens?: number; cacheWriteTokens?: number; savedMoneyUSD?: number; byModel?: Record<string, ModelUsageStats> }[]
  hourlyHistory: { hour: string; inputTokens: number; outputTokens: number; cachedTokens?: number; cacheWriteTokens?: number; byModel?: Record<string, ModelUsageStats> }[]
  chartMode: string
  cumulativeSaving: number
  usageSource?: string
  localUsage?: {
    today?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; cacheWriteTokens?: number; savedMoneyUSD?: number }
    cumulativeSaving?: number
    namespaceUserId?: string
  }
  appVersion: string
  updateStatus: UpdateStatus
  proxyStartedAt: string
}

export async function getStats(): Promise<StatsResponse> {
  return GetStats() as Promise<StatsResponse>
}

// 强制拉取上游额度并上报(force=true,绕过节流)。GetStats 只读缓存,故刷新需先调本方法
// 再 getStats 才能看到上游最新余量。失败不致命,调用方应吞错后照常刷新本地状态。
export async function refreshQuota(): Promise<void> {
  await _RefreshQuota()
}

// ===== Proxy =====
export async function restartProxy(): Promise<void> {
  await _RestartProxy()
}

// Windows 排障:用户确认后强制结束占用首选端口 48800 的进程，并重启本地代理。
export async function forceReleaseProxyPort(): Promise<string> {
  return _ForceReleaseProxyPort()
}

// ===== Logs =====
export async function getLogs(): Promise<string[]> {
  return GetLogs()
}

export async function clearLogs(): Promise<boolean> {
  return _ClearLogs()
}

export async function exportDiagnosticBundle(): Promise<string> {
  return _ExportDiagnosticBundle()
}

// ===== IDE =====
export async function getIDEStatus(): Promise<IDEStatus> {
  return GetIDEStatus()
}

export async function openSystemPermissionSettings(): Promise<void> {
  return _OpenSystemPermissionSettings()
}


// 「一键安装独立版」:winget 从社区源静默装官方独立版 Claude Desktop。winget 不存在/失败
// 会抛错,调用方据此回退到打开下载页。
export async function installStandaloneClaude(): Promise<void> {
  return _InstallStandaloneClaude()
}

// Claude Code「网关托管」:激活专用 key 并写入 settings.json,不走 TUN/MITM/出口闸。
export async function hostClaudeGateway(): Promise<string> {
  return _HostClaudeGateway()
}

export async function clearDesktopPolicyConflict(): Promise<string> {
  return _ClearDesktopPolicyConflict()
}

export async function injectSelected(targets: string[]): Promise<string> {
  return _InjectSelected(targets)
}

export async function restoreSelected(targets: string[]): Promise<string> {
  return _RestoreSelected(targets)
}

export type ClaudeConfigConflict = main.ClaudeConfigConflict
export type SanitizeReport = main.SanitizeReport

// 只读检测：机器上指向第三方中转的配置（cc-switch、别家 ANTHROPIC_BASE_URL、企业策略文件等）。
// GFA 自己的接管注入不会被列入。
export async function detectCompetingClaudeConfig(): Promise<ClaudeConfigConflict[]> {
  return _DetectCompetingClaudeConfig()
}

// 备份并清理指定冲突（ids 为空表示清理全部检出）。破坏性动作，须先经封号免责确认。
export async function sanitizeCompetingClaudeConfig(ids: string[]): Promise<SanitizeReport> {
  return _SanitizeCompetingClaudeConfig(ids)
}


export async function getDetectedPaths(): Promise<{ idePath: string; hubPath: string; codexAppPath: string; claudeDesktopPath: string }> {
  return GetDetectedPaths()
}

export async function browseForPath(title: string): Promise<string> {
  return _BrowseForPath(title)
}

// ===== Update =====
export async function checkForUpdate(): Promise<Record<string, unknown>> {
  return _CheckForUpdate()
}

export async function downloadUpdate(): Promise<void> {
  await _DownloadUpdate()
}

export async function restartToUpdate(): Promise<void> {
  await _RestartToUpdate()
}

export async function getAppVersion(): Promise<string> {
  return GetAppVersion()
}

// ===== Announcement =====
export async function getAnnouncement(): Promise<string> {
  return GetAnnouncement()
}

// ===== Codex 中转(API 卡密)模式 =====
export async function getCodexFastMode(): Promise<boolean> {
  return _GetCodexFastMode()
}

export async function setCodexFastMode(fast: boolean): Promise<void> {
  await _SetCodexFastMode(fast)
}

// ===== Browser =====
export function openURL(url: string): void {
  BrowserOpenURL(url)
}
