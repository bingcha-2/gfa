import { useRef, useEffect } from 'react'
import { useLogStore, type LogFilter } from '@/stores/useLogStore'
import { LogLine } from '@/components/LogLine'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { ScrollText, Trash2, Copy, Search } from 'lucide-react'

const filters: { id: LogFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'error', label: '错误' },
  { id: 'warn', label: '警告' },
  { id: 'proxy', label: '代理' },
  { id: 'inject', label: '注入' },
  { id: 'pool', label: '号池' },
]

export function LogsPage() {
  const { filter, searchQuery, setFilter, setSearchQuery, clearLogs, getFilteredLogs, logs } = useLogStore()
  const scrollRef = useRef<HTMLDivElement>(null)

  const filteredLogs = getFilteredLogs()

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs.length])

  const handleCopyLogs = () => {
    const text = filteredLogs.map((l) => l.raw).join('\n')
    navigator.clipboard.writeText(text)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[18px] font-bold text-[var(--text-primary)] flex items-center gap-2">
          <ScrollText size={20} /> 实时日志
        </h2>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={clearLogs}>
            <Trash2 size={13} /> 清空
          </Button>
          <Button size="sm" variant="ghost" onClick={handleCopyLogs}>
            <Copy size={13} /> 复制
          </Button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3 mb-3">
        <div className="flex items-center gap-0.5 bg-[var(--bg-tertiary)] rounded-[8px] p-1">
          {filters.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                'px-2.5 py-1 rounded-[6px] text-[11px] font-semibold transition-all',
                filter === f.id
                  ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 max-w-[220px]">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索日志..."
            className="pl-8 h-8 text-[12px]"
          />
        </div>
      </div>

      {/* Log view */}
      <Card
        ref={scrollRef}
        className="flex-1 overflow-y-auto py-1"
        style={{ minHeight: 0 }}
      >
        {filteredLogs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-[13px] text-[var(--text-muted)]">暂无日志</div>
        ) : (
          filteredLogs.map((log, i) => <LogLine key={i} log={log} />)
        )}
      </Card>
    </div>
  )
}
