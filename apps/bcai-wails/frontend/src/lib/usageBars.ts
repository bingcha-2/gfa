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
  color: string
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

const FAMILY_META: Record<Family, { label: string; color: string }> = {
  gemini: { label: 'Gemini', color: 'bg-[var(--accent)]' },
  claude: { label: 'Claude (Opus)', color: 'bg-purple-500' },
  gpt: { label: 'Codex', color: 'bg-emerald-500' },
}

const ALL_PRODUCTS = ['antigravity', 'codex', 'anthropic']

/**
 * Which model-usage bars to show for a card, as composite buckets. A pool card
 * (no products) shows every product's buckets. When the same family appears
 * under more than one product (Claude via antigravity AND anthropic), each bar's
 * label is prefixed with its product so the two stay distinguishable.
 */
export function usageBarsForProducts(products: string[] | undefined): BarSpec[] {
  // Compat: older cards/caches may still carry the pre-rename 'claude' product.
  const normalized = (products || []).map((p) => (p === 'claude' ? 'anthropic' : p))
  const src = normalized.length ? normalized : ALL_PRODUCTS

  const specs: BarSpec[] = []
  const seenBucket = new Set<string>()
  const familyCount: Record<string, number> = {}
  for (const p of src) {
    for (const family of FAMILIES_BY_PRODUCT[p] || []) {
      const bucket = `${p}-${family}`
      if (seenBucket.has(bucket)) continue
      seenBucket.add(bucket)
      familyCount[family] = (familyCount[family] || 0) + 1
      const meta = FAMILY_META[family]
      specs.push({ bucket, family, label: meta.label, color: meta.color })
    }
  }
  // Disambiguate same-family bars by prefixing the product label.
  for (const s of specs) {
    if (familyCount[s.family] > 1) {
      const product = s.bucket.slice(0, s.bucket.indexOf('-'))
      s.label = `${PRODUCT_LABEL[product] || product} · ${FAMILY_META[s.family].label}`
    }
  }
  return specs
}
