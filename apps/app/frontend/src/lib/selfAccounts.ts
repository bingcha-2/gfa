import type { SelfAccount, SelfAccountQuotaWindow } from '@/types'

export const SELF_ACCOUNT_STATE_EVENT = 'bcai:self-accounts-changed'

export function announceSelfAccountChange() {
  window.dispatchEvent(new Event(SELF_ACCOUNT_STATE_EVENT))
}

export function selfAccountName(account: SelfAccount): string {
  return account.alias?.trim() || account.email?.trim() || `Codex 账号 ${account.id.slice(0, 6)}`
}

export function quotaReminderKey(accountId: string, windowName: string, quota: SelfAccountQuotaWindow, now = Date.now()): string {
  const fallbackWindowMs = windowName === '本周' ? 7 * 24 * 60 * 60 * 1000 : 5 * 60 * 60 * 1000
  const cycle = quota.resetAt > 0 ? quota.resetAt : `unknown-${Math.floor(now / fallbackWindowMs)}`
  return `bcai:self-account-quota-alert:${accountId}:${windowName}:${cycle}`
}

export function formatSelfAccountTime(timestamp?: number): string {
  if (!timestamp) return '未知'
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(timestamp))
}

export function cleanSelfAccountError(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/^Error:\s*/i, '')
}
