import { describe, expect, it } from 'vitest'

import { productLabel } from './usageBars'

describe('productLabel', () => {
  it('uses product-axis labels and normalizes legacy claude', () => {
    expect(productLabel('codex')).toBe('Codex')
    expect(productLabel('anthropic')).toBe('Anthropic')
    expect(productLabel('claude')).toBe('Anthropic')
    expect(productLabel('antigravity')).toBe('Antigravity')
    expect(productLabel('custom')).toBe('custom')
  })
})
