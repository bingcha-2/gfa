import '@testing-library/jest-dom/vitest'

// 测试一律跑简体中文文案(测试断言均为 zh-CN 字符串;jsdom 的 navigator.language 是 en-US)
const storage = globalThis.localStorage
if (typeof storage?.setItem === 'function') {
  storage.setItem('bcai_locale', 'zh-CN')
} else {
  const values = new Map<string, string>([['bcai_locale', 'zh-CN']])
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, String(value)) },
      removeItem: (key: string) => { values.delete(key) },
      clear: () => { values.clear() },
    },
  })
}
