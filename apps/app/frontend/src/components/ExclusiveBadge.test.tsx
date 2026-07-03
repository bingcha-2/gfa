import { render, screen, fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { ExclusiveBadge } from './ExclusiveBadge'
import { EXCLUSIVE_AWAKEN_THRESHOLD, EXCLUSIVE_AWAKEN_DURATION_MS } from '@/lib/exclusiveEasterEgg'

const STORAGE_KEY = 'bcai.exclusive.awakenUntil'

beforeEach(() => {
  localStorage.clear()
})

describe('ExclusiveBadge 充能彩蛋', () => {
  it('默认显示「尊贵 · 独享」', () => {
    render(<ExclusiveBadge />)
    expect(screen.getByText(/尊贵 · 独享/)).toBeInTheDocument()
    expect(screen.queryByText(/氪金之王 金主大大/)).not.toBeInTheDocument()
  })

  it('连点满阈值 → 觉醒为「氪金之王 金主大大」', () => {
    render(<ExclusiveBadge />)
    const btn = screen.getByRole('button')
    for (let i = 0; i < EXCLUSIVE_AWAKEN_THRESHOLD; i++) fireEvent.click(btn)
    expect(screen.getByText(/氪金之王 金主大大/)).toBeInTheDocument()
    expect(screen.queryByText(/尊贵 · 独享/)).not.toBeInTheDocument()
  })

  it('未点满(差一下)不觉醒', () => {
    render(<ExclusiveBadge />)
    const btn = screen.getByRole('button')
    for (let i = 0; i < EXCLUSIVE_AWAKEN_THRESHOLD - 1; i++) fireEvent.click(btn)
    expect(screen.getByText(/尊贵 · 独享/)).toBeInTheDocument()
  })

  it('觉醒态写入 localStorage 到期时间戳(约 1 分钟后)', () => {
    render(<ExclusiveBadge />)
    const btn = screen.getByRole('button')
    for (let i = 0; i < EXCLUSIVE_AWAKEN_THRESHOLD; i++) fireEvent.click(btn)
    const until = Number(localStorage.getItem(STORAGE_KEY))
    expect(until - Date.now()).toBeGreaterThan(EXCLUSIVE_AWAKEN_DURATION_MS - 5_000)
    expect(until - Date.now()).toBeLessThanOrEqual(EXCLUSIVE_AWAKEN_DURATION_MS + 1_000)
  })

  it('挂载时若 localStorage 内仍在有效期 → 直接觉醒', () => {
    localStorage.setItem(STORAGE_KEY, String(Date.now() + EXCLUSIVE_AWAKEN_DURATION_MS))
    render(<ExclusiveBadge />)
    expect(screen.getByText(/氪金之王 金主大大/)).toBeInTheDocument()
  })

  it('到期时间已过 → 回落到「尊贵 · 独享」', () => {
    localStorage.setItem(STORAGE_KEY, String(Date.now() - 1_000))
    render(<ExclusiveBadge />)
    expect(screen.getByText(/尊贵 · 独享/)).toBeInTheDocument()
  })
})
