import { useAppStore } from '@/stores/useAppStore'
import { cn } from '@/lib/utils'

interface StatusPillProps {
  compact?: boolean
}

export function StatusPill({ compact = false }: StatusPillProps) {
  const { proxyRunning, proxyPort, leaserState, leaserError, config } = useAppStore()

  let dotColor = 'bg-[var(--text-muted)]'
  let text = '正在检查状态...'
  let showPulse = false

  if (!proxyRunning) {
    text = '代理未启动'
  } else if (leaserError) {
    dotColor = 'bg-[var(--danger)]'
    text = `错误 · ${leaserError}`
  } else if (leaserState === 'waiting_first_lease') {
    dotColor = 'bg-[var(--warning)]'
    text = '获取租约中...'
  } else if (leaserState === 'unconfigured' || !config?.accountCard) {
    text = '请配置并激活账号卡'
  } else {
    dotColor = 'bg-[var(--success)]'
    text = `服务正常 · 127.0.0.1:${proxyPort}`
    showPulse = true
  }

  return (
    <div className={cn(
      'flex items-center border border-[var(--border-light)] bg-[var(--bg-card)] backdrop-blur-sm',
      compact
        ? 'gap-1.5 px-2.5 py-1.5 rounded-[6px] mt-2'
        : 'gap-2.5 px-4 py-2.5 rounded-[12px] shadow-sm mb-4',
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
