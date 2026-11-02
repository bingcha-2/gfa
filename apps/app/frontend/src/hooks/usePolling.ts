import { useEffect, useRef } from 'react'

/** Serial polling; an obsolete effect may finish its request but never restart its timer chain. */
export function usePolling(fn: () => Promise<unknown> | unknown, intervalMs: number, enabled = true) {
  const savedFn = useRef(fn)
  savedFn.current = fn
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = async () => {
      try { await savedFn.current() } catch { /* errors are handled by the caller */ }
      if (!cancelled) timer = setTimeout(run, intervalMs)
    }
    void run()
    return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer) }
  }, [intervalMs, enabled])
}
