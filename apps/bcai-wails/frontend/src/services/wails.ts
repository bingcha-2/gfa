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
  GetPoolAccounts,
  GetPoolStatus,
  AddPoolAccount as _AddPoolAccount,
  RemovePoolAccount as _RemovePoolAccount,
  TogglePoolAccount as _TogglePoolAccount,
  SetPoolMode as _SetPoolMode,
  GetPoolMode,
  OAuthLogin as _OAuthLogin,
  RefreshPoolQuota as _RefreshPoolQuota,
  SwitchPoolAccount as _SwitchPoolAccount,
  SetAccountAlias as _SetAccountAlias,
  LockPoolAccount as _LockPoolAccount,
  UnlockPoolAccount as _UnlockPoolAccount,
  GetCodexRelayConfig as _GetCodexRelayConfig,
  SaveCodexRelayConfig as _SaveCodexRelayConfig,
} from '../../wailsjs/go/main/App'

import { BrowserOpenURL } from '../../wailsjs/runtime/runtime'

import type { Config, IDEStatus, AccountInfo, UpdateStatus, ActiveAccountSummary, BoundAccountInfo } from '@/types'

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
    bucketFractions?: Record<string, number>
    bucketResetMs?: Record<string, number>
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
    generations: number
    retries: number
  }
  cumulativeSaving: number
  appVersion: string
  updateStatus: UpdateStatus
  poolMode: string
  poolStatus: {
    total: number
    available: number
    exhausted: number
    withToken: number
    lockedAccountId?: number
  }
  proxyStartedAt: string
  activeAccount?: ActiveAccountSummary | null
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

export async function injectSelected(targets: string[]): Promise<string> {
  return _InjectSelected(targets)
}

export async function restoreSelected(targets: string[]): Promise<string> {
  return _RestoreSelected(targets)
}

export async function setClaudeDesktopMockLogin(on: boolean): Promise<boolean> {
  return _SetClaudeDesktopMockLogin(on)
}

export async function getDetectedPaths(): Promise<{ idePath: string; hubPath: string; codexAppPath: string }> {
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

// ===== Pool =====
export async function getPoolAccounts(): Promise<AccountInfo[]> {
  return GetPoolAccounts() as unknown as Promise<AccountInfo[]>
}

export async function getPoolStatus(): Promise<Record<string, number>> {
  return GetPoolStatus() as Promise<Record<string, number>>
}

export async function addPoolAccount(
  email: string,
  refreshToken: string
): Promise<{ success: boolean; id?: number; error?: string }> {
  return _AddPoolAccount(email, refreshToken) as any
}

export async function removePoolAccount(id: number): Promise<{ success: boolean; error?: string }> {
  return _RemovePoolAccount(id) as any
}

export async function togglePoolAccount(
  id: number,
  enabled: boolean
): Promise<{ success: boolean; error?: string }> {
  return _TogglePoolAccount(id, enabled) as any
}

export async function setPoolMode(mode: string): Promise<{ success: boolean; error?: string }> {
  return _SetPoolMode(mode) as any
}

export async function getPoolMode(): Promise<string> {
  return GetPoolMode()
}

export async function oauthLogin(): Promise<{ success: boolean; email?: string; id?: number; error?: string }> {
  return _OAuthLogin() as any
}

// ===== Pool Quota Management =====
export async function refreshPoolQuota(): Promise<{ success: boolean; refreshed?: number }> {
  return _RefreshPoolQuota() as any
}

export async function switchPoolAccount(id: number): Promise<{ success: boolean }> {
  return _SwitchPoolAccount(id) as any
}

export async function setAccountAlias(id: number, alias: string): Promise<{ success: boolean; error?: string }> {
  return _SetAccountAlias(id, alias) as any
}

export async function lockPoolAccount(id: number): Promise<{ success: boolean; error?: string }> {
  return _LockPoolAccount(id) as any
}

export async function unlockPoolAccount(): Promise<{ success: boolean }> {
  return _UnlockPoolAccount() as any
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
