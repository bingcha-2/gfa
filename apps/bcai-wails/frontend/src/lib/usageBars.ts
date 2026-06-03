export interface VisibleBars {
  opus: boolean
  gemini: boolean
  codex: boolean
}

/**
 * Which model-usage bars to show for a card. A pool card (no products) shows
 * all three. A bound card shows only the bars for the products it's sold for —
 * the antigravity pool serves both Claude/Opus and Gemini, codex serves Codex.
 */
export function usageBarsForProducts(products: string[] | undefined): VisibleBars {
  if (!products || products.length === 0) {
    return { opus: true, gemini: true, codex: true }
  }
  const anti = products.includes('antigravity')
  // Claude 也计入 opus 桶(与服务端 UNIVERSAL_BILLING 一致),所以 claude 卡显示 Opus 条。
  const claude = products.includes('claude')
  return { opus: anti || claude, gemini: anti, codex: products.includes('codex') }
}
