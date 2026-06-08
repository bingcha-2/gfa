import { useAppStore } from '@/stores/useAppStore'

/**
 * Persistent banner for "block" notifications — errors the user must act on
 * (dead bound account, proxy not configured, port busy). These previously had
 * NO place in the GUI (Claude/Codex lease errors were never surfaced); the Go
 * side now funnels every leaser's lastError into `notifications`. Self-healing
 * "transient" errors are intentionally not shown here so they don't nag.
 */
export function NotificationBanner() {
  const notifications = useAppStore((s) => s.notifications)
  const blocking = notifications.filter((n) => n.level === 'block')
  if (blocking.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      {blocking.map((n) => (
        <div
          key={n.dedupKey}
          className="rounded-[10px] border border-[var(--danger)] bg-[var(--danger)]/5 px-4 py-3"
        >
          <div className="text-sm font-medium text-[var(--danger)]">{n.message}</div>
        </div>
      ))}
    </div>
  )
}
