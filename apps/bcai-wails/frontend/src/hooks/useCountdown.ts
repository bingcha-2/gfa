import { useState, useEffect } from 'react'
import { formatCountdown } from '@/lib/utils'

/**
 * 倒计时 Hook
 * @param remainingMs 剩余毫秒数（从外部传入，每次 stats 刷新更新）
 * @returns 格式化的倒计时字符串 + 百分比
 */
export function useCountdown(remainingMs: number) {
  const [display, setDisplay] = useState('')
  const [percent, setPercent] = useState(0)

  useEffect(() => {
    const FIVE_HOURS = 5 * 3600 * 1000

    if (remainingMs <= 0) {
      setDisplay('已恢复')
      setPercent(100)
      return
    }

    setDisplay(formatCountdown(remainingMs))
    setPercent(Math.min(100, ((FIVE_HOURS - remainingMs) / FIVE_HOURS) * 100))

    const id = setInterval(() => {
      const now = remainingMs - 1000
      if (now <= 0) {
        setDisplay('已恢复')
        setPercent(100)
        clearInterval(id)
      } else {
        setDisplay(formatCountdown(now))
        setPercent(Math.min(100, ((FIVE_HOURS - now) / FIVE_HOURS) * 100))
      }
    }, 1000)

    return () => clearInterval(id)
  }, [remainingMs])

  return { display, percent, isDone: remainingMs <= 0 }
}
