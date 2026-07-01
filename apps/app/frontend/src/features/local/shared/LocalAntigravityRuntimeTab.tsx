import { useCallback, useEffect, useState } from 'react'
import {
  RefreshCw, Trash2, Play, Square, RotateCcw, Eye, Activity, History as HistoryIcon, Check, X,
} from 'lucide-react'
import {
  type AntigravitySwitchHistoryItem,
  antigravityStartDefault, antigravityStopDefault, antigravityRestartDefault,
  antigravityFocusDefault, antigravityRuntimeStatus,
  antigravitySwitchHistory, clearAntigravitySwitchHistory,
} from '@/services/localApi'
import { cn } from '@/lib/utils'

/**
 * Antigravity 默认实例运行时:控制本机已装 IDE 进程(启/停/重启/聚焦)+ 切换历史列表/清空。
 * 只在 antigravity 的「实例」tab 里挂载(codex 无此块)。
 *
 * 红线:只控制本机 IDE 进程,切换历史只读写本地 JSON,与远程租号 / 网关出口无关。
 */

function Section({ icon, title, desc, children }: { icon: React.ReactNode; title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] p-4 flex flex-col gap-3">
      <div>
        <div className="text-[13px] font-semibold text-[var(--text-primary)] inline-flex items-center gap-1.5">{icon} {title}</div>
        {desc && <div className="text-[11px] text-[var(--text-muted)] mt-0.5">{desc}</div>}
      </div>
      {children}
    </div>
  )
}

const BTN_CLS =
  'text-[12px] font-semibold px-3 h-[32px] rounded-[8px] border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] inline-flex items-center gap-1.5 disabled:opacity-50'

export function LocalAntigravityRuntimeTab() {
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [running, setRunning] = useState<boolean | null>(null)
  const [history, setHistory] = useState<AntigravitySwitchHistoryItem[]>([])

  const refreshRuntime = useCallback(async () => {
    try {
      const [r, h] = await Promise.all([antigravityRuntimeStatus(), antigravitySwitchHistory()])
      setRunning(r)
      setHistory(h || [])
      setErr('')
    } catch (e) {
      setErr(String(e))
    }
  }, [])

  useEffect(() => { void refreshRuntime() }, [refreshRuntime])

  const runtimeAction = (key: string, fn: () => Promise<void>) => async () => {
    setBusy(key)
    try {
      await fn()
      await refreshRuntime()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  const onClearHistory = async () => {
    setBusy('clear-history')
    try {
      await clearAntigravitySwitchHistory()
      await refreshRuntime()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {err && <div className="rounded-[8px] border border-[var(--danger)] bg-[var(--danger)]/5 px-3 py-2 text-[12px] text-[var(--danger)] break-all">{err}</div>}

      <Section
        icon={<Activity size={14} />}
        title="默认实例运行时"
        desc="控制本机已装 Antigravity IDE 进程(启 / 停 / 重启 / 聚焦)。"
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[12px] text-[var(--text-secondary)]">状态</span>
          {running === null ? (
            <span className="text-[12px] text-[var(--text-muted)]">—</span>
          ) : (
            <span className={cn('inline-flex items-center gap-1.5 text-[12px] font-semibold', running ? 'text-[var(--success)]' : 'text-[var(--text-muted)]')}>
              <span className={cn('w-1.5 h-1.5 rounded-full', running ? 'bg-[var(--success)] dot-pulse' : 'bg-[var(--text-muted)]')} />
              {running ? '运行中' : '已停止'}
            </span>
          )}
          <button onClick={() => void refreshRuntime()} className="ml-auto text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="刷新状态"><RefreshCw size={13} /></button>
        </div>
        <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-[var(--border-light)]">
          <button onClick={runtimeAction('rt-start', antigravityStartDefault)} disabled={busy === 'rt-start'} className={BTN_CLS}>
            <Play size={13} /> 启动
          </button>
          <button onClick={runtimeAction('rt-stop', antigravityStopDefault)} disabled={busy === 'rt-stop'} className={BTN_CLS}>
            <Square size={13} /> 停止
          </button>
          <button onClick={runtimeAction('rt-restart', antigravityRestartDefault)} disabled={busy === 'rt-restart'} className={BTN_CLS}>
            <RotateCcw size={13} /> 重启
          </button>
          <button onClick={runtimeAction('rt-focus', antigravityFocusDefault)} disabled={busy === 'rt-focus'} className={BTN_CLS}>
            <Eye size={13} /> 聚焦窗口
          </button>
        </div>
      </Section>

      <Section icon={<HistoryIcon size={14} />} title="切换历史" desc="自有号自动/手动切换的本地记录(最近在前)。">
        <div className="flex items-center justify-end gap-2 -mt-1">
          <button onClick={() => void refreshRuntime()} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="刷新"><RefreshCw size={13} /></button>
          <button onClick={() => void onClearHistory()} disabled={busy === 'clear-history' || history.length === 0} className="text-[12px] font-semibold px-2.5 h-[28px] rounded-[8px] border border-[var(--border)] text-[var(--danger)] hover:bg-[var(--danger)]/5 inline-flex items-center gap-1.5 disabled:opacity-50">
            <Trash2 size={13} /> 清空历史
          </button>
        </div>
        {history.length === 0 ? (
          <div className="py-6 text-center text-[12px] text-[var(--text-muted)]">还没有切换记录。自动/手动切号后这里会出现历史。</div>
        ) : (
          <div className="flex flex-col divide-y divide-[var(--border-light)]">
            {history.slice(0, 50).map((h) => (
              <div key={h.id} className="grid grid-cols-[auto_1fr_auto] gap-3 items-center py-1.5 text-[11px]">
                <span className="font-mono-data text-[var(--text-muted)]">{h.timestamp ? new Date(h.timestamp).toLocaleString() : '—'}</span>
                <span className="truncate text-[var(--text-secondary)]">
                  {h.targetEmail || h.accountId}
                  {!h.success && h.errorMessage && <span className="ml-1 text-[var(--danger)]">· {h.errorMessage}</span>}
                </span>
                <span className={cn('inline-flex items-center gap-1', h.success ? 'text-[var(--success)]' : 'text-[var(--danger)]')}>
                  {h.success ? <Check size={12} /> : <X size={12} />}{h.success ? '成功' : '失败'}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}
