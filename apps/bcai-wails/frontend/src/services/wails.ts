/**
 * Wails API 封装层
 * 前端所有 Wails 调用统一从这里导出，不直接使用 window.go.*
 */

import {
  GetConfig,
  SaveConfig as _SaveConfig,
  ActivateCard as _ActivateCard,
  GetStats,
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
} from '../../wailsjs/go/main/App'

import { BrowserOpenURL } from '../../wailsjs/runtime/runtime'

import type { Config, IDEStatus, UpdateStatus, BoundAccountInfo } from '@/types'

// ===== Config =====
export async function getConfig(): Promise<Config> {
  return GetConfig()
}

export async function saveConfig(cfg: Config): Promise<void> {
  await _SaveConfig(cfg)
}

// ===== Account Card =====
export async function activateCard(card: string): Promise<string> {
  return _ActivateCard(card)
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
  }
  dailyHistory: { date: string; inputTokens: number; outputTokens: number; cachedTokens?: number; cacheWriteTokens?: number }[]
  hourlyHistory: { hour: string; inputTokens: number; outputTokens: number; cachedTokens?: number; cacheWriteTokens?: number }[]
  chartMode: string
  cumulativeSaving: number
  appVersion: string
  updateStatus: UpdateStatus
  proxyStartedAt: string
}

export async function getStats(): Promise<StatsResponse> {
  return GetStats() as Promise<StatsResponse>
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
