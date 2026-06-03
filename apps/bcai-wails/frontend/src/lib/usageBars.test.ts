import { describe, expect, it } from 'vitest'

import { usageBarsForProducts } from './usageBars'

describe('usageBarsForProducts', () => {
  it('shows all three bars for a pool card (no products)', () => {
    expect(usageBarsForProducts(undefined)).toEqual({ opus: true, gemini: true, codex: true })
    expect(usageBarsForProducts([])).toEqual({ opus: true, gemini: true, codex: true })
  })

  it('shows only Codex for a codex-bound card', () => {
    expect(usageBarsForProducts(['codex'])).toEqual({ opus: false, gemini: false, codex: true })
  })

  it('shows Opus + Gemini for an antigravity-bound card (antigravity pool serves both)', () => {
    expect(usageBarsForProducts(['antigravity'])).toEqual({ opus: true, gemini: true, codex: false })
  })

  it('shows all three for a universal card bound to both pools', () => {
    expect(usageBarsForProducts(['codex', 'antigravity'])).toEqual({ opus: true, gemini: true, codex: true })
  })

  it('shows the Opus bar for a claude-bound card (Claude bills to the opus bucket)', () => {
    expect(usageBarsForProducts(['claude'])).toEqual({ opus: true, gemini: false, codex: false })
  })

  it('shows Opus + Codex for a claude+codex card', () => {
    expect(usageBarsForProducts(['claude', 'codex'])).toEqual({ opus: true, gemini: false, codex: true })
  })
})
