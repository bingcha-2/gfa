import { useAppStore } from '@/stores/useAppStore'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'

interface StatusPillProps {
  compact?: boolean
}

export function StatusPill({ compact = false }: StatusPillProps) {
  const t = useT()
  const { proxyRunning, proxyPort, leaserState, leaserError, config } = useAppStore()

  let dotColor = 'bg-[var(--text-muted)]'
  let text = t('status.checking')
  let showPulse = false

  if (!proxyRunning) {
    text = t('status.proxyDown')
  } else if (leaserError) {
    dotColor = 'bg-[var(--danger)]'
    text = t('status.error', { error: leaserError })
  } else if (leaserState === 'waiting_first_lease') {
    dotColor = 'bg-[var(--warning)]'
    text = t('status.leasing')
  } else if (leaserState === 'unconfigured' || !config?.accountCard) {
    text = t('status.needCard')
  } else {
    dotColor = 'bg-[var(--success)]'
    text = t('status.ok', { port: proxyPort })
    showPulse = true
  }

  return (
    <div className={cn(
      'flex items-center border border-[var(--border-light)] bg-[var(--bg-card)]',
      compact
        ? 'gap-1.5 px-2.5 py-1.5 rounded-[8px] mt-2'
        : 'gap-2.5 px-4 py-2.5 rounded-[12px] shadow-[var(--shadow-sm)] mb-1',
    )}>
      <div className={cn(
        'rounded-full flex-shrink-0',
        compact ? 'w-1.5 h-1.5' : 'w-2 h-2',
        dotColor,
        showPulse && 'dot-pulse',
      )} />
      <span className={cn(
        'text-[var(--text-secondary)] truncate',
        compact ? 'text-[10px]' : 'text-[13px]',
      )}>{text}</span>
    </div>
  )
}
