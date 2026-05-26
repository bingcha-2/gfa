/**
 * 号池状态 Store
 */

import { create } from 'zustand'
import * as api from '@/services/wails'
import type { AccountInfo } from '@/types'

type FilterType = 'all' | 'active' | 'error'

interface PoolState {
  mode: 'remote' | 'local'
  accounts: AccountInfo[]
  loading: boolean
  refreshing: boolean
  filter: FilterType
  expandedIds: Set<number>

  setMode: (m: 'remote' | 'local') => Promise<void>
  fetchAccounts: () => Promise<void>
  addAccount: (email: string, token: string, profile: string) => Promise<{ success: boolean; error?: string }>
  removeAccount: (id: number) => Promise<void>
  toggleAccount: (id: number, enabled: boolean) => Promise<void>
  oauthLogin: (profile: string) => Promise<{ success: boolean; email?: string; error?: string }>
  initMode: () => Promise<void>

  // ── 新增操作 ──
  setFilter: (f: FilterType) => void
  toggleExpand: (id: number) => void
  refreshQuota: () => Promise<void>
  switchAccount: (id: number) => Promise<void>
  setAlias: (id: number, alias: string) => Promise<{ success: boolean; error?: string }>
  lockAccount: (id: number) => Promise<void>
  unlockAccount: () => Promise<void>
}

export const usePoolStore = create<PoolState>((set, get) => ({
  mode: 'remote',
  accounts: [],
  loading: false,
  refreshing: false,
  filter: 'all',
  expandedIds: new Set(),

  setMode: async (m) => {
    const result = await api.setPoolMode(m)
    if (result.success) {
      set({ mode: m })
      if (m === 'local') await get().fetchAccounts()
    }
  },

  fetchAccounts: async () => {
    try {
      const accounts = await api.getPoolAccounts()
      set({ accounts: accounts || [] })
    } catch {
      // silent
    }
  },

  addAccount: async (email, token, profile) => {
    set({ loading: true })
    try {
      const result = await api.addPoolAccount(email, token, profile)
      if (result.success) await get().fetchAccounts()
      return result
    } finally {
      set({ loading: false })
    }
  },

  removeAccount: async (id) => {
    await api.removePoolAccount(id)
    await get().fetchAccounts()
  },

  toggleAccount: async (id, enabled) => {
    await api.togglePoolAccount(id, enabled)
    await get().fetchAccounts()
  },

  oauthLogin: async (profile) => {
    set({ loading: true })
    try {
      const result = await api.oauthLogin(profile)
      if (result.success) await get().fetchAccounts()
      return result
    } finally {
      set({ loading: false })
    }
  },

  initMode: async () => {
    try {
      const mode = await api.getPoolMode()
      set({ mode: (mode as 'remote' | 'local') || 'remote' })
    } catch {
      // default remote
    }
  },

  // ── 新增操作 ──

  setFilter: (f) => set({ filter: f }),

  toggleExpand: (id) => {
    const next = new Set(get().expandedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    set({ expandedIds: next })
  },

  refreshQuota: async () => {
    set({ refreshing: true })
    try {
      await api.refreshPoolQuota()
      await get().fetchAccounts()
    } finally {
      set({ refreshing: false })
    }
  },

  switchAccount: async (id) => {
    await api.switchPoolAccount(id)
    await get().fetchAccounts()
  },

  setAlias: async (id, alias) => {
    const result = await api.setAccountAlias(id, alias)
    if (result.success) await get().fetchAccounts()
    return result
  },

  lockAccount: async (id) => {
    await api.lockPoolAccount(id)
    await get().fetchAccounts()
  },

  unlockAccount: async () => {
    await api.unlockPoolAccount()
    await get().fetchAccounts()
  },
}))
