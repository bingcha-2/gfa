import { useEffect, useRef, useState } from 'react'
import { subscribeCelebrate } from '@/lib/exclusiveEasterEgg'

// 「滑跪感谢金主大大」单例动效:皇冠彩蛋觉醒的那一刻,一个小人从左侧滑跪冲入,身后拖出
// 尘土速度线,头顶弹出金色横幅「感谢金主大大」,停留片刻后滑出屏幕。根级挂载一个即可
// (由 subscribeCelebrate 驱动),即便同屏多张独享卡同时觉醒也只播一次。

const STYLE_ID = 'bcai-patron-thanks-style'
const DURATION_MS = 3200

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = `
@keyframes bcai-patron-figure {
  0%   { transform: translateX(-220%) rotate(-12deg); opacity: 0; }
  16%  { transform: translateX(0) rotate(0deg); opacity: 1; }
  20%  { transform: translateX(6%) rotate(3deg); }
  25%  { transform: translateX(0) rotate(0deg); }
  80%  { transform: translateX(0) rotate(0deg); opacity: 1; }
  100% { transform: translateX(240%) rotate(12deg); opacity: 0; }
}
@keyframes bcai-patron-banner {
  0%,14% { transform: translateY(8px) scale(0.3); opacity: 0; }
  22%    { transform: translateY(0) scale(1.15); opacity: 1; }
  28%    { transform: translateY(0) scale(1); }
  80%    { opacity: 1; }
  100%   { transform: translateY(-6px) scale(0.9); opacity: 0; }
}
@keyframes bcai-patron-dust {
  0%,10% { transform: scaleX(0.2); opacity: 0; }
  18%    { transform: scaleX(1); opacity: 0.85; }
  34%    { transform: scaleX(1.5) translateX(-20px); opacity: 0; }
  100%   { opacity: 0; }
}`
  document.head.appendChild(el)
}

export function PatronThanks() {
  const [playing, setPlaying] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    ensureStyle()
    const unsub = subscribeCelebrate(() => {
      setPlaying(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setPlaying(false), DURATION_MS)
    })
    return () => {
      unsub()
      window.clearTimeout(timer.current)
    }
  }, [])

  if (!playing) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[12%] z-[60] flex justify-center">
      <div
        className="relative flex flex-col items-center"
        style={{ animation: `bcai-patron-figure ${DURATION_MS}ms cubic-bezier(0.16, 1, 0.3, 1) forwards` }}
      >
        <div
          className="mb-1 whitespace-nowrap rounded-full border border-amber-400/60 bg-gradient-to-r from-amber-400 to-yellow-300 px-3.5 py-1 text-[13px] font-bold text-amber-900 shadow-[0_6px_20px_rgba(245,158,11,0.5)]"
          style={{ animation: `bcai-patron-banner ${DURATION_MS}ms ease-out forwards` }}
        >
          🙏 感谢金主大大 ✨
        </div>
        <div className="relative">
          <span
            aria-hidden
            className="absolute right-full top-1/2 h-1.5 w-12 -translate-y-1/2 origin-right rounded-full bg-gradient-to-l from-amber-300/80 to-transparent"
            style={{ animation: `bcai-patron-dust ${DURATION_MS}ms ease-out forwards` }}
          />
          <span className="block text-[52px] leading-none drop-shadow-[0_3px_6px_rgba(0,0,0,0.25)]">🧎</span>
        </div>
      </div>
    </div>
  )
}
