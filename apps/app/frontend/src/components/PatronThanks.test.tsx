import { render, screen, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PatronThanks } from './PatronThanks'
import { awaken } from '@/lib/exclusiveEasterEgg'

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('PatronThanks 滑跪感谢金主大大', () => {
  it('默认不渲染任何东西', () => {
    render(<PatronThanks />)
    expect(screen.queryByText(/感谢金主大大/)).not.toBeInTheDocument()
  })

  it('触发觉醒(awaken)→ 播放「感谢金主大大」', () => {
    render(<PatronThanks />)
    act(() => {
      awaken()
    })
    expect(screen.getByText(/感谢金主大大/)).toBeInTheDocument()
  })

  it('播放一段时间后自动消失', () => {
    render(<PatronThanks />)
    act(() => {
      awaken()
    })
    expect(screen.getByText(/感谢金主大大/)).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(screen.queryByText(/感谢金主大大/)).not.toBeInTheDocument()
  })
})
