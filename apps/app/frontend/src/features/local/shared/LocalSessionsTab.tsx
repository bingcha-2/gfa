import { useCallback, useEffect, useMemo, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import {
  type SessionRecord, type SessionTokenStats, type TrashedSessionRecord,
  listCodexSessions, codexSessionTokenStats, moveCodexSessionsToTrash,
  listTrashedCodexSessions, restoreCodexSessionsFromTrash,
} from '@/services/localApi'
import { cn } from '@/lib/utils'

/**
 * 会话管理(codex):从默认 Codex 主目录(~/.codex)读会话 —— 列表 / token 统计 /
 * 移入废纸篓 / 废纸篓恢复。多实例管理已删,会话统一来自默认主目录。
 *
 * 红线:只读写本地会话文件,与远程租号 / 网关出口无关。
 */
export function LocalSessionsTab() {
  const [view, setView] = useState<'active' | 'trash'>('active')
  const [titleQuery, setTitleQuery] = useState('')
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [trashed, setTrashed] = useState<TrashedSessionRecord[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [stats, setStats] = useState<Record<string, SessionTokenStats>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const loadActive = useCallback(async (q = '') => {
    setBusy(true)
    try { setSessions((await listCodexSessions(q, '')) || []); setErr('') } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }, [])
  const loadTrash = useCallback(async () => {
    setBusy(true)
    try { setTrashed((await listTrashedCodexSessions()) || []); setErr('') } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }, [])

  useEffect(() => { setSelected(new Set()) }, [view])
  useEffect(() => {
    if (view === 'active') void loadActive(titleQuery)
    else void loadTrash()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, titleQuery])

  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const selectedIds = useMemo(() => Array.from(selected), [selected])

  const onTokenStats = async () => {
    if (selectedIds.length === 0) return
    setBusy(true)
    try {
      const rows = await codexSessionTokenStats(selectedIds)
      const map: Record<string, SessionTokenStats> = {}
      for (const r of rows || []) map[r.sessionId] = r
      setStats(map)
    } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }
  const onTrash = async () => {
    if (selectedIds.length === 0) return
    setBusy(true)
    try { await moveCodexSessionsToTrash(selectedIds); setSelected(new Set()); await loadActive(titleQuery) } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }
  const onRestore = async () => {
    if (selectedIds.length === 0) return
    setBusy(true)
    try { await restoreCodexSessionsFromTrash(selectedIds); setSelected(new Set()); await loadTrash() } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }

  return (
    <div className="flex flex-col gap-3">
      {err && <div className="rounded-[8px] border border-[var(--danger)] bg-[var(--danger)]/5 px-3 py-2 text-[12px] text-[var(--danger)] break-all">{err}</div>}
      <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-[var(--border-light)] bg-[var(--bg-tertiary)]/50">
          <div className="inline-flex rounded-[8px] border border-[var(--border)] overflow-hidden">
            {([['active', '活动会话'], ['trash', '废纸篓']] as [typeof view, string][]).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={view === id}
                onClick={() => setView(id)}
                className={cn('text-[11px] font-semibold px-3 h-[28px] transition-colors', view === id ? 'bg-[var(--primary)] text-[var(--primary-ink)]' : 'bg-[var(--bg-card)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            {view === 'active' ? (
              <>
                <input
                  aria-label="会话标题过滤"
                  value={titleQuery}
                  onChange={(e) => setTitleQuery(e.target.value)}
                  placeholder="按标题过滤"
                  className="rounded-[7px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 h-[28px] text-[11px] text-[var(--text-primary)] w-[120px]"
                />
                <button onClick={() => void onTokenStats()} disabled={busy || selectedIds.length === 0} className="text-[11px] font-semibold px-2.5 h-[28px] rounded-[7px] border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50">统计 token</button>
                <button onClick={() => void onTrash()} disabled={busy || selectedIds.length === 0} className="text-[11px] font-semibold px-2.5 h-[28px] rounded-[7px] border border-[var(--danger)] text-[var(--danger)] hover:bg-[var(--danger)]/10 disabled:opacity-50">移入废纸篓</button>
              </>
            ) : (
              <button onClick={() => void onRestore()} disabled={busy || selectedIds.length === 0} className="text-[11px] font-semibold px-2.5 h-[28px] rounded-[7px] border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] inline-flex items-center gap-1 disabled:opacity-50"><RotateCcw size={12} /> 恢复</button>
            )}
          </div>
        </div>

        {view === 'active' ? (
          sessions.length === 0 ? (
            <div className="px-4 py-8 text-center text-[12px] text-[var(--text-muted)]">没有会话。</div>
          ) : (
            sessions.map((s) => (
              <div key={s.sessionId} className="flex items-center gap-3 px-4 py-2.5 border-t border-[var(--border-light)] first:border-t-0">
                <input type="checkbox" aria-label={`选择会话 ${s.title}`} checked={selected.has(s.sessionId)} onChange={() => toggle(s.sessionId)} className="accent-[var(--primary)]" />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold text-[var(--text-primary)] truncate">{s.title || s.sessionId}</div>
                  <div className="text-[10px] font-mono-data text-[var(--text-muted)] truncate">{s.cwd}</div>
                </div>
                {stats[s.sessionId] ? (
                  <span className="text-[10px] font-mono-data text-[var(--text-secondary)] shrink-0">{stats[s.sessionId].totalTokens} tok</span>
                ) : null}
              </div>
            ))
          )
        ) : (
          trashed.length === 0 ? (
            <div className="px-4 py-8 text-center text-[12px] text-[var(--text-muted)]">废纸篓为空。</div>
          ) : (
            trashed.map((s) => (
              <div key={s.sessionId} className="flex items-center gap-3 px-4 py-2.5 border-t border-[var(--border-light)] first:border-t-0">
                <input type="checkbox" aria-label={`选择会话 ${s.title}`} checked={selected.has(s.sessionId)} onChange={() => toggle(s.sessionId)} className="accent-[var(--primary)]" />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold text-[var(--text-primary)] truncate">{s.title || s.sessionId}</div>
                  <div className="text-[10px] font-mono-data text-[var(--text-muted)] truncate">{s.cwd}</div>
                </div>
              </div>
            ))
          )
        )}
      </div>
    </div>
  )
}
