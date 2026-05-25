/**
 * 号池状态 Store
 */

import { create } from 'zustand'
import * as api from '@/services/wails'
import type { AccountInfo } from '@/types'

interface PoolState {
  mode: 'remote' | 'local'
  accounts: AccountInfo[]
  loading: boolean

  setMode: (m: 'remote' | 'local') => Promise<void>
  fetchAccounts: () => Promise<void>
  addAccount: (email: string, token: string, profile: string) => Promise<{ success: boolean; error?: string }>
  removeAccount: (id: number) => Promise<void>
  toggleAccount: (id: number, enabled: boolean) => Promise<void>
  oauthLogin: (profile: string) => Promise<{ success: boolean; email?: string; error?: string }>
  initMode: () => Promise<void>
}

export const usePoolStore = create<PoolState>((set, get) => ({
  mode: 'remote',
  accounts: [],
  loading: false,

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
}))
