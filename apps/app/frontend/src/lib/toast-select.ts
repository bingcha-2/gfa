export type ToastInput = { level: string; dedupKey: string; message: string }

/**
 * Pick the transient notifications to toast given the keys already shown.
 * GetStats is polled every 2s and re-sends persisting notifications, so we must
 * dedup: a notification toasts once, then stays in `shown` until it clears. Keys
 * whose notification has disappeared are forgotten, so a recurrence toasts again.
 */
export function selectFreshTransient(
  notifications: ToastInput[],
  shown: Set<string>,
): { fresh: { dedupKey: string; message: string }[]; nextShown: Set<string> } {
  const active = new Set(notifications.map((n) => n.dedupKey))
  const nextShown = new Set<string>()
  shown.forEach((k) => {
    if (active.has(k)) nextShown.add(k)
  })
  const fresh = notifications
    .filter((notif) => notif.level === 'transient' && !nextShown.has(notif.dedupKey))
    .map((notif) => ({ dedupKey: notif.dedupKey, message: notif.message }))
  fresh.forEach((f) => nextShown.add(f.dedupKey))
  return { fresh, nextShown }
}
