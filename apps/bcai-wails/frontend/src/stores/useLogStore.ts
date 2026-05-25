/**
 * 日志状态 Store
 */

import { create } from 'zustand'
import * as api from '@/services/wails'
import { parseLogLine } from '@/lib/utils'
import type { ParsedLog } from '@/types'

export type LogFilter = 'all' | 'error' | 'warn' | 'proxy' | 'inject' | 'pool'

interface LogState {
  logs: ParsedLog[]
  filter: LogFilter
  searchQuery: string
  lastRaw: string

  setFilter: (f: LogFilter) => void
  setSearchQuery: (q: string) => void
  fetchLogs: () => Promise<void>
  clearLogs: () => Promise<void>
  getFilteredLogs: () => ParsedLog[]
}

export const useLogStore = create<LogState>((set, get) => ({
  logs: [],
  filter: 'all',
  searchQuery: '',
  lastRaw: '',

  setFilter: (f) => set({ filter: f }),
  setSearchQuery: (q) => set({ searchQuery: q }),

  fetchLogs: async () => {
    try {
      const lines = await api.getLogs()
      const raw = Array.isArray(lines) ? lines.join('\n') : String(lines)
      if (raw === get().lastRaw) return
      const parsed = (Array.isArray(lines) ? lines : raw.split('\n'))
        .filter((l: string) => l.trim())
        .map(parseLogLine)
      set({ logs: parsed, lastRaw: raw })
    } catch {
      // silent
    }
  },

  clearLogs: async () => {
    await api.clearLogs()
    set({ logs: [], lastRaw: '' })
  },

  getFilteredLogs: () => {
    const { logs, filter, searchQuery } = get()
    return logs.filter((log) => {
      if (searchQuery && !log.raw.toLowerCase().includes(searchQuery.toLowerCase())) return false
      if (filter === 'all') return true
      const lo = log.raw.toLowerCase()
      if (filter === 'error') return lo.includes('error') || lo.includes('failed')
      if (filter === 'warn') return lo.includes('warn') || lo.includes('retrying')
      if (filter === 'proxy') return lo.includes('[proxy]')
      if (filter === 'inject') return lo.includes('[ide-inject]')
      if (filter === 'pool') return lo.includes('[pool]') || lo.includes('[local-pool]')
      return true
    })
  },
}))
