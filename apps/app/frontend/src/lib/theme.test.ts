import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getThemePreference, initTheme, setTheme } from './theme'

let dark = false
let listeners: Set<() => void>
function changeSystemTheme(next: boolean) {
  dark = next
  listeners.forEach(listener => listener())
}

beforeEach(() => {
  localStorage.removeItem('bcai_theme_preference')
  localStorage.removeItem('bcai_theme')
  document.documentElement.classList.remove('dark')
  dark = false
  listeners = new Set()
  const media = {
    get matches() { return dark },
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
  }
  vi.stubGlobal('matchMedia', vi.fn(() => media))
})
afterEach(() => vi.unstubAllGlobals())

describe('system appearance', () => {
  it('defaults to white on a light system and migrates the former dark default', () => {
    localStorage.setItem('bcai_theme', 'dark')
    expect(getThemePreference()).toBe('system')
    expect(initTheme()).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.style.colorScheme).toBe('light')
  })
  it('starts dark when the operating system is dark', () => {
    dark = true
    expect(initTheme()).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })
  it('tracks system changes while running', () => {
    initTheme()
    changeSystemTheme(true)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    changeSystemTheme(false)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
  it('keeps an explicit choice until system mode is selected again', () => {
    initTheme()
    setTheme('light')
    changeSystemTheme(true)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(initTheme()).toBe('light')
    setTheme('system')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    changeSystemTheme(false)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
  it('does not accumulate listeners on repeated initialization', () => {
    initTheme()
    initTheme()
    expect(listeners.size).toBe(1)
  })
  it('falls back to white when system appearance cannot be queried', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(initTheme()).toBe('light')
  })
})
