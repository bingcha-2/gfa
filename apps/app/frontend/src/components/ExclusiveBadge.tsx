import { useEffect, useRef, useState } from 'react'
import { Crown } from 'lucide-react'
import {
  EXCLUSIVE_AWAKEN_THRESHOLD,
  awaken,
  awakenRemainingMs,
  isAwakened,
  subscribe,
} from '@/lib/exclusiveEasterEgg'

// 「尊贵·独享」皇冠 badge + 隐藏彩蛋:连点充能(辉光随点击变强 + 每下一个小弹跳),点满觉醒 →
// 抖一下 + 迸金色纸屑 + 文案临时变「氪金之王 金主大大」持续 1 分钟。觉醒态跨实例同步、跨刷新保持。

type Particle = { id: number; dx: number; dy: number; rot: number; delay: number; color: string }

const STYLE_ID = 'bcai-exclusive-egg-style'
function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = `
@keyframes bcai-egg-shake {
  0%,100% { transform: translateX(0) rotate(0); }
  20% { transform: translateX(-2px) rotate(-4deg); }
  40% { transform: translateX(2px) rotate(4deg); }
  60% { transform: translateX(-1px) rotate(-2deg); }
  80% { transform: translateX(1px) rotate(2deg); }
}
@keyframes bcai-egg-confetti {
  0% { transform: translate(0,0) rotate(0); opacity: 1; }
  100% { transform: translate(var(--dx), var(--dy)) rotate(var(--rot)); opacity: 0; }
}
@keyframes bcai-egg-bump {
  0% { transform: scale(1); }
  50% { transform: scale(1.14); }
  100% { transform: scale(1); }
}`
  document.head.appendChild(el)
}

// 觉醒态订阅 hook:任一 badge 觉醒会广播到全部实例;到期后定时回落。
function useAwakened(): boolean {
  const [tick, setTick] = useState(0)
  useEffect(() => subscribe(() => setTick((t) => t + 1)), [])
  useEffect(() => {
    const remaining = awakenRemainingMs()
    if (remaining <= 0) return
    const id = window.setTimeout(() => setTick((t) => t + 1), remaining + 50)
    return () => window.clearTimeout(id)
  }, [tick])
  return isAwakened()
}

const CONFETTI_COLORS = ['#fbbf24', '#f59e0b', '#fcd34d', '#fde68a', '#eab308']
function makeParticles(): Particle[] {
  return Array.from({ length: 18 }, (_, i) => ({
    id: i,
    dx: Math.random() * 120 - 60,
    dy: 48 + Math.random() * 72,
    rot: Math.random() * 720 - 360,
    delay: Math.random() * 90,
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
  }))
}

export function ExclusiveBadge() {
  const awakened = useAwakened()
  const [charge, setCharge] = useState(0)
  const [shaking, setShaking] = useState(false)
  const [bumping, setBumping] = useState(false)
  const [burst, setBurst] = useState<Particle[] | null>(null)
  const timers = useRef<number[]>([])

  useEffect(() => {
    ensureStyle()
    return () => {
      timers.current.forEach((id) => window.clearTimeout(id))
    }
  }, [])

  const label = awakened ? '氪金之王 金主大大' : '尊贵 · 独享'

  // 充能感靠「辉光随点击变强 + 每下一个小弹跳」,不再用会漏色盖住文字的外圈渐变环。
  const glow = awakened
    ? '0 0 12px rgba(245,158,11,0.6)'
    : charge > 0
      ? `0 0 ${5 + charge * 3}px rgba(245,158,11,${0.2 + charge * 0.1})`
      : undefined
  const anim = shaking
    ? 'bcai-egg-shake 0.6s ease-in-out'
    : bumping
      ? 'bcai-egg-bump 0.17s ease-out'
      : undefined

  const handleClick = () => {
    if (awakened) return // 已觉醒,收下你的膜拜就好,别再点了
    setBumping(true)
    timers.current.push(window.setTimeout(() => setBumping(false), 170))
    const next = charge + 1
    if (next < EXCLUSIVE_AWAKEN_THRESHOLD) {
      setCharge(next)
      return
    }
    setCharge(0)
    awaken()
    setShaking(true)
    setBurst(makeParticles())
    timers.current.push(window.setTimeout(() => setShaking(false), 600))
    timers.current.push(window.setTimeout(() => setBurst(null), 1100))
  }

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={handleClick}
        title={label}
        aria-label={label}
        className={`relative inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold text-amber-500 select-none transition-[box-shadow] duration-150 ${
          awakened ? 'border-amber-400/70 bg-amber-400/20' : 'border-amber-400/40 bg-amber-400/10'
        }`}
        style={{ animation: anim, boxShadow: glow }}
      >
        <Crown size={11} /> {label}
      </button>
      {burst && (
        <span aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 z-10">
          {burst.map((p) => (
            <span
              key={p.id}
              className="absolute block h-1.5 w-1.5 rounded-[1px]"
              style={{
                backgroundColor: p.color,
                ['--dx' as string]: `${p.dx}px`,
                ['--dy' as string]: `${p.dy}px`,
                ['--rot' as string]: `${p.rot}deg`,
                animation: `bcai-egg-confetti 0.95s ease-out ${p.delay}ms forwards`,
              } as React.CSSProperties}
            />
          ))}
        </span>
      )}
    </span>
  )
}
