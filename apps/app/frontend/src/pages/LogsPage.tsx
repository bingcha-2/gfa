import { useEffect, useRef, useState } from 'react'
import { useLogStore, type LogFilter } from '@/stores/useLogStore'
import { LogLine } from '@/components/LogLine'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { Copy, Filter, FolderOpen, Pause, Play, Search, Trash2 } from 'lucide-react'

export function LogsPage() {
  const t = useT()
  const { filter, searchQuery, setFilter, setSearchQuery, clearLogs, getFilteredLogs, logs } = useLogStore()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [follow, setFollow] = useState(true)

  const filters: { id: LogFilter; label: string }[] = [
    { id: 'all', label: t('logs.filterAll') },
    { id: 'error', label: t('logs.filterError') },
    { id: 'warn', label: t('logs.filterWarn') },
    { id: 'proxy', label: t('logs.filterProxy') },
    { id: 'inject', label: t('logs.filterInject') },
  ]
  const filteredLogs = getFilteredLogs()

  useEffect(() => {
    if (follow && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [follow, logs.length])

  const handleCopyLogs = () => navigator.clipboard.writeText(filteredLogs.map((log) => log.raw).join('\n'))

  return (
    <div className="mx-auto flex h-full w-full max-w-[1080px] flex-col gap-4 pt-3">
      <div className="flex items-end justify-between gap-4">
        <div><h2 className="text-[19px] font-bold tracking-tight text-[var(--text-primary)]">{t('nav.logs')}</h2><p className="mt-1 text-[11px] text-[var(--text-secondary)]">本地代理、接管、租约和额度事件</p></div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => setFollow((value) => !value)}>{follow ? <Pause size={12} /> : <Play size={12} />}{follow ? '暂停跟随' : '继续跟随'}</Button>
          <Button size="sm" variant="secondary" onClick={handleCopyLogs}><Copy size={12} />{t('logs.copy')}</Button>
          <Button size="sm" variant="secondary" onClick={clearLogs}><Trash2 size={12} />{t('logs.clear')}</Button>
        </div>
      </div>

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[14px] border border-slate-800 bg-[#10131a] text-slate-200">
        <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5">
          <div className="relative min-w-[220px] flex-1">
            <Search size={12} className="absolute left-2.5 top-2 text-slate-500" />
            <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={t('logs.searchPlaceholder')} className="h-7 w-full rounded-[7px] border border-white/10 bg-white/5 pl-8 pr-3 font-mono text-[9px] text-slate-200 outline-none placeholder:text-slate-600 focus:border-orange-500/60" />
          </div>
          <div className="flex items-center gap-0.5 rounded-[7px] bg-white/5 p-0.5">
            {filters.map((item) => <button key={item.id} type="button" onClick={() => setFilter(item.id)} className={cn('rounded-[6px] px-2 py-1 text-[8px] font-semibold', filter === item.id ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-slate-300')}>{item.label}</button>)}
          </div>
          <span className="flex items-center gap-1.5 px-2 text-[8px] text-slate-500"><i className={cn('h-1.5 w-1.5 rounded-full', follow ? 'bg-emerald-400' : 'bg-amber-400')} />{follow ? '实时跟随' : '已暂停滚动'}</span>
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-2 font-mono">
          {filteredLogs.length === 0
            ? <div className="grid h-full place-items-center text-[11px] text-slate-600">{t('logs.empty')}</div>
            : filteredLogs.map((log, index) => <LogLine key={index} log={log} terminal />)}
        </div>

        <div className="flex items-center justify-between border-t border-white/10 px-3 py-2 text-[8px] text-slate-600">
          <span className="flex items-center gap-1.5"><Filter size={10} />{filteredLogs.length} 条可见 · desktop.log</span>
          <span className="flex items-center gap-1 text-slate-500"><FolderOpen size={10} />日志仅保存在本机</span>
        </div>
      </section>
    </div>
  )
}
