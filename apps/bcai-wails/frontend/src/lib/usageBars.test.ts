import { describe, expect, it } from 'vitest'

import { usageBarsForProducts } from './usageBars'

const buckets = (products: string[] | undefined) =>
  usageBarsForProducts(products).map((b) => b.bucket)

describe('usageBarsForProducts', () => {
  it('shows every product bucket for a pool card (no products)', () => {
    const expected = ['antigravity-gemini', 'antigravity-claude', 'codex-gpt', 'anthropic-claude']
    expect(buckets(undefined)).toEqual(expected)
    expect(buckets([])).toEqual(expected)
  })

  it('shows only codex-gpt for a codex-bound card', () => {
    expect(buckets(['codex'])).toEqual(['codex-gpt'])
  })

  it('shows antigravity-gemini + antigravity-claude for an antigravity card', () => {
    expect(buckets(['antigravity'])).toEqual(['antigravity-gemini', 'antigravity-claude'])
  })

  it('shows anthropic-claude for an anthropic-bound card', () => {
    expect(buckets(['anthropic'])).toEqual(['anthropic-claude'])
  })

  it('shows anthropic-claude + codex-gpt for an anthropic+codex card', () => {
    expect(buckets(['anthropic', 'codex'])).toEqual(['anthropic-claude', 'codex-gpt'])
  })

  it('normalizes a legacy claude product value to anthropic', () => {
    expect(buckets(['claude'])).toEqual(['anthropic-claude'])
  })

  it('disambiguates same-family bars by product when a card covers antigravity AND anthropic', () => {
    const bars = usageBarsForProducts(['antigravity', 'anthropic'])
    expect(bars.map((b) => b.bucket)).toEqual([
      'antigravity-gemini',
      'antigravity-claude',
      'anthropic-claude',
    ])
    const anti = bars.find((b) => b.bucket === 'antigravity-claude')!
    const anth = bars.find((b) => b.bucket === 'anthropic-claude')!
    expect(anti.label).toContain('Antigravity')
    expect(anth.label).toContain('Anthropic')
    expect(anti.label).not.toBe(anth.label)
  })

  it('does not prefix the lone claude bar on a single-product card', () => {
    expect(usageBarsForProducts(['anthropic'])[0].label).toBe('Claude (Opus)')
  })
})
