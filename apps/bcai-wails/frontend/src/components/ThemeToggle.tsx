import { useEffect, useState } from 'react'
import { Sun, Moon } from 'lucide-react'
import { getTheme, setTheme, type Theme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'

/** 顶栏的明/暗切换。受控于本地状态 + theme 模块的持久化。 */
export function ThemeToggle({ className }: { className?: string }) {
  const t = useT()
  const [theme, setThemeState] = useState<Theme>(() => getTheme())

  useEffect(() => { setTheme(theme) }, [theme])

  const next = theme === 'dark' ? 'light' : 'dark'
  const toggle = () => setThemeState(next)

  return (
    <button
      type="button"
      onClick={toggle}
      title={next === 'dark' ? t('theme.toDark') : t('theme.toLight')}
      aria-label={next === 'dark' ? t('theme.toDark') : t('theme.toLight')}
      className={cn(
        'inline-flex items-center justify-center w-8 h-8 rounded-[8px] text-[var(--text-secondary)]',
        'border border-[var(--border-light)] bg-[var(--bg-secondary)]',
        'hover:text-[var(--text-primary)] hover:border-[var(--border)] transition-colors cursor-pointer',
        className,
      )}
    >
      {theme === 'dark' ? <Moon size={15} /> : <Sun size={15} />}
    </button>
  )
}
