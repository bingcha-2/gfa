// 平台判定。优先 User-Agent Client Hints(navigator.userAgentData.platform,值如 "Windows"/"macOS"),
// 它是已弃用的 navigator.platform 的现代替代。
//
// ⚠ 但 UA-CH 仅 Chromium 系实现:Windows 端 Wails = WebView2(Chromium)有;macOS 端 Wails =
// WKWebView(Safari)【没有】,navigator.userAgentData 为 undefined。所以必须回退到 legacy
// navigator.platform("MacIntel"/"Win32"),否则 mac 会被误判成非 mac、macOS 专属权限引导静默消失。
// /mac/i 同时覆盖 "macOS"(UA-CH)与 "MacIntel"(legacy)两种写法。

// 纯判定逻辑,与 navigator 解耦,便于单测两种 webview 的取值组合。
export function isMacFromPlatform(
  uaPlatform: string | undefined,
  legacyPlatform: string | undefined,
): boolean {
  return /mac/i.test(uaPlatform || legacyPlatform || '')
}

// 读取当前运行环境的平台并判定是否 macOS。
export function isMacPlatform(): boolean {
  const uaPlatform = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData?.platform
  // 用窄类型读取 legacy 字段,显式表明这是有意的回退(规避 navigator.platform 的 deprecated 提示)。
  const legacyPlatform = (navigator as { platform?: string }).platform
  return isMacFromPlatform(uaPlatform, legacyPlatform)
}

// 纯判定逻辑:是否 Windows。/win/i 覆盖 "Windows"(UA-CH)与 "Win32"(legacy)。
export function isWindowsFromPlatform(
  uaPlatform: string | undefined,
  legacyPlatform: string | undefined,
): boolean {
  return /win/i.test(uaPlatform || legacyPlatform || '')
}

// 读取当前运行环境的平台并判定是否 Windows。
export function isWindowsPlatform(): boolean {
  const uaPlatform = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData?.platform
  const legacyPlatform = (navigator as { platform?: string }).platform
  return isWindowsFromPlatform(uaPlatform, legacyPlatform)
}
