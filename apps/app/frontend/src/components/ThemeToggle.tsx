import { useState } from 'react'
import { Sun, Moon, Monitor, ChevronDown } from 'lucide-react'
import { getThemePreference, setTheme, type ThemePreference } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'

export function ThemeToggle({ className }: { className?: string }) {
  const t = useT()
  const [preference, setPreference] = useState<ThemePreference>(getThemePreference)
  const Icon = preference === 'system' ? Monitor : preference === 'dark' ? Moon : Sun

  return (
    <div className={cn('relative inline-flex items-center text-[var(--text-secondary)]', className)}>
      <Icon size={14} className="pointer-events-none absolute left-2.5" aria-hidden="true" />
      <select
        aria-label={t('theme.label')}
        value={preference}
        onChange={event => {
          const next = event.target.value as ThemePreference
          setPreference(next)
          setTheme(next)
        }}
        className="h-8 cursor-pointer appearance-none rounded-lg border border-[var(--border-light)] bg-[var(--bg-secondary)] pl-8 pr-7 text-[12px] text-[var(--text-primary)] transition-colors hover:border-[var(--border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
      >
        <option value="system">{t('theme.system')}</option>
        <option value="light">{t('theme.light')}</option>
        <option value="dark">{t('theme.dark')}</option>
      </select>
      <ChevronDown size={12} className="pointer-events-none absolute right-2" aria-hidden="true" />
    </div>
  )
}
