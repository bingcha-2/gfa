import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  announceSelfAccountChange,
  quotaReminderKey,
  selfAccountName,
} from '@/lib/selfAccounts'
import * as api from '@/services/wails'
import type { SelfAccount, SelfAccountQuotaWindow } from '@/types'

const REFRESH_INTERVAL_MS = 5 * 60 * 1000

type LowWindow = { name: '5 小时' | '本周'; quota: SelfAccountQuotaWindow }

export function findLowSelfAccountWindows(account: SelfAccount, threshold: number): LowWindow[] {
  const windows: LowWindow[] = []
  if (account.quota?.fiveHour?.known && account.quota.fiveHour.remaining <= threshold) windows.push({ name: '5 小时', quota: account.quota.fiveHour })
  if (account.quota?.weekly?.known && account.quota.weekly.remaining <= threshold) windows.push({ name: '本周', quota: account.quota.weekly })
  return windows
}

export function SelfAccountQuotaAlert({ onOpenAccounts }: { onOpenAccounts: () => void }) {
  const [alert, setAlert] = useState<{ account: SelfAccount; windows: LowWindow[] } | null>(null)
  const checkingRef = useRef(false)

  const check = useCallback(async () => {
    if (checkingRef.current) return
    checkingRef.current = true
    try {
      const state = await api.refreshSelfAccountQuotas(true)
      announceSelfAccountChange()
      if (!state.alert.enabled) return
      const current = state.accounts.find((account) => account.current)
      if (!current) return
      const low = findLowSelfAccountWindows(current, state.alert.threshold)
      const fresh = low.filter(({ name, quota }) => !localStorage.getItem(quotaReminderKey(current.id, name, quota)))
      if (fresh.length === 0) return
      fresh.forEach(({ name, quota }) => localStorage.setItem(quotaReminderKey(current.id, name, quota), String(Date.now())))
      setAlert({ account: current, windows: fresh })
    } catch {
      // Background quota checks stay quiet. The page shows actionable refresh errors.
    } finally {
      checkingRef.current = false
    }
  }, [])

  useEffect(() => {
    void check()
    const timer = window.setInterval(() => void check(), REFRESH_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [check])

  const details = alert?.windows.map(({ name, quota }) => `${name}剩余 ${quota.remaining}%`).join('，') || ''
  return (
    <Dialog open={!!alert} onOpenChange={(open) => !open && setAlert(null)}>
      <DialogContent>
        <DialogHeader>
          <div className="mb-2 grid h-9 w-9 place-items-center rounded-[10px] bg-amber-500/10 text-[var(--warning-deep)]"><AlertTriangle size={18} /></div>
          <DialogTitle>Codex 自有账号额度不多了</DialogTitle>
          <DialogDescription>
            {alert ? `${selfAccountName(alert.account)} 的${details}。可以继续使用，或切换到其他已保存账号。` : ''}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setAlert(null)}>知道了</Button>
          <Button onClick={() => { setAlert(null); onOpenAccounts() }}>切换账号</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
