import { cn } from '@/lib/utils'
import type { ParsedLog } from '@/types'

const levelColors: Record<string, string> = {
  error: 'text-[var(--danger)]',
  warn: 'text-[var(--warning)]',
  success: 'text-[var(--success)]',
  system: 'text-[var(--primary)]',
  info: 'text-[var(--text-secondary)]',
}

// 终端视图:短标签 + 语义色,跟随主题令牌(浅/深两套都 AA 安全)。
const terminalLevels: Record<ParsedLog['level'], { label: string; color: string }> = {
  error: { label: 'ERROR', color: 'text-[var(--danger)]' },
  warn: { label: 'WARN', color: 'text-[var(--warning-deep)]' },
  success: { label: 'OK', color: 'text-[var(--success-strong)]' },
  system: { label: 'SYS', color: 'text-[var(--primary-strong)]' },
  info: { label: 'INFO', color: 'text-[var(--text-muted)]' },
}

export function LogLine({ log, terminal = false }: { log: ParsedLog; terminal?: boolean }) {
  if (terminal) {
    const { label, color } = terminalLevels[log.level] ?? terminalLevels.info
    return (
      <div className="grid grid-cols-[74px_120px_50px_1fr] gap-2 px-3 text-[12px] leading-[1.7] hover:bg-[var(--bg-hover)]">
        <span className="text-[var(--text-muted)]">{log.time || '--:--:--'}</span>
        <span className="truncate text-[var(--text-muted)]">{log.tag || '[log]'}</span>
        <span className={cn('font-semibold', color)}>{label}</span>
        <span className="break-all text-[var(--text-primary)]">{log.message || log.raw}</span>
      </div>
    )
  }
  return (
    <div className={cn('flex gap-2 py-[3px] px-3 text-[12px] font-mono leading-[1.6] hover:bg-[var(--bg-hover)] rounded-[6px]', levelColors[log.level])}>
      <span className="text-[var(--text-muted)] flex-shrink-0 w-[60px]">{log.time || '--:--:--'}</span>
      <span className="text-[var(--text-muted)] flex-shrink-0 w-[100px] truncate">{log.tag || '[log]'}</span>
      <span className="flex-1 break-all">{log.message || log.raw}</span>
    </div>
  )
}
