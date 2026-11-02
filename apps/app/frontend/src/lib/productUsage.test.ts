import { describe, expect, it } from 'vitest'
import { activeProducts, productModels, sumModels } from './productUsage'
import { quotaColor } from './quotaDisplay'
describe('product usage isolation', () => {
 it('combines valid subscriptions and excludes expired products', () => {
  expect(activeProducts([{ status: 'ACTIVE', expiresAt: '', products: ['anthropic'] }, { status: 'ACTIVE', expiresAt: '2030-01-01', products: ['codex'] }, { status: 'ACTIVE', expiresAt: '2020-01-01', products: ['antigravity'] }] as any, Date.parse('2026-11-02'))).toEqual(['anthropic', 'codex'])
 })
 it('does not count another product or unknown model as Codex', () => {
  const rows = productModels({ a: {modelKey:'gpt-5',inputTokens:10}, b:{modelKey:'claude-sonnet',inputTokens:900}, c:{modelKey:'unknown',inputTokens:1000} }, 'codex')
  expect(sumModels(rows).inputTokens).toBe(10)
 })
 it('uses green for ample quota and red only below 15 percent', () => {
  expect(quotaColor(100)).toBe('var(--success)'); expect(quotaColor(40)).toBe('var(--success)')
  expect(quotaColor(39)).toBe('var(--warning)'); expect(quotaColor(15)).toBe('var(--warning)'); expect(quotaColor(14)).toBe('var(--danger)')
 })
})
