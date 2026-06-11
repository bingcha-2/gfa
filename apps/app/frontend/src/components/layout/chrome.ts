import { isMacPlatform } from '@/lib/platform'

/**
 * 窗口顶部度量(侧边栏与内容区共享,保证两栏分隔线对齐成一条贯通线)。
 *
 * macOS 用 TitleBarHiddenInset,红绿灯画在 webview 左上角(按钮簇约占 y 16-28px),
 * 顶部安全区必须 ≥ 簇底 + 呼吸空间;Windows/Linux 有原生标题栏,只留小量空气。
 *
 *   分隔线位置 = TOP_INSET + BAR_H
 *   mac: 44 + 48 = 92 · 其它: 16 + 48 = 64
 */
export const BAR_H = 48

export function topInset(): number {
  return isMacPlatform() ? 44 : 16
}
