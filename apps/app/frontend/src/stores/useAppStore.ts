/**
 * 全局应用状态 Store
 * 管理 config、stats、IDE 状态、更新、公告
 */

import { create } from 'zustand'
import type { ModelUsageStats } from '@/lib/usageSummary'
import * as api from '@/services/wails'
import type { Config, IDEProduct, UpdateStatus, BoundAccountInfo, AccountState } from '@/types'

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
  quotaMode: string  // 'static' | 'dynamic' | 'unlimited'
  accountFractions: Record<string, number>  // 整号上游余量(号余量条)
  accountResetMs: Record<string, number>
  myFractions: Record<string, number>       // 我的 fair-share 份额(绑定卡的我的卡条·5h)
  myResetMs: Record<string, number>
  myWeeklyFractions: Record<string, number> // 我的 fair-share 份额·周(仅 codex/anthropic)
  myWeeklyResetMs: Record<string, number>
  cardWeight: number                        // Legacy fallback for seat count.
  cardShareSeats: number                    // 我的席位 X/Y 的 X
  cardShareCapacity: number                 // 号总份数(份额 X/Y 的 Y)
  cardBuckets: Record<string, { used: number; limit: number; resetMs?: number }>  // 每复合桶服务端真实用量/上限(static「我的卡」真相源·5h);resetMs=该卡 5h 窗口自身的 reset
  cardWeeklyBuckets: Record<string, { used: number; limit: number; resetMs?: number; resetAt?: string }>  // 每复合桶·周(显式或派生 5h×R)
  codexQuota: { hourlyFraction: number; weeklyFraction: number; hourlyResetMs: number; weeklyResetMs: number } | null
  claudeQuota: { hourlyFraction: number; weeklyFraction: number; hourlyResetMs: number; weeklyResetMs: number } | null
  boundAccounts: BoundAccountInfo[]
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
  heartbeat: () => Promise<void>
  saveConfig: (cfg: Config) => Promise<void>
  login: (email: string, password: string) => Promise<Record<string, unknown>>
  logout: () => Promise<void>
}

// 心跳串行守护:usePolling 本身是串行链(上一次完成后才调度下一次),这里再防
// 多处触发重叠 —— 同一时刻最多一个心跳在途。
let heartbeatInFlight = false

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
  quotaMode: '',
  accountFractions: {},
  accountResetMs: {},
  myFractions: {},
  myResetMs: {},
  myWeeklyFractions: {},
  myWeeklyResetMs: {},
  cardWeight: 1,
  cardShareSeats: 1,
  cardShareCapacity: 8,
  cardBuckets: {},
  cardWeeklyBuckets: {},
  codexQuota: null,
  claudeQuota: null,
  boundAccounts: [],
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
      const accessKeyStatus = data.leaser?.accessKeyStatus as ({ weight?: number; shareCapacity?: number; shareSeats?: number } | undefined)

      set({
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
        quotaMode: (data.leaser as any)?.quotaMode || (data.leaser?.accessKeyStatus as any)?.quotaMode || '',
        accountFractions: data.leaser?.accountFractions || {},
        accountResetMs: data.leaser?.accountResetMs || {},
        myFractions: data.leaser?.myFractions || {},
        myResetMs: data.leaser?.myResetMs || {},
        myWeeklyFractions: data.leaser?.myWeeklyFractions || {},
        myWeeklyResetMs: data.leaser?.myWeeklyResetMs || {},
        cardWeight: accessKeyStatus?.weight || 1,
        cardShareSeats: accessKeyStatus?.shareSeats || accessKeyStatus?.weight || 1,
        cardShareCapacity: accessKeyStatus?.shareCapacity || 8,
        cardBuckets: Object.fromEntries(
          // resetMs 取该卡 5h 窗口自身的 reset(服务端已对齐到 hourly,绝非周);各桶共享同一 5h 窗口。
          (data.leaser?.accessKeyStatus?.buckets || []).map((b) => [b.bucket, {
            used: b.used,
            limit: b.limit,
            resetMs: data.leaser?.accessKeyStatus?.tokenWindowResetMs,
          }]),
        ),
        cardWeeklyBuckets: Object.fromEntries(
          (data.leaser?.accessKeyStatus?.weeklyBuckets || []).map((b) => [b.bucket, {
            used: b.used,
            limit: b.limit,
            resetMs: b.weeklyWindowResetMs,
            resetAt: b.weeklyWindowResetAt,
          }]),
        ),
        codexQuota: (data.leaser?.codexQuota as AppState['codexQuota']) || null,
        claudeQuota: (data.leaser?.claudeQuota as AppState['claudeQuota']) || null,
        boundAccounts: data.leaser?.boundAccounts || [],
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
    return result
  },

  logout: async () => {
    await api.userLogout()
    set({ account: null })
    await get().fetchAccountState()
  },

  // 服务端心跳(60s 轮询):校验会话/订阅。致命类由 Go 侧落地 —— SESSION_INVALID /
  // DEVICE_REVOKED 清本地会话(随后 fetchAccountState → 登录页),SUBSCRIPTION_EXPIRED
  // 标记 cardUnusable(仪表盘横幅)。瞬时网络错误只记日志,绝不登出。
  heartbeat: async () => {
    if (heartbeatInFlight) return
    heartbeatInFlight = true
    try {
      await api.heartbeatCheck()
    } catch (err) {
      console.error('heartbeat failed:', err)
      // 致命会话类(设备被移除 / 会话失效)Go 侧已清本地会话 → 即将回登录页;
      // 抓出原因码,登录页展示一句解释。SUBSCRIPTION_EXPIRED 不在此列(保留登录态,走横幅)。
      const msg = String((err as { message?: string } | undefined)?.message ?? err ?? '')
      const code = msg.match(/DEVICE_REVOKED|SESSION_INVALID|DEVICE_LIMIT_EXCEEDED/)?.[0]
      if (code) set({ logoutReason: code })
    } finally {
      heartbeatInFlight = false
    }
    // 无论成败都从配置重读账号态:致命类已被后端清掉/更新 → UI 跟着落地。
    await get().fetchAccountState()
  },
}))
