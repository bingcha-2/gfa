import type { AccountSubscription } from '@/types'
import type { ModelUsageStats } from './usageSummary'

export const PRODUCT_NAMES: Record<string, string> = { anthropic: 'Claude', codex: 'Codex', antigravity: 'Antigravity' }
export function activeProducts(subscriptions: AccountSubscription[], now = Date.now()) {
  return Object.keys(PRODUCT_NAMES).filter(product => subscriptions.some(sub => sub.status.toUpperCase() === 'ACTIVE' && (!sub.expiresAt || Date.parse(sub.expiresAt) > now) && sub.products.includes(product)))
}
export function modelProduct(model: ModelUsageStats) {
  const family = (model.family || '').toLowerCase()
  const key = (model.modelKey || '').toLowerCase()
  if (family === 'codex' || family === 'openai' || /^(gpt-|o[134](?:-|$)|codex)/.test(key)) return 'codex'
  if (family === 'claude' || family === 'anthropic' || key.startsWith('claude-')) return 'anthropic'
  if (family === 'gemini' || family === 'antigravity' || key.startsWith('gemini-')) return 'antigravity'
  return null
}
export function productModels(byModel: Record<string, ModelUsageStats> | undefined, product: string) {
  return Object.values(byModel || {}).filter(model => modelProduct(model) === product)
}
export function sumModels(models: ModelUsageStats[]) {
  return models.reduce((total, m) => ({
    inputTokens: total.inputTokens + (m.inputTokens || 0), outputTokens: total.outputTokens + (m.outputTokens || 0),
    cachedTokens: total.cachedTokens + (m.cachedTokens || 0), cacheWriteTokens: total.cacheWriteTokens + (m.cacheWriteTokens || 0),
    requests: total.requests + (m.requests || 0),
  }), { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, requests: 0 })
}
