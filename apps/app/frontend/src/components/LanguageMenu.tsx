import { useEffect, useRef, useState } from 'react'
import { Languages } from 'lucide-react'
import { useLocaleStore, SUPPORTED_LOCALES, LOCALE_NAMES } from '@/i18n'
import { cn } from '@/lib/utils'

/** 顶栏语言切换:地球图标 + 本族语名下拉,与 ThemeToggle 同款视觉。 */
export function LanguageMenu({ className }: { className?: string }) {
  const locale = useLocaleStore((s) => s.locale)
  const setLocale = useLocaleStore((s) => s.setLocale)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={LOCALE_NAMES[locale]}
        aria-label={LOCALE_NAMES[locale]}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          'inline-flex items-center justify-center w-8 h-8 rounded-[8px] text-[var(--text-secondary)]',
          'border border-[var(--border-light)] bg-[var(--bg-secondary)]',
          'hover:text-[var(--text-primary)] hover:border-[var(--border)] transition-colors cursor-pointer',
        )}
      >
        <Languages size={15} />
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute right-0 top-[calc(100%+6px)] z-50 min-w-[136px] m-0 p-1 list-none rounded-[10px] border border-[var(--border-light)] bg-[var(--bg-secondary)] shadow-[var(--shadow-md)]"
        >
          {SUPPORTED_LOCALES.map((l) => (
            <li key={l}>
              <button
                type="button"
                role="option"
                aria-selected={l === locale}
                onClick={() => { setOpen(false); setLocale(l) }}
                className={cn(
                  'block w-full px-2.5 py-1.5 rounded-[7px] text-left text-[12px] transition-colors cursor-pointer',
                  l === locale
                    ? 'text-[var(--primary-strong)] bg-[var(--primary-light)] font-semibold'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]',
                )}
              >
                {LOCALE_NAMES[l]}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
