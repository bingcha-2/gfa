import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
const { state } = vi.hoisted(() => ({ state: { account: { subscriptions: [
  { id: 'claude', status: 'ACTIVE', expiresAt: '', priority: 0, products: ['anthropic'] },
  { id: 'codex', status: 'ACTIVE', expiresAt: '', priority: 1, products: ['codex'], usdQuotaByProduct: { codex: { fiveHour: { used: 20, limit: 100 } } } },
] }, gateway: { configured: true, subscriptionValid: true, enabled: true, upstreamEnabled: true, limitUsd: 165, remainingUsd: 165, windows: [{ period: "7d", state: "limited", remaining: 1, resetAt: null }], totalUsedUsd: .00005 }, todayByModel: {
 gpt: { modelKey: 'gpt-5', family: 'codex', requests: 2, inputTokens: 123 },
 claude: { modelKey: 'claude-haiku-4-5', family: 'claude', requests: 9, inputTokens: 9999 },
}, dailyHistory: [], heartbeat: vi.fn() } }))
vi.mock('@/stores/useAppStore', () => ({ useAppStore: () => state }))
vi.mock('@/components/UsageTrendChart', () => ({ UsageTrendChart: () => <div>趋势图</div> }))
import { DashboardPage } from './DashboardPage'
afterEach(cleanup)
describe('multiple subscriptions', () => {
 it('switches between Claude and Codex without mixing usage or exposing internal limits', () => {
  const { container } = render(<DashboardPage />)
  expect(screen.getByRole('progressbar', { name: 'Claude 每周剩余额度' })).toHaveAttribute('aria-valuenow', '100')
  expect(container.textContent).not.toMatch(/165.00|本周期上限|CardUsageHourly/)
  fireEvent.click(screen.getByRole('button', { name: 'Codex' }))
  expect(screen.queryByRole('progressbar', { name: 'Claude 每周剩余额度' })).toBeNull()
  expect(screen.getByRole('progressbar', { name: '5 小时额度剩余' })).toHaveAttribute('aria-valuenow', '80')
  expect(within(screen.getByRole('table')).getByText('gpt-5')).toBeTruthy()
  expect(screen.queryByText('claude-haiku-4-5')).toBeNull()
  expect(screen.queryByText('9999')).toBeNull()
  expect(container.textContent).not.toMatch(/165.00|本周期上限|CardUsageHourly/)
  fireEvent.click(screen.getByRole('button', { name: 'Claude' }))
  expect(screen.getByRole('progressbar', { name: 'Claude 每周剩余额度' })).toBeTruthy()
 })
})
