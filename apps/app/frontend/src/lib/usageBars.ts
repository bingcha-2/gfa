const PRODUCT_LABEL: Record<string, string> = {
  antigravity: 'Antigravity',
  codex: 'Codex',
  anthropic: 'Anthropic',
}

/** 产品轴 → 展示名。归一 legacy 'claude' → anthropic；未知值原样返回。 */
export function productLabel(product: string): string {
  const normalized = product === 'claude' ? 'anthropic' : product
  return PRODUCT_LABEL[normalized] || product
}
