import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { NestedShareBar } from './NestedShareBar'

function renderBar(myFraction: number, displayKey?: string) {
  return render(
    <NestedShareBar
      label="5h 份额"
      myFraction={myFraction}
      accountFraction={1}
      shareSeats={1}
      shareCapacity={1}
      resetMs={60_000}
      displayKey={displayKey}
    />,
  )
}

describe('NestedShareBar monotonic display', () => {
  it('does not render a rebound inside the same reset window', () => {
    const view = renderBar(0.10, 'anthropic-claude:5h:1000')
    expect(screen.getByText(/我的总剩余 10%/)).toBeInTheDocument()

    view.rerender(
      <NestedShareBar
        label="5h 份额"
        myFraction={0.12}
        accountFraction={1}
        shareSeats={1}
        shareCapacity={1}
        resetMs={60_000}
        displayKey="anthropic-claude:5h:1000"
      />,
    )

    expect(screen.getByText(/我的总剩余 10%/)).toBeInTheDocument()
    expect(screen.queryByText(/我的总剩余 12%/)).toBeNull()
  })

  it('renders a lower value immediately inside the same reset window', () => {
    const view = renderBar(0.10, 'anthropic-claude:5h:1000')

    view.rerender(
      <NestedShareBar
        label="5h 份额"
        myFraction={0.09}
        accountFraction={1}
        shareSeats={1}
        shareCapacity={1}
        resetMs={60_000}
        displayKey="anthropic-claude:5h:1000"
      />,
    )

    expect(screen.getByText(/我的总剩余 9%/)).toBeInTheDocument()
  })

  it('accepts a higher server value after the reset window changes', () => {
    const view = renderBar(0.10, 'anthropic-claude:5h:1000')

    view.rerender(
      <NestedShareBar
        label="5h 份额"
        myFraction={0.95}
        accountFraction={1}
        shareSeats={1}
        shareCapacity={1}
        resetMs={60_000}
        displayKey="anthropic-claude:5h:2000"
      />,
    )

    expect(screen.getByText(/我的总剩余 95%/)).toBeInTheDocument()
  })

  it('starts fresh after a remount, matching a client crash or restart', () => {
    const view = renderBar(0.10, 'anthropic-claude:5h:1000')
    view.unmount()

    renderBar(0.12, 'anthropic-claude:5h:1000')

    expect(screen.getByText(/我的总剩余 12%/)).toBeInTheDocument()
  })

  it('does not freeze values when there is no display key for an expired window', () => {
    const view = renderBar(0.10)

    view.rerender(
      <NestedShareBar
        label="5h 份额"
        myFraction={0.95}
        accountFraction={1}
        shareSeats={1}
        shareCapacity={1}
        resetMs={0}
      />,
    )

    expect(screen.getByText(/我的总剩余 95%/)).toBeInTheDocument()
  })
})

describe('独享单层血条', () => {
  it('独享只展示「剩余 X%」,不展示账号总剩余', () => {
    render(
      <NestedShareBar
        label="5h 份额"
        myFraction={0.7}
        accountFraction={0.3}
        shareSeats={8}
        shareCapacity={8}
        exclusive
      />,
    )

    expect(screen.getByText(/剩余 70%/)).toBeInTheDocument()
    expect(screen.queryByText(/账号总剩余/)).toBeNull()
  })

  it('拼车仍然展示双层(我的总剩余 + 账号总剩余)', () => {
    render(
      <NestedShareBar
        label="5h 份额"
        myFraction={0.5}
        accountFraction={0.8}
        shareSeats={1}
        shareCapacity={8}
      />,
    )

    expect(screen.getByText(/我的总剩余/)).toBeInTheDocument()
    expect(screen.getByText(/账号总剩余/)).toBeInTheDocument()
  })
})
