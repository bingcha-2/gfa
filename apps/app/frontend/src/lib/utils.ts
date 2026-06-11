/**
 * 工具函数集合
 * 从旧 main.js 提取并规范化
 */

import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { ParsedLog } from '@/types'
import { t, useLocaleStore } from '@/i18n'

/**
 * 格式化 token：阶梯 K → M → B,最小单位 K(小于 1K 也显示为 0.xxK)。
 * 整数不带小数,非整数保留两位小数;0 → "0"。
 * 例:842→"0.84K" · 1200→"1.20K" · 12000→"12K" · 1.50M · 3.45B
 */
export function formatTokens(n: number): string {
  n = Math.max(0, Math.floor(Number(n) || 0))
  if (n === 0) return '0'
  let v: number, unit: string
  if (n >= 1_000_000_000) { v = n / 1_000_000_000; unit = 'B' }
  else if (n >= 1_000_000) { v = n / 1_000_000; unit = 'M' }
  else { v = n / 1_000; unit = 'K' }
  const s = Number.isInteger(v) ? String(v) : v.toFixed(2)
  return s + unit
}

/** 遮罩卡号：AI-XXXXXXXX → AI-XXX***XXXX */
export function maskCard(card: string): string {
  if (!card || card.length < 12) return card
  return card.substring(0, 6) + '***' + card.substring(card.length - 4)
}

/** HTML 转义 */
export function escapeHtml(s: string): string {
  const div = document.createElement('div')
  div.textContent = String(s || '')
  return div.innerHTML
}

/** 格式化倒计时 ms → "2h 31m" */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return t('time.recovered')
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  return `${m}m ${String(s).padStart(2, '0')}s`
}

/** 格式化会话时长 */
export function formatDuration(startTime: number): string {
  const mins = Math.floor((Date.now() - startTime) / 60000)
  if (mins < 60) return t('time.minutes', { m: mins })
  const hrs = Math.floor(mins / 60)
  const rm = mins % 60
  return t('time.hoursMinutes', { h: hrs, m: rm })
}

/** 解析单行日志 */
export function parseLogLine(line: string): ParsedLog {
  const raw = String(line || '')
  let time = ''
  let rest = raw

  // ISO 格式: 2026-05-22T15:04:05.000+08:00 [tag] message
  const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2}T\S+)\s+(.*)$/)
  if (isoMatch) {
    const parsedDate = new Date(isoMatch[1])
    time = Number.isNaN(parsedDate.getTime())
      ? isoMatch[1].substring(11, 19)
      : parsedDate.toLocaleTimeString()
    rest = isoMatch[2]
  } else {
    const simpleMatch = raw.match(/^(\d{1,2}:\d{2}:\d{2})\s+(.*)$/)
    if (simpleMatch) {
      time = simpleMatch[1]
      rest = simpleMatch[2]
    }
  }

  const tagMatch = rest.match(/^(\[[^\]]+\])\s*(.*)$/)
  const tag = tagMatch ? tagMatch[1] : ''
  const message = tagMatch ? tagMatch[2] || '' : rest

  // Classify level
  const lower = raw.toLowerCase()
  let level: ParsedLog['level'] = 'info'
  if (lower.includes('[error]') || lower.includes('failed') || lower.includes('error:') || lower.includes('失败')) {
    level = 'error'
  } else if (lower.includes('warn') || lower.includes('blocked') || lower.includes('retrying')) {
    level = 'warn'
  } else if (lower.includes('obtained') || lower.includes('成功') || lower.includes('完成')) {
    level = 'success'
  } else if (lower.includes('===') || lower.includes('[system]') || lower.includes('[app]')) {
    level = 'system'
  }

  return { raw, time, tag, message, level }
}

/** 格式化日期(按当前界面语言) */
export function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) return dateStr
    return d.toLocaleDateString(useLocaleStore.getState().locale, { year: 'numeric', month: 'long', day: 'numeric' })
  } catch {
    return dateStr
  }
}

/** shadcn/ui cn utility */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
