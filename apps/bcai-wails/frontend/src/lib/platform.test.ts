import { describe, expect, it } from 'vitest'

import { isMacFromPlatform } from './platform'

// 平台判定要在两种 webview 下都对:Windows 端 Wails = WebView2(Chromium,有 UA-CH),
// macOS 端 Wails = WKWebView(Safari,无 UA-CH)。
describe('isMacFromPlatform — 跨 webview 的平台判定', () => {
  it('UA-CH 报 Windows 时判为非 mac', () => {
    expect(isMacFromPlatform('Windows', 'Win32')).toBe(false)
  })

  it('UA-CH 报 macOS 时判为 mac', () => {
    expect(isMacFromPlatform('macOS', 'MacIntel')).toBe(true)
  })

  // 关键回归:macOS 端无 UA-CH(userAgentData 为 undefined),必须回退 legacy navigator.platform,
  // 否则 mac 会被误判成非 mac,macOS 专属权限引导会静默消失。
  it('无 UA-CH 时回退 legacy platform,MacIntel 仍判为 mac', () => {
    expect(isMacFromPlatform(undefined, 'MacIntel')).toBe(true)
  })

  it('无 UA-CH 且 legacy 为 Win32 判为非 mac', () => {
    expect(isMacFromPlatform(undefined, 'Win32')).toBe(false)
  })

  it('两者都缺失时安全判为非 mac(不误报)', () => {
    expect(isMacFromPlatform(undefined, undefined)).toBe(false)
  })
})
