import { cn } from '@/lib/utils'
import type { ParsedLog } from '@/types'

const levelColors: Record<string, string> = {
  error: 'text-[var(--danger)]',
  warn: 'text-[var(--warning)]',
  success: 'text-[var(--success)]',
  system: 'text-[var(--primary)]',
  info: 'text-[var(--text-secondary)]',
}

export function LogLine({ log }: { log: ParsedLog }) {
  return (
    <div className={cn('flex gap-2 py-[3px] px-3 text-[12px] font-mono leading-[1.6] hover:bg-[var(--bg-hover)] rounded-[6px]', levelColors[log.level])}>
      <span className="text-[var(--text-muted)] flex-shrink-0 w-[60px]">{log.time || '--:--:--'}</span>
      <span className="text-[var(--text-muted)] flex-shrink-0 w-[100px] truncate">{log.tag || '[log]'}</span>
      <span className="flex-1 break-all">{log.message || log.raw}</span>
    </div>
  )
}
