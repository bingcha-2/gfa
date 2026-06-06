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
