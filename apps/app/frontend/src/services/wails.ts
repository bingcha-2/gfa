/**
 * Wails API 封装层
 * 前端所有 Wails 调用统一从这里导出，不直接使用 window.go.*
 */

import type { ModelUsageStats } from '@/lib/usageSummary'

import {
  GetConfig,
  SaveConfig as _SaveConfig,
  GetStats,
  RefreshQuota as _RefreshQuota,
  RestartProxy as _RestartProxy,
  GetLogs,
  ClearLogs as _ClearLogs,
  GetIDEStatus,
  OpenSystemPermissionSettings as _OpenSystemPermissionSettings,
  OpenCACertForTrust as _OpenCACertForTrust,
  InstallStandaloneClaude as _InstallStandaloneClaude,
  InjectSelected as _InjectSelected,
  RestoreSelected as _RestoreSelected,
  SetClaudeDesktopMockLogin as _SetClaudeDesktopMockLogin,
  GetDetectedPaths,
  BrowseForPath as _BrowseForPath,
  CheckForUpdate as _CheckForUpdate,
  DownloadUpdate as _DownloadUpdate,
  RestartToUpdate as _RestartToUpdate,
  GetAppVersion,
  GetAnnouncement,
  GetFaqData,
  GetCodexRelayConfig as _GetCodexRelayConfig,
  SaveCodexRelayConfig as _SaveCodexRelayConfig,
  UserLogin as _UserLogin,
  UserLogout as _UserLogout,
  GetAccountState as _GetAccountState,
  HeartbeatCheck as _HeartbeatCheck,
  SetSubscriptionPriority as _SetSubscriptionPriority,
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
} as const

export const SITE_URLS = {
  faq: `${APEX_BASE}/faq`,
} as const

import { BrowserOpenURL } from '../../wailsjs/runtime/runtime'

import type { main } from '../../wailsjs/go/models'
import type { Config, IDEStatus, UpdateStatus, BoundAccountInfo, AccountState } from '@/types'

// ===== Config =====
export async function getConfig(): Promise<Config> {
  // GetConfig 返回 wails 生成的 main.Config(其 SubscriptionSnapshot.remainFraction 标为
  // optional number);手写 Config 用 number|null。两者是同一数据的镜像,断言对齐(与 saveConfig 对称)。
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

// 服务端心跳:校验会话/订阅是否仍有效。致命类(SESSION_INVALID / DEVICE_REVOKED /
// SUBSCRIPTION_EXPIRED)由 Go 侧处理(清会话 / 标记不可用)并以 reject 返回;
// 瞬时网络错误同样 reject 但不动本地会话。
export async function heartbeatCheck(): Promise<Record<string, unknown>> {
  return _HeartbeatCheck()
}

// 调整订阅接力优先级(↑↓);成功后调用方应 heartbeat() 刷新本地多订阅快照。
export async function setSubscriptionPriority(subscriptionId: string, priority: number): Promise<void> {
  await _SetSubscriptionPriority(subscriptionId, priority)
}

// ===== Stats =====
export interface StatsResponse {
  proxyRunning: boolean
  proxyPort: number
  stats: Record<string, number>
  leaser: {
    serviceState: string
    accountId: number
    autoLeaseRunning: boolean
    cardUnusable?: boolean
    boundResetMs?: number
    accountFractions?: Record<string, number>
    accountResetMs?: Record<string, number>
    myFractions?: Record<string, number>
    myResetMs?: Record<string, number>
    // 我的份额·周窗口(5h 之外的第二条血条;仅 codex/anthropic 绑卡有数据)
    myWeeklyFractions?: Record<string, number>
    myWeeklyResetMs?: Record<string, number>
    codexQuota?: { hourlyFraction: number; weeklyFraction: number; hourlyResetMs: number; weeklyResetMs: number }
    claudeQuota?: { hourlyFraction: number; weeklyFraction: number; hourlyResetMs: number; weeklyResetMs: number }
    boundAccounts?: BoundAccountInfo[]
    hasToken: boolean
    lastError: string
    activationExpiresAt: string
    accessKeyStatus: {
      products?: string[]
      opusTokensUsed?: number
      opusTokenLimit?: number
      geminiTokensUsed?: number
      geminiTokenLimit?: number
      tokenWindowResetMs?: number
      tokenWindowResetAt?: string
      weight?: number          // 本卡 fair-share 份额权重(份额 X/Y 的 X)
      shareCapacity?: number   // 号总份数(份额 X/Y 的 Y)
      buckets?: { bucket: string; used: number; limit: number }[]  // 每复合桶服务端真实用量/上限(static「我的卡」真相源·5h)
      weeklyBuckets?: {
        bucket: string
        used: number
        limit: number
        weeklyWindowResetMs?: number
        weeklyWindowResetAt?: string
      }[]  // 每复合桶·周(显式或派生 5h×R)
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

// ===== Logs =====
export async function getLogs(): Promise<string[]> {
  return GetLogs()
}

export async function clearLogs(): Promise<boolean> {
  return _ClearLogs()
}

// ===== IDE =====
export async function getIDEStatus(): Promise<IDEStatus> {
  return GetIDEStatus()
}

export async function openSystemPermissionSettings(): Promise<void> {
  return _OpenSystemPermissionSettings()
}

// 用系统证书 UI 打开根 CA(macOS:钥匙串访问;Windows:证书对话框),供用户手动设"始终信任"。
// 仅在自动安装(CA_FAILED)失败后兜底用 —— 省掉用户找隐藏目录 ~/.bcai 的麻烦。
export async function openCACertForTrust(): Promise<void> {
  return _OpenCACertForTrust()
}

// 「一键安装独立版」:winget 从社区源静默装官方独立版 Claude Desktop。winget 不存在/失败
// 会抛错,调用方据此回退到打开下载页。
export async function installStandaloneClaude(): Promise<void> {
  return _InstallStandaloneClaude()
}

export async function injectSelected(targets: string[]): Promise<string> {
  return _InjectSelected(targets)
}

export async function restoreSelected(targets: string[]): Promise<string> {
  return _RestoreSelected(targets)
}

export async function setClaudeDesktopMockLogin(on: boolean): Promise<boolean> {
  return _SetClaudeDesktopMockLogin(on)
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

// ===== FAQ =====
export interface FaqDataResponse {
  items?: Array<{
    id: string
    category: string
    question: string
    answer: string
    sortOrder: number
  }>
  settings?: Record<string, string>
}

export async function getFaqData(): Promise<FaqDataResponse> {
  return GetFaqData() as Promise<FaqDataResponse>
}

// ===== Codex 中转(API 卡密)模式 =====
export interface CodexRelayConfig {
  mode: string // "rental" | "relay"
  baseURL: string
  apiKey: string
  protocol: string // "responses" | "chat"
  modelMap: Record<string, string> | null
}

export async function getCodexRelayConfig(): Promise<CodexRelayConfig> {
  return _GetCodexRelayConfig() as Promise<CodexRelayConfig>
}

export async function saveCodexRelayConfig(
  mode: string,
  baseURL: string,
  apiKey: string,
  protocol: string,
  modelMap: Record<string, string>,
): Promise<void> {
  await _SaveCodexRelayConfig(mode, baseURL, apiKey, protocol, modelMap)
}

// ===== Browser =====
export function openURL(url: string): void {
  BrowserOpenURL(url)
}
