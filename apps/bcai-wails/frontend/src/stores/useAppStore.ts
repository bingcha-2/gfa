/**
 * 全局应用状态 Store
 * 管理 config、stats、IDE 状态、更新、公告
 */

import { create } from 'zustand'
import * as api from '@/services/wails'
import type { Config, IDEProduct, UpdateStatus, ActiveAccountSummary } from '@/types'

/** Fallback rate-limit window when the server hasn't reported one yet (5h). */
const DEFAULT_WINDOW_MS = 5 * 60 * 60 * 1000

interface AppState {
  // ===== Data =====
  config: Config | null
  proxyRunning: boolean
  proxyPort: number
  leaserState: string
  leaserError: string
  accountId: number
  hasToken: boolean
  autoLeaseRunning: boolean
  cardUnusable: boolean
  cardProducts: string[]
  bucketFractions: Record<string, number>
  bucketResetMs: Record<string, number>
  codexQuota: { hourlyFraction: number; weeklyFraction: number; hourlyResetMs: number; weeklyResetMs: number } | null
  activationExpiresAt: string

  // Today stats
  todayRequests: number
  todayErrors: number
  todayInputTokens: number
  todayOutputTokens: number
  cumulativeSaving: number

  // Usage
  opusUsed: number | null
  opusLimit: number | null
  geminiUsed: number | null
  geminiLimit: number | null
  codexUsed: number | null
  codexLimit: number | null
  recoveryRemainingMs: number
  recoveryWindowMs: number

  // IDE
  ideProducts: IDEProduct[]

  // Update
  updateStatus: UpdateStatus | null

  // Announcement
  announcement: string

  // App
  appVersion: string
  appStartTime: number

  // Active account (本地号池)
  activeAccount: ActiveAccountSummary | null

  // ===== Actions =====
  fetchStats: () => Promise<void>
  fetchConfig: () => Promise<void>
  fetchIDEStatus: () => Promise<IDEProduct[]>
  fetchAnnouncement: () => Promise<void>
  saveConfig: (cfg: Config) => Promise<void>
  activateCard: (card: string) => Promise<string>
}

export const useAppStore = create<AppState>((set, get) => ({
  config: null,
  proxyRunning: false,
  proxyPort: 48800,
  leaserState: 'unconfigured',
  leaserError: '',
  accountId: 0,
  hasToken: false,
  autoLeaseRunning: false,
  cardUnusable: false,
  cardProducts: [],
  bucketFractions: {},
  bucketResetMs: {},
  codexQuota: null,
  activationExpiresAt: '',
  todayRequests: 0,
  todayErrors: 0,
  todayInputTokens: 0,
  todayOutputTokens: 0,
  cumulativeSaving: 0,
  opusUsed: null,
  opusLimit: null,
  geminiUsed: null,
  geminiLimit: null,
  codexUsed: null,
  codexLimit: null,
  recoveryRemainingMs: -1,
  recoveryWindowMs: DEFAULT_WINDOW_MS,
  ideProducts: [],
  updateStatus: null,
  announcement: '',
  appVersion: '5.1.3',
  appStartTime: Date.now(),
  activeAccount: null,

  fetchStats: async () => {
    try {
      const data = await api.getStats()
      const today = data.today || { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, generations: 0, retries: 0 }
      const lq = data.leaser?.localQuota

      set({
        proxyRunning: data.proxyRunning,
        proxyPort: data.proxyPort,
        leaserState: data.leaser?.serviceState || 'unconfigured',
        leaserError: data.leaser?.lastError || '',
        accountId: data.leaser?.accountId || 0,
        hasToken: data.leaser?.hasToken || false,
        autoLeaseRunning: data.leaser?.autoLeaseRunning || false,
        cardUnusable: data.leaser?.cardUnusable || false,
        cardProducts: data.leaser?.accessKeyStatus?.products || [],
        bucketFractions: data.leaser?.bucketFractions || {},
        bucketResetMs: data.leaser?.bucketResetMs || {},
        codexQuota: (data.leaser?.codexQuota as AppState['codexQuota']) || null,
        activationExpiresAt: data.leaser?.activationExpiresAt || '',
        todayRequests: today.requests || 0,
        todayErrors: today.errors || 0,
        todayInputTokens: today.inputTokens || 0,
        todayOutputTokens: today.outputTokens || 0,
        cumulativeSaving: data.cumulativeSaving || 0,
        // localQuota 是唯一 source of truth（和 CheckLocalQuota 读同一个值，保证一致）
        opusUsed: lq?.opusTokensUsed ?? null,
        opusLimit: lq?.opusTokenLimit ?? null,
        geminiUsed: lq?.geminiTokensUsed ?? null,
        geminiLimit: lq?.geminiTokenLimit ?? null,
        codexUsed: lq?.codexTokensUsed ?? null,
        codexLimit: lq?.codexTokenLimit ?? null,
        // 额度恢复倒计时优先用"绑定号上游重置时间";没有(池子卡/未租到)再退回本地窗口。
        recoveryRemainingMs: (data.leaser?.boundResetMs && data.leaser.boundResetMs > 0)
          ? data.leaser.boundResetMs
          : (lq?.windowResetMs && lq.windowResetMs > 0 ? lq.windowResetMs : -1),
        recoveryWindowMs: lq?.windowMs && lq.windowMs > 0 ? lq.windowMs : DEFAULT_WINDOW_MS,
        updateStatus: data.updateStatus || null,
        appVersion: data.appVersion || get().appVersion,
        activeAccount: data.activeAccount || null,
      })
    } catch (err) {
      console.error('fetchStats failed:', err)
    }
  },

  fetchConfig: async () => {
    try {
      const cfg = await api.getConfig()
      set({ config: cfg })
    } catch (err) {
      console.error('fetchConfig failed:', err)
    }
  },

  fetchIDEStatus: async () => {
    try {
      const status = await api.getIDEStatus()
      const products = status.products || []
      set({ ideProducts: products })
      return products
    } catch (err) {
      console.error('fetchIDEStatus failed:', err)
      return get().ideProducts
    }
  },

  fetchAnnouncement: async () => {
    try {
      const text = await api.getAnnouncement()
      set({ announcement: text?.trim() || '' })
    } catch {
      // silent
    }
  },

  saveConfig: async (cfg: Config) => {
    await api.saveConfig(cfg)
    set({ config: cfg })
  },

  activateCard: async (card: string) => {
    const result = await api.activateCard(card)
    await get().fetchConfig()
    return result
  },
}))
