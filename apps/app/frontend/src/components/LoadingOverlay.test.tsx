import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { LoadingOverlay } from './LoadingOverlay'

// 这里钉的是一次真实事故:遮罩的 z 曾高于 Dialog,接管失败的错误弹窗被转圈整个盖住,
// 用户只看得到「正在接管…」。当时靠「调用方弹窗前必须先关遮罩」的口头契约兜着,
// 而遮罩有 busy / hostBusy 两个独立开关,契约必然被漏 —— 所以改成用 z 从根上保证。
describe('LoadingOverlay', () => {
  it('show=false 时不渲染', () => {
    const { container } = render(<LoadingOverlay show={false} label="正在接管…" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('渲染时用 --z-loading,而不是会盖住弹窗的 --z-overlay', () => {
    const { container } = render(<LoadingOverlay show label="正在接管…" />)
    const root = container.firstElementChild as HTMLElement

    expect(screen.getByText('正在接管…')).toBeInTheDocument()
    expect(root.className).toContain('z-[var(--z-loading)]')
    expect(root.className).not.toContain('z-[var(--z-overlay)]')
  })

  it('z 层级:遮罩必须低于 Dialog 的背景板与内容,否则会盖住弹窗', () => {
    const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8')
    const z = (name: string): number => {
      const m = css.match(new RegExp(`--z-${name}:\\s*(\\d+)`))
      if (!m) throw new Error(`index.css 里找不到 --z-${name}`)
      return Number(m[1])
    }

    expect(z('loading')).toBeLessThan(z('modal-backdrop'))
    expect(z('modal-backdrop')).toBeLessThan(z('modal'))
    // 同时得高于普通页面内容,遮罩期间仍然挡住底下的交互。
    expect(z('loading')).toBeGreaterThan(z('sticky'))
  })
})
