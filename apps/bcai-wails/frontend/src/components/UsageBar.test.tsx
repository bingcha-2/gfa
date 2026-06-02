import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { UsageBar } from './UsageBar'

describe('UsageBar (blood bar)', () => {
  it('shows the status word AND the remaining percentage, not raw token numbers', () => {
    render(<UsageBar label="Codex" used={600} limit={1000} color="bg-emerald-500" />)
    expect(screen.getByText('Codex')).toBeInTheDocument()
    // 40% remaining → "一般 40%"
    expect(screen.getByText(/一般/)).toBeInTheDocument()
    expect(screen.getByText(/40%/)).toBeInTheDocument()
    // The raw "600 / 1.0K" token counts must NOT be shown to the end user.
    expect(screen.queryByText(/600/)).toBeNull()
    expect(screen.queryByText(/1\.0K/)).toBeNull()
  })

  it('shows 已用尽 0% when the card is exhausted', () => {
    render(<UsageBar label="Opus" used={1000} limit={1000} color="bg-purple-500" />)
    expect(screen.getByText(/已用尽/)).toBeInTheDocument()
    expect(screen.getByText(/0%/)).toBeInTheDocument()
  })

  it('shows 等待数据 before any data arrives', () => {
    render(<UsageBar label="Gemini" used={null} limit={null} color="bg-blue-500" />)
    expect(screen.getByText('等待数据')).toBeInTheDocument()
  })

  it('prefers the upstream fraction over local used/limit when provided', () => {
    // used/limit would read 充足, but the bound account is actually almost empty.
    render(<UsageBar label="Codex" used={0} limit={100_000_000} color="bg-emerald-500" fraction={0.05} />)
    expect(screen.getByText(/紧张/)).toBeInTheDocument()
    expect(screen.getByText(/5%/)).toBeInTheDocument()
    expect(screen.queryByText(/充足/)).toBeNull()
  })

  it('shows 未知 (not a fake 100%) when the fraction is unknown (-1)', () => {
    render(<UsageBar label="Claude (Opus)" used={0} limit={100_000_000} color="bg-purple-500" fraction={-1} />)
    expect(screen.getByText(/未知/)).toBeInTheDocument()
    expect(screen.queryByText(/100%/)).toBeNull()
  })

  it('shows a per-bar recovery countdown when resetMs is provided', () => {
    render(<UsageBar label="Claude (Opus)" used={null} limit={null} color="bg-purple-500" fraction={0} resetMs={2 * 60 * 60 * 1000} />)
    expect(screen.getByText(/已用尽/)).toBeInTheDocument()
    expect(screen.getByText(/后恢复/)).toBeInTheDocument()
  })

  it('shows the recovery countdown even on a healthy (充足) bar', () => {
    render(<UsageBar label="Gemini" used={null} limit={null} color="bg-blue-500" fraction={1} resetMs={2 * 60 * 60 * 1000} />)
    expect(screen.getByText(/充足/)).toBeInTheDocument()
    expect(screen.getByText(/后恢复/)).toBeInTheDocument()
  })
})
