/**
 * 应用多语言。九种语言,简体中文为源语言/兜底。
 * - useT():组件内取翻译函数,语言切换时自动重渲(配合 App 根部 key={locale} 整树刷新)。
 * - t():非组件代码(lib/工具函数)直接调用,按当前语言取值。
 * - 语言持久化在 localStorage('bcai_locale'),默认简体中文;仅当用户手动切换后才改变。
 */

import { create } from 'zustand'
import { zhCN, type Dict } from './locales/zh-CN'
import { zhTW } from './locales/zh-TW'
import { en } from './locales/en'
import { ja } from './locales/ja'
import { ko } from './locales/ko'
import { es } from './locales/es'
import { fr } from './locales/fr'
import { de } from './locales/de'
import { vi } from './locales/vi'

export const SUPPORTED_LOCALES = [
  'zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'vi',
] as const

export type Locale = (typeof SUPPORTED_LOCALES)[number]

export const LOCALE_NAMES: Record<Locale, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  vi: 'Tiếng Việt',
}

const STORAGE_KEY = 'bcai_locale'

const RAW: Record<Locale, object> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  en,
  ja,
  ko,
  es,
  fr,
  de,
  vi,
}

function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(v)
}

/** 把系统语言标签归一到受支持语言;zh 系按 Hant/TW/HK/MO 细分繁简。 */
export function matchLocale(tag: string | undefined | null): Locale | null {
  if (!tag) return null
  if (isLocale(tag)) return tag
  const t = tag.toLowerCase()
  if (t.startsWith('zh')) {
    return /hant|tw|hk|mo/.test(t) ? 'zh-TW' : 'zh-CN'
  }
  const primary = t.split(/[-_]/)[0]
  const hit = SUPPORTED_LOCALES.find((l) => l.toLowerCase().split('-')[0] === primary)
  return hit ?? null
}

function detectLocale(): Locale {
  // 产品默认简体中文:只认用户手动切换后写入的 localStorage 选择,
  // 不按系统语言(navigator.language)自动匹配 —— 避免英文系统/webview 把首启误判成英文。
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (isLocale(stored)) return stored
  } catch { /* 无 localStorage 时忽略 */ }
  return 'zh-CN'
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 以简中为骨架深合并;数组整体替换,缺失键回退简中。 */
function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return patch === undefined ? base : (patch as T)
  }
  const out: Record<string, unknown> = { ...base }
  for (const key of Object.keys(base)) {
    if (key in patch) {
      out[key] = deepMerge((base as Record<string, unknown>)[key], patch[key])
    }
  }
  return out as T
}

const dictCache = new Map<Locale, Dict>()

export function getDict(locale: Locale): Dict {
  const hit = dictCache.get(locale)
  if (hit) return hit
  const merged = locale === 'zh-CN' ? zhCN : deepMerge(zhCN, RAW[locale])
  dictCache.set(locale, merged)
  return merged
}

interface LocaleState {
  locale: Locale
  setLocale: (l: Locale) => void
}

export const useLocaleStore = create<LocaleState>((set) => ({
  locale: detectLocale(),
  setLocale: (l) => {
    try { localStorage.setItem(STORAGE_KEY, l) } catch { /* ignore */ }
    set({ locale: l })
  },
}))

/** 取键路径('a.b.c')的字符串值并做 {x} 插值;键缺失时返回键名便于排查。 */
function lookup(dict: Dict, path: string): unknown {
  let cur: unknown = dict
  for (const part of path.split('.')) {
    if (!isPlainObject(cur)) return undefined
    cur = cur[part]
  }
  return cur
}

export function t(path: string, vars?: Record<string, string | number>): string {
  const dict = getDict(useLocaleStore.getState().locale)
  const value = lookup(dict, path)
  let str = typeof value === 'string' ? value : path
  if (vars) {
    str = str.replace(/\{(\w+)\}/g, (m, key) => (key in vars ? String(vars[key]) : m))
  }
  return str
}

/** 组件内使用:订阅语言变化,返回 t。App 根部以 key={locale} 整树重挂保证全量刷新。 */
export function useT() {
  useLocaleStore((s) => s.locale)
  return t
}

export function useLocale(): Locale {
  return useLocaleStore((s) => s.locale)
}
