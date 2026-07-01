import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * 挂在 body 上的下拉菜单:避免被祖先 overflow:hidden 裁切,并补齐键盘可达。
 * - 相对锚点固定定位(锚点下方、右对齐)
 * - Esc / 点外部 / 页面滚动 → 关闭
 * - 打开即把焦点移入首项,↑↓ 在菜单项间滚动
 * 子项须带 role="menuitem"(调用方沿用原按钮结构即可)。
 */
export function PortalMenu({
  open, anchorRef, onClose, label, width = 176, children,
}: {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  label?: string
  width?: number
  children: ReactNode
}) {
  const menuRef = useRef<HTMLDivElement>(null)

  // 定位 + 打开即聚焦首项。
  useEffect(() => {
    if (!open) return
    const el = menuRef.current
    const anchor = anchorRef.current
    if (el && anchor) {
      const r = anchor.getBoundingClientRect()
      el.style.top = `${r.bottom + 4}px`
      el.style.left = `${Math.max(8, r.right - width)}px`
    }
    el?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [open, anchorRef, width])

  // Esc / 点外部 / 滚动关闭。
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); anchorRef.current?.focus() }
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || anchorRef.current?.contains(t)) return
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', onClose, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [open, onClose, anchorRef])

  if (!open) return null

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    if (items.length === 0) return
    const idx = items.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length
    items[next]?.focus()
  }

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      onKeyDown={onMenuKeyDown}
      style={{ width }}
      className="fixed z-[var(--z-overlay)] rounded-[10px] border border-[var(--border)] bg-[var(--bg-card)] shadow-[var(--shadow-lg)] py-1 overflow-hidden"
    >
      {children}
    </div>,
    document.body,
  )
}

export type KebabItem = {
  key: string
  label: string
  icon?: ReactNode
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}

/** 行内「⋯」溢出菜单:把次要动作(刷新/编辑/删除)收进来,主行只留高频操作。 */
export function KebabMenu({ items, label = '更多操作' }: { items: KebabItem[]; label?: string }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn('cursor-pointer w-7 h-7 inline-flex items-center justify-center rounded-[7px] hover:bg-[var(--bg-hover)]', open ? 'text-[var(--text-primary)] bg-[var(--bg-hover)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')}
      >
        <MoreHorizontal size={16} />
      </button>
      <PortalMenu open={open} anchorRef={btnRef} onClose={() => setOpen(false)} label={label} width={168}>
        {items.map((it) => (
          <button
            key={it.key}
            role="menuitem"
            type="button"
            disabled={it.disabled}
            onClick={() => { setOpen(false); it.onClick() }}
            className={cn(
              'w-full text-left text-[12px] px-3 py-2 inline-flex items-center gap-2 hover:bg-[var(--bg-hover)] disabled:opacity-40 disabled:cursor-not-allowed',
              it.danger ? 'text-[var(--danger)] hover:bg-[var(--danger)]/8' : 'text-[var(--text-primary)]',
            )}
          >
            {it.icon}
            {it.label}
          </button>
        ))}
      </PortalMenu>
    </>
  )
}
