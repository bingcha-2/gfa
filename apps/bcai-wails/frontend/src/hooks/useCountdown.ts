import { useState, useEffect } from 'react'
import { formatCountdown } from '@/lib/utils'
import { t } from '@/i18n'

/**
 * 倒计时 Hook
 * @param remainingMs 剩余毫秒数（从外部传入，每次 stats 刷新更新）
 * @param totalMs 窗口总时长，用于计算进度百分比（默认 5h，可由服务端按卡密配置下发）
 * @returns 格式化的倒计时字符串 + 百分比
 */
export function useCountdown(remainingMs: number, totalMs = 5 * 3600 * 1000) {
  const [display, setDisplay] = useState('')
  const [percent, setPercent] = useState(0)

  useEffect(() => {
    const total = totalMs > 0 ? totalMs : 5 * 3600 * 1000

    if (remainingMs <= 0) {
      setDisplay(t('time.recovered'))
      setPercent(100)
      return
    }

    setDisplay(formatCountdown(remainingMs))
    setPercent(Math.min(100, ((total - remainingMs) / total) * 100))

    const id = setInterval(() => {
      const now = remainingMs - 1000
      if (now <= 0) {
        setDisplay(t('time.recovered'))
        setPercent(100)
        clearInterval(id)
      } else {
        setDisplay(formatCountdown(now))
        setPercent(Math.min(100, ((total - now) / total) * 100))
      }
    }, 1000)

    return () => clearInterval(id)
  }, [remainingMs, totalMs])

  return { display, percent, isDone: remainingMs <= 0 }
}
