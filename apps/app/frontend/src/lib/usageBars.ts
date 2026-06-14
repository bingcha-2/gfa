// Blood-bar specs for a card, keyed by the composite `<product>-<family>` bucket
// (matches the server + Go client; see product_bucket.go / product-bucket.ts).
// The product prefix keeps antigravity's Claude and anthropic's Claude as two
// distinct bars instead of one conflated "Opus" bar.

export type Family = 'gemini' | 'claude' | 'gpt'

export interface BarSpec {
  /** Composite bucket key for bucketFractions / bucketResetMs lookup. */
  bucket: string
  family: Family
  label: string
}

const FAMILIES_BY_PRODUCT: Record<string, Family[]> = {
  antigravity: ['gemini', 'claude'],
  codex: ['gpt'],
  anthropic: ['claude'],
}

const PRODUCT_LABEL: Record<string, string> = {
  antigravity: 'Antigravity',
  codex: 'Codex',
  anthropic: 'Anthropic',
}

/** 产品轴 → 展示名。归一 legacy 'claude' → anthropic;未知值原样返回。 */
export function productLabel(product: string): string {
  const p = product === 'claude' ? 'anthropic' : product
  return PRODUCT_LABEL[p] || product
}

// 模型(family)显示名。血条颜色不在这里定 —— 一律由健康度(充足/一般/紧张/已用尽)
// 决定(见 UsageBar),不靠每个模型一种彩色区分,区分交给「产品名 · 模型」标签文字。
const FAMILY_META: Record<Family, { label: string }> = {
  gemini: { label: 'Gemini' },
  claude: { label: 'Claude' },
  gpt: { label: 'GPT' },
}

const ALL_PRODUCTS = ['antigravity', 'codex', 'anthropic']

/**
 * Which model-usage bars to show for a card, as composite buckets. A pool card
 * (no products) shows every product's buckets. 每条血条统一用「产品名 · 模型」格式
 * (Anthropic · Claude / Codex · GPT / Antigravity · Gemini / Antigravity · Claude),
 * 既消除同家族(antigravity 与 anthropic 的 Claude)歧义,也和卡产品轴 anthropic 对齐。
 */
export function usageBarsForProducts(products: string[] | undefined): BarSpec[] {
  // Compat: older cards/caches may still carry the pre-rename 'claude' product.
  const normalized = (products || []).map((p) => (p === 'claude' ? 'anthropic' : p))
  const src = normalized.length ? normalized : ALL_PRODUCTS

  const specs: BarSpec[] = []
  const seenBucket = new Set<string>()
  for (const p of src) {
    for (const family of FAMILIES_BY_PRODUCT[p] || []) {
      const bucket = `${p}-${family}`
      if (seenBucket.has(bucket)) continue
      seenBucket.add(bucket)
      const label = `${PRODUCT_LABEL[p] || p} · ${FAMILY_META[family].label}`
      specs.push({ bucket, family, label })
    }
  }
  return specs
}
