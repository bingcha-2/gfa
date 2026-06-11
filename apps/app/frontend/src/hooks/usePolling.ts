import { useEffect, useRef, useCallback } from 'react'

/**
 * 通用轮询 Hook（串行模式）
 * 
 * 使用 setTimeout 而非 setInterval：
 * - 等待上一次 fn() 完成后，再等 intervalMs 才发起下一次
 * - 避免后端响应慢时请求堆积，防止 Wails IPC 阻塞导致界面卡死
 * 
 * @param fn 要轮询的异步函数
 * @param intervalMs 两次调用之间的间隔毫秒（在上一次完成后开始计时）
 * @param enabled 是否启用
 */
export function usePolling(fn: () => Promise<unknown> | unknown, intervalMs: number, enabled = true) {
  const savedFn = useRef(fn)
  savedFn.current = fn

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  const scheduleNext = useCallback(() => {
    if (!mountedRef.current) return
    timerRef.current = setTimeout(async () => {
      if (!mountedRef.current) return
      try {
        await savedFn.current()
      } catch {
        // silent — individual stores handle their own errors
      }
      // 完成后再调度下一次
      if (mountedRef.current) {
        scheduleNext()
      }
    }, intervalMs)
  }, [intervalMs])

  useEffect(() => {
    if (!enabled) return

    mountedRef.current = true

    // 立即执行一次，完成后开始轮询链
    const run = async () => {
      try {
        await savedFn.current()
      } catch {
        // silent
      }
      if (mountedRef.current) {
        scheduleNext()
      }
    }
    run()

    return () => {
      mountedRef.current = false
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [intervalMs, enabled, scheduleNext])
}
