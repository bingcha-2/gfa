/** System appearance is the default; explicit light/dark choices are optional. */
export type Theme = 'light' | 'dark'
export type ThemePreference = Theme | 'system'

// The old key defaulted to dark and cannot distinguish an explicit user choice
// from a value written on mount. Start those installations in system mode too.
const STORAGE_KEY = 'bcai_theme_preference'
let stopListening: (() => void) | undefined

export function getThemePreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
  } catch { /* System appearance also works without persistent storage. */ }
  return 'system'
}

export function getTheme(): Theme {
  const preference = getThemePreference()
  if (preference !== 'system') return preference
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  document.documentElement.style.colorScheme = theme
}

export function setTheme(preference: ThemePreference): void {
  try { localStorage.setItem(STORAGE_KEY, preference) } catch { /* Apply this choice for the current page. */ }
  applyTheme(preference === 'system'
    ? (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : preference)
}

/** Apply before rendering, then follow OS changes without requiring a restart. */
export function initTheme(): Theme {
  stopListening?.()
  const theme = getTheme()
  applyTheme(theme)
  if (typeof window.matchMedia === 'function') {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      if (getThemePreference() === 'system') applyTheme(media.matches ? 'dark' : 'light')
    }
    media.addEventListener('change', onChange)
    stopListening = () => media.removeEventListener('change', onChange)
  }
  return theme
}
