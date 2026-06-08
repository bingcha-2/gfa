import { useEffect, useRef, useState } from 'react'

import { useAppStore } from '@/stores/useAppStore'
import { selectFreshTransient } from '@/lib/toast-select'

type ActiveToast = { key: string; message: string }

/**
 * Bottom-right transient toasts for self-healing notifications (quota cooldown,
 * report backlog, transient upstream). Block-level errors get the persistent
 * banner instead. Dedup is handled by selectFreshTransient since GetStats is
 * polled every 2s; each toast auto-dismisses after 5s.
 */
export function ToastHost() {
  const notifications = useAppStore((s) => s.notifications)
  const [toasts, setToasts] = useState<ActiveToast[]>([])
  const shownRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const { fresh, nextShown } = selectFreshTransient(notifications, shownRef.current)
    shownRef.current = nextShown
    if (fresh.length === 0) return
    setToasts((prev) => [...prev, ...fresh.map((f) => ({ key: f.dedupKey, message: f.message }))])
    fresh.forEach((f) => {
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.key !== f.dedupKey)), 5000)
    })
  }, [notifications])

  if (toasts.length === 0) return null
  return (
    <div className="fixed bottom-4 right-4 z-[var(--z-toast)] flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.key}
          className="max-w-[320px] rounded-[12px] border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2.5 text-[13px] text-[var(--text-secondary)] shadow-[var(--shadow-md)] flex items-start gap-2"
        >
          <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--warning)]" />
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  )
}
