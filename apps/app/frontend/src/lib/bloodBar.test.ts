import { describe, expect, it } from 'vitest'

import { bloodBarStatus, bloodBarFromFraction } from './bloodBar'

describe('bloodBarStatus', () => {
  it('shows a full, healthy bar when nothing is used', () => {
    const s = bloodBarStatus(0, 1000)
    expect(s.remainingPct).toBe(100)
    expect(s.label).toBe('充足')
    expect(s.tone).toBe('ok')
  })

  it('drops the bar as usage rises (remaining = 1 - used/limit)', () => {
    expect(bloodBarStatus(700, 1000).remainingPct).toBeCloseTo(30, 5)
  })

  it('labels a low-but-nonzero bar as 紧张', () => {
    const s = bloodBarStatus(900, 1000) // 10% remaining
    expect(s.label).toBe('紧张')
    expect(s.tone).toBe('low')
  })

  it('labels a mid bar as 一般', () => {
    const s = bloodBarStatus(600, 1000) // 40% remaining
    expect(s.label).toBe('一般')
    expect(s.tone).toBe('warn')
  })

  it('shows an empty, exhausted bar at/over the limit', () => {
    const s = bloodBarStatus(1000, 1000)
    expect(s.remainingPct).toBe(0)
    expect(s.label).toBe('已用尽')
    expect(s.tone).toBe('empty')
  })

  it('treats an unlimited card (limit 0) as a full bar', () => {
    const s = bloodBarStatus(123456, 0)
    expect(s.remainingPct).toBe(100)
    expect(s.tone).toBe('ok')
  })

  it('shows a waiting state when data is missing', () => {
    expect(bloodBarStatus(null, null).label).toBe('等待数据')
    expect(bloodBarStatus(null, 1000).label).toBe('等待数据')
  })

  it('never reports more than 100% or less than 0% remaining', () => {
    expect(bloodBarStatus(2000, 1000).remainingPct).toBe(0)
    expect(bloodBarStatus(-50, 1000).remainingPct).toBe(100)
  })
})

describe('bloodBarFromFraction', () => {
  it('maps the upstream remaining fraction directly to the bar', () => {
    expect(bloodBarFromFraction(0.88)).toMatchObject({ label: '充足', tone: 'ok' })
    expect(bloodBarFromFraction(0.42)).toMatchObject({ label: '一般', tone: 'warn' })
    expect(bloodBarFromFraction(0.1)).toMatchObject({ label: '紧张', tone: 'low' })
    expect(bloodBarFromFraction(0)).toMatchObject({ label: '已用尽', tone: 'empty' })
  })
  it('reflects the fraction as the bar width', () => {
    expect(bloodBarFromFraction(0.3).remainingPct).toBeCloseTo(30, 5)
  })
  it('clamps an over-1 fraction to 100%', () => {
    expect(bloodBarFromFraction(1.5).remainingPct).toBe(100)
  })

  it('treats a negative fraction as 未知 (no quota data), not 已用尽', () => {
    expect(bloodBarFromFraction(-1)).toMatchObject({ label: '未知', tone: 'warn' })
  })
})
