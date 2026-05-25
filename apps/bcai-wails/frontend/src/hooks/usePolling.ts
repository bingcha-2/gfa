import { useEffect, useRef } from 'react'

/**
 * 通用轮询 Hook
 * @param fn 要轮询的异步函数
 * @param intervalMs 间隔毫秒
 * @param enabled 是否启用
 */
export function usePolling(fn: () => Promise<void> | void, intervalMs: number, enabled = true) {
  const savedFn = useRef(fn)
  savedFn.current = fn

  useEffect(() => {
    if (!enabled) return

    // 立即执行一次
    savedFn.current()

    const id = setInterval(() => savedFn.current(), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, enabled])
}
