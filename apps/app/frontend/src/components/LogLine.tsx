import { cn } from '@/lib/utils'
import type { ParsedLog } from '@/types'

const levelColors: Record<string, string> = {
  error: 'text-[var(--danger)]',
  warn: 'text-[var(--warning)]',
  success: 'text-[var(--success)]',
  system: 'text-[var(--primary)]',
  info: 'text-[var(--text-secondary)]',
}

export function LogLine({ log, terminal = false }: { log: ParsedLog; terminal?: boolean }) {
  if (terminal) {
    const level = log.level === 'error' ? 'ERROR' : log.level === 'warn' ? 'WARN' : log.level === 'success' ? 'OK' : 'INFO'
    return (
      <div className="grid grid-cols-[70px_92px_44px_1fr] px-3 text-[9px] leading-6 hover:bg-white/[.035]">
        <span className="text-slate-600">{log.time || '--:--:--'}</span>
        <span className="truncate text-slate-500">{log.tag || '[log]'}</span>
        <span className={log.level === 'error' ? 'text-red-400' : log.level === 'warn' ? 'text-amber-400' : 'text-emerald-400'}>{level}</span>
        <span className="break-all text-slate-300">{log.message || log.raw}</span>
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
