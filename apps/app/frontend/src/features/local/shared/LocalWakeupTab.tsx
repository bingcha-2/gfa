import { useCallback, useEffect, useState } from 'react'
import { Play, RefreshCw, AlarmClock } from 'lucide-react'
import { type ProviderLocalApi, type WakeupConfig, type WakeupRunEntry } from '@/services/localApi'
import { cn } from '@/lib/utils'

/** 通用保活 tab:定时唤醒自有号(网关 keep-warm),配置 + 立即运行 + 历史。 */
export function LocalWakeupTab({ api }: { api: ProviderLocalApi }) {
  const [cfg, setCfg] = useState<WakeupConfig>({ enabled: false, intervalMinutes: 240 })
  const [history, setHistory] = useState<WakeupRunEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')

  const refresh = useCallback(async () => {
    try {
      const [c, h] = await Promise.all([api.wakeupConfig(), api.wakeupHistory()])
      setCfg(c)
      setHistory(h || [])
      setErr('')
    } catch (e) {
      setErr(String(e))
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => { void refresh() }, [refresh])

  const save = async (next: WakeupConfig) => {
    setBusy('save')
    try {
      await api.setWakeupConfig(next.enabled, next.intervalMinutes)
      await refresh()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  const onRunNow = async () => {
    setBusy('run')
    try {
      await api.wakeupRunNow()
      await refresh()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <div className="px-4 py-10 text-center text-[12px] text-[var(--text-muted)]">加载中…</div>

  return (
    <div className="flex flex-col gap-4">
      {err && <div className="rounded-[8px] border border-[var(--danger)] bg-[var(--danger)]/5 px-3 py-2 text-[12px] text-[var(--danger)] break-all">{err}</div>}

      <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[13px] font-semibold text-[var(--text-primary)] inline-flex items-center gap-1.5"><AlarmClock size={14} /> 保活</div>
            <div className="text-[11px] text-[var(--text-muted)] mt-0.5">定时对在池账号做 keep-warm,降低会话过期/配额窗口失活。</div>
          </div>
          <button
            onClick={() => void save({ ...cfg, enabled: !cfg.enabled })}
            disabled={busy === 'save'}
            role="switch"
            aria-checked={cfg.enabled}
            className={cn('w-[42px] h-[24px] rounded-full relative transition-colors disabled:opacity-50', cfg.enabled ? 'bg-[var(--primary)]' : 'bg-[#cbd2dc]')}
          >
            <span className={cn('absolute top-[3px] w-[18px] h-[18px] rounded-full bg-white transition-all', cfg.enabled ? 'right-[3px]' : 'left-[3px]')} />
          </button>
        </div>

        <div className="flex items-center gap-3 pt-2 border-t border-[var(--border-light)]">
          <span className="text-[12px] text-[var(--text-secondary)]">间隔(分钟)</span>
          <input
            type="number"
            min={5}
            value={cfg.intervalMinutes}
            onChange={(e) => setCfg({ ...cfg, intervalMinutes: Math.max(5, Number(e.target.value) || 0) })}
            onBlur={() => void save(cfg)}
            className="w-[90px] rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 h-[30px] text-[12px] font-mono-data text-[var(--text-primary)]"
            aria-label="保活间隔分钟"
          />
          <div className="flex-1" />
          <button onClick={onRunNow} disabled={busy === 'run'} className="text-[12px] font-semibold px-3 h-[30px] rounded-[8px] border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] inline-flex items-center gap-1.5 disabled:opacity-50">
            <Play size={13} /> 立即运行
          </button>
        </div>
      </div>

      <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] p-3.5">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-bold text-[var(--text-muted)]">运行历史</span>
          <button onClick={() => void refresh()} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="刷新"><RefreshCw size={13} /></button>
        </div>
        {history.length === 0 ? (
          <div className="py-6 text-center text-[12px] text-[var(--text-muted)]">还没有运行记录。开启保活或点「立即运行」。</div>
        ) : (
          <div className="flex flex-col divide-y divide-[var(--border-light)]">
            {history.slice(0, 20).map((h, i) => (
              <div key={i} className="grid grid-cols-[auto_1fr_auto] gap-3 items-center py-1.5 text-[11px]">
                <span className="font-mono-data text-[var(--text-muted)]">{h.atMs ? new Date(h.atMs).toLocaleTimeString() : '—'}</span>
                <span className="truncate text-[var(--text-secondary)]">{h.email || h.accountId}</span>
                <span className={h.ok ? 'text-[var(--success)]' : 'text-[var(--danger)]'}>{h.ok ? '成功' : (h.err || '失败')}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
