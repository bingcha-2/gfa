/**
 * 全局应用状态 Store
 * 管理 config、stats、IDE 状态、更新、公告
 */

import { create } from 'zustand'
import * as api from '@/services/wails'
import type { Config, IDEProduct, UpdateStatus, ActiveAccountSummary } from '@/types'

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
  recoveryRemainingMs: number

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
  fetchIDEStatus: () => Promise<void>
  fetchAnnouncement: () => Promise<void>
  saveConfig: (cfg: Config) => Promise<void>
  activateCard: (card: string) => Promise<string>
}

export const useAppStore = create<AppState>((set, get) => ({
  config: null,
  proxyRunning: false,
  proxyPort: 60670,
  leaserState: 'unconfigured',
  leaserError: '',
  accountId: 0,
  hasToken: false,
  autoLeaseRunning: false,
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
  recoveryRemainingMs: -1,
  ideProducts: [],
  updateStatus: null,
  announcement: '',
  appVersion: '5.1.2',
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
        recoveryRemainingMs: lq?.windowResetMs && lq.windowResetMs > 0 ? lq.windowResetMs : -1,
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
      set({ ideProducts: status.products || [] })
    } catch (err) {
      console.error('fetchIDEStatus failed:', err)
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
