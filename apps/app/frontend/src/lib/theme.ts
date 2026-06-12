/**
 * 主题(明/暗)管理。Wails 桌面端无 next-themes,这里用最小实现:
 *   • 深色优先:读不到本地偏好(新用户)时默认深色,与官网 / 用户中心一致;之后记住选择。
 *   • 通过给 <html> 加/去 `.dark` 类切换(Tailwind darkMode: 'class')。
 *   • applyTheme 在渲染前调用(main.tsx),避免首帧闪烁。
 */

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'bcai_theme'

/** 读取生效主题:用户已选 → 用之;否则深色优先(与 web 端统一品牌观感)。 */
export function getTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch { /* localStorage 不可用时降级到深色 */ }
  return 'dark'
}

/** 把主题落到 DOM(加/去 .dark)。 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
}

/** 持久化并应用。 */
export function setTheme(theme: Theme): void {
  try { localStorage.setItem(STORAGE_KEY, theme) } catch { /* ignore */ }
  applyTheme(theme)
}

/** 初始化:渲染前调用一次。 */
export function initTheme(): Theme {
  const t = getTheme()
  applyTheme(t)
  return t
}
