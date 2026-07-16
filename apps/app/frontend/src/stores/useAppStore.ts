/**
 * 全局应用状态 Store
 * 管理 config、stats、IDE 状态、更新、公告
 */

import { create } from 'zustand'
import type { ModelUsageStats } from '@/lib/usageSummary'
import * as api from '@/services/wails'
import type { Config, IDEProduct, UpdateStatus, AccountState } from '@/types'

/** Fallback rate-limit window when the server hasn't reported one yet (5h). */
const DEFAULT_WINDOW_MS = 5 * 60 * 60 * 1000

export type AppNotification = {
  level: string // "block" (needs user action) | "transient" (self-heals)
  category: string
  message: string
  recoverable: boolean
  dedupKey: string
  source: string
}

interface AppState {
  // ===== Account =====
  account: AccountState | null
  // 被动登出原因码(心跳检测到 DEVICE_REVOKED / SESSION_INVALID 等致命态时落地;
  // 登录页据此给一句解释,避免「无声登出」看着像没反应)。
  logoutReason: string

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
  entitledProducts: string[]  // 订阅授权产品并集(跨所有生效订阅);空=冷启动未知→回退 cardProducts
  activationExpiresAt: string
  notifications: AppNotification[]

  // Today stats
  todayRequests: number
  todayErrors: number
  todayInputTokens: number
  todayOutputTokens: number
  todayCachedTokens: number
  todayCacheWriteTokens: number
  todayBillableTokens: number
  cumulativeSaving: number
  todayApiValueUSD: number
  todayByModel: Record<string, ModelUsageStats>
  localTodayTokens: number
  localTodayApiValueUSD: number

  // Usage trend (history)
  dailyHistory: { date: string; inputTokens: number; outputTokens: number; cachedTokens?: number; cacheWriteTokens?: number; savedMoneyUSD?: number; byModel?: Record<string, ModelUsageStats> }[]
  hourlyHistory: { hour: string; inputTokens: number; outputTokens: number; cachedTokens?: number; cacheWriteTokens?: number; byModel?: Record<string, ModelUsageStats> }[]
  chartMode: string

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

  // ===== Actions =====
  fetchStats: () => Promise<void>
  fetchConfig: () => Promise<void>
  fetchIDEStatus: () => Promise<IDEProduct[]>
  fetchAnnouncement: () => Promise<void>
  fetchAccountState: () => Promise<void>
  heartbeat: (refreshUsage?: boolean) => Promise<void>
  saveConfig: (cfg: Config) => Promise<void>
  login: (email: string, password: string) => Promise<Record<string, unknown>>
  logout: () => Promise<void>
}

// 心跳串行守护:usePolling 本身是串行链(上一次完成后才调度下一次),这里再防
// 多处触发重叠 —— 同一时刻最多一个心跳在途。
let heartbeatInFlight: Promise<void> | null = null

export const useAppStore = create<AppState>((set, get) => ({
  account: null,
  logoutReason: '',
  config: null,
  proxyRunning: false,
  proxyPort: 48800,
  leaserState: 'unconfigured',
  leaserError: '',
  notifications: [],
  accountId: 0,
  hasToken: false,
  autoLeaseRunning: false,
  cardUnusable: false,
  cardProducts: [],
  entitledProducts: [],
  activationExpiresAt: '',
  todayRequests: 0,
  todayErrors: 0,
  todayInputTokens: 0,
  todayOutputTokens: 0,
  todayCachedTokens: 0,
  todayCacheWriteTokens: 0,
  todayBillableTokens: 0,
  cumulativeSaving: 0,
  todayApiValueUSD: 0,
  todayByModel: {},
  localTodayTokens: 0,
  localTodayApiValueUSD: 0,
  dailyHistory: [],
  hourlyHistory: [],
  chartMode: 'daily',
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
  appVersion: '8.0.0',
  appStartTime: Date.now(),

  fetchStats: async () => {
    try {
      const data = await api.getStats()
      const today = data.today || { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, billableTokens: 0, generations: 0, retries: 0, savedMoneyUSD: 0, byModel: {} }
      const lq = data.leaser?.localQuota
      const localToday = data.localUsage?.today
      const quotaStatus = data.leaser?.accessKeyStatus
      const currentAccount = get().account
      const account = currentAccount && quotaStatus?.id && quotaStatus.usdQuotaByProduct
        ? {
            ...currentAccount,
            subscriptions: currentAccount.subscriptions.map((subscription) =>
              subscription.id === quotaStatus.id
                ? { ...subscription, usdQuotaByProduct: quotaStatus.usdQuotaByProduct }
                : subscription,
            ),
          }
        : currentAccount

      set({
        account,
        proxyRunning: data.proxyRunning,
        proxyPort: data.proxyPort,
        leaserState: data.leaser?.serviceState || 'unconfigured',
        leaserError: data.leaser?.lastError || '',
        notifications: ((data as any).notifications as AppNotification[]) || [],
        accountId: data.leaser?.accountId || 0,
        hasToken: data.leaser?.hasToken || false,
        autoLeaseRunning: data.leaser?.autoLeaseRunning || false,
        cardUnusable: data.leaser?.cardUnusable || false,
        cardProducts: data.leaser?.accessKeyStatus?.products || [],
        entitledProducts: (data.leaser?.entitledProducts as string[] | undefined) || [],
        activationExpiresAt: data.leaser?.activationExpiresAt || '',
        // 今日请求 = 成功生成数(对齐服务端"计费调用"口径,排除探活/重试/错误)
        todayRequests: today.generations || 0,
        todayErrors: today.errors || 0,
        todayInputTokens: today.inputTokens || 0,
        todayOutputTokens: today.outputTokens || 0,
        todayCachedTokens: today.cachedTokens || 0,
        todayCacheWriteTokens: today.cacheWriteTokens || 0,
        todayBillableTokens: today.billableTokens || 0,
        cumulativeSaving: data.cumulativeSaving || 0,
        todayApiValueUSD: (today as { savedMoneyUSD?: number }).savedMoneyUSD || 0,
        todayByModel: (today as { byModel?: Record<string, ModelUsageStats> }).byModel || {},
        localTodayTokens: (localToday?.inputTokens || 0) + (localToday?.outputTokens || 0) + (localToday?.cachedTokens || 0) + (localToday?.cacheWriteTokens || 0),
        localTodayApiValueUSD: localToday?.savedMoneyUSD || 0,
        dailyHistory: data.dailyHistory || [],
        hourlyHistory: data.hourlyHistory || [],
        chartMode: data.chartMode || 'daily',
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

  fetchAccountState: async () => {
    try {
      const state = await api.getAccountState()
      set({ account: state })
    } catch (err) {
      console.error('fetchAccountState failed:', err)
    }
  },

  saveConfig: async (cfg: Config) => {
    await api.saveConfig(cfg)
    set({ config: cfg })
  },

  login: async (email: string, password: string) => {
    set({ logoutReason: '' }) // 新一次登录尝试 → 清掉上次的被动登出提示
    const result = await api.userLogin(email, password)
    await get().fetchAccountState()
    await get().fetchConfig()
    await get().fetchStats()
    return result
  },

  logout: async () => {
    await api.userLogout()
    set({
      account: null,
      todayRequests: 0, todayErrors: 0, todayInputTokens: 0, todayOutputTokens: 0,
      todayCachedTokens: 0, todayCacheWriteTokens: 0, todayBillableTokens: 0,
      todayApiValueUSD: 0, todayByModel: {}, cumulativeSaving: 0,
      localTodayTokens: 0, localTodayApiValueUSD: 0, dailyHistory: [], hourlyHistory: [],
    })
    await get().fetchAccountState()
  },

  // 服务端心跳(20min 轮询):校验会话/订阅。致命类由 Go 侧落地 —— SESSION_INVALID /
  // DEVICE_REVOKED 清本地会话(随后 fetchAccountState → 登录页),SUBSCRIPTION_EXPIRED
  // 标记 cardUnusable(仪表盘横幅)。瞬时网络错误只记日志,绝不登出。
  heartbeat: async (refreshUsage = false) => {
    if (heartbeatInFlight) {
      await heartbeatInFlight
      if (!refreshUsage) return
    }

    const pending = (async () => {
      try {
        if (refreshUsage) await api.refreshUsageSummary()
        else await api.heartbeatCheck()
      } catch (err) {
        console.error('heartbeat failed:', err)
        // 致命会话类(设备被移除 / 会话失效)Go 侧已清本地会话 → 即将回登录页;
        // 抓出原因码,登录页展示一句解释。SUBSCRIPTION_EXPIRED 不在此列(保留登录态,走横幅)。
        const msg = String((err as { message?: string } | undefined)?.message ?? err ?? '')
        const code = msg.match(/DEVICE_REVOKED|SESSION_INVALID|DEVICE_LIMIT_EXCEEDED/)?.[0]
        if (code) set({ logoutReason: code })
      }
      // 无论成败都从配置重读账号态:致命类已被后端清掉/更新 → UI 跟着落地。
      await get().fetchAccountState()
      await get().fetchStats()
    })()
    heartbeatInFlight = pending
    try {
      await pending
    } finally {
      if (heartbeatInFlight === pending) heartbeatInFlight = null
    }
  },
}))
