import '@testing-library/jest-dom/vitest'

// 测试一律跑简体中文文案(测试断言均为 zh-CN 字符串;jsdom 的 navigator.language 是 en-US)
localStorage.setItem('bcai_locale', 'zh-CN')
