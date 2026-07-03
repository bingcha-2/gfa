// 「尊贵·独享」皇冠彩蛋:连点充能,点满 EXCLUSIVE_AWAKEN_THRESHOLD 下觉醒,文案临时变
// 「氪金之王 金主大大」并持续 EXCLUSIVE_AWAKEN_DURATION_MS。觉醒态用 localStorage 存到期时间戳,
// 刷新/重开仍在有效期内保持;过期自动回落。多个 badge 实例通过 subscribe 同步觉醒/回落。

const STORAGE_KEY = 'bcai.exclusive.awakenUntil'
export const EXCLUSIVE_AWAKEN_THRESHOLD = 6
export const EXCLUSIVE_AWAKEN_DURATION_MS = 60 * 1000 // 1 分钟

type Listener = () => void
const listeners = new Set<Listener>()
// 一次性「庆祝」通道:仅在真正触发觉醒(awaken)那一刻广播,用于播放「滑跪感谢金主大大」
// 单例动效。跟 listeners(状态同步:觉醒/回落/挂载恢复都会触发)区分开,避免刷新恢复时误播。
const celebrateListeners = new Set<Listener>()

function readUntil(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const n = raw ? Number(raw) : 0
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

/** 觉醒态剩余毫秒(过期或未觉醒 → 0)。 */
export function awakenRemainingMs(now = Date.now()): number {
  return Math.max(0, readUntil() - now)
}

/** 当前是否处于觉醒态。 */
export function isAwakened(now = Date.now()): boolean {
  return awakenRemainingMs(now) > 0
}

/** 触发觉醒:把到期时间设为 now + 时长,并广播给所有 badge 实例。 */
export function awaken(now = Date.now()): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(now + EXCLUSIVE_AWAKEN_DURATION_MS))
  } catch {
    // 无 localStorage(隐私模式等)也不该崩,本次会话仍可视为觉醒由调用方兜底。
  }
  listeners.forEach((fn) => fn())
  celebrateListeners.forEach((fn) => fn())
}

/** 订阅觉醒态变化(觉醒/回落),返回取消订阅函数。 */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** 订阅一次性「庆祝」事件(仅 awaken 那一刻),用于播放滑跪感谢动效。 */
export function subscribeCelebrate(fn: Listener): () => void {
  celebrateListeners.add(fn)
  return () => {
    celebrateListeners.delete(fn)
  }
}
