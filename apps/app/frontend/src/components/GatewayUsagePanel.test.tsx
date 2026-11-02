import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { GatewayUsagePanel } from './GatewayUsagePanel'
afterEach(cleanup)
describe('gateway usage', () => {
  it('shows recorded usage money but hides quota limits and diagnostics', () => {
    render(<GatewayUsagePanel summary={{ configured: true, subscriptionValid: true, enabled: true, upstreamEnabled: true, totalUsedUsd: .00005, windows: [{ period: '7d', remaining: null, resetAt: null, freshness: 'unknown', calibrationStatus: 'learning', uncertain: false }] }} />)
    expect(screen.getByText(/0.000050/)).toBeTruthy()
    expect(screen.queryByText(/165.00|本周期上限|你的剩余额度/)).toBeNull()
    expect(screen.queryByText('服务状态详情')).toBeNull()
    expect(screen.queryByText('服务可能暂不可用')).toBeNull()
    expect(screen.getByText(/模型用量/)).toBeTruthy()
    expect(screen.queryByText(/上游|校准|共享/)).toBeNull()

    expect(screen.queryByText(/剩余 0.0%/)).toBeNull()
  })
  it('does not treat an allocation as subscription eligibility', () => {
    render(<GatewayUsagePanel summary={{ configured: true, subscriptionValid: false, enabled: true, upstreamEnabled: true, limitUsd: 165 }} />)
    expect(screen.getByRole('alert').textContent).toContain('开通或续费 Claude 套餐')
  })
})

it('shows separate 5h and weekly progress bars without exposing caps', () => {
  render(<GatewayUsagePanel summary={{ configured: true, subscriptionValid: true, enabled: true, upstreamEnabled: true, limitUsd: 165, windows: [
    { period: '5h', state: 'limited', remaining: 1, resetAt: Date.now() + 3600000 },
    { period: '7d', state: 'limited', remaining: .1, resetAt: Date.now() + 86400000 },
  ] }} />)
  const five = screen.getByRole('progressbar', { name: 'Claude 5 小时剩余额度' })
  expect(five.getAttribute('aria-valuenow')).toBe('100')
  expect(five.getAttribute('style')).toContain('var(--success)')
  expect(screen.getByRole('progressbar', { name: 'Claude 每周剩余额度' }).getAttribute('aria-valuenow')).toBe('10')
  expect(screen.queryByText(/165/)).toBeNull()
})
it('omits disabled windows and never treats unknown usage as full', () => {
  render(<GatewayUsagePanel summary={{ configured: true, subscriptionValid: true, enabled: true, upstreamEnabled: true, windows: [
    { period: '5h', state: 'unlimited', remaining: null, resetAt: null },
    { period: '7d', state: 'unknown', remaining: null, resetAt: null },
  ] }} />)
  expect(screen.queryByRole('progressbar', { name: 'Claude 5 小时剩余额度' })).toBeNull()
  expect(screen.getByRole('progressbar', { name: 'Claude 每周剩余额度' }).getAttribute('aria-valuenow')).toBeNull()
  expect(screen.getByText('暂未获取')).toBeTruthy()
})
