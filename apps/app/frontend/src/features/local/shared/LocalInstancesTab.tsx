import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, RefreshCw, Layers, Play, SlidersHorizontal, MessagesSquare, RotateCcw } from 'lucide-react'
import {
  type ProviderLocalApi, type InstanceProfile, type LocalAccountView,
  type SessionRecord, type SessionTokenStats, type TrashedSessionRecord,
  type RepairInstanceOption,
  instanceSetQuickConfig,
  listCodexSessions, codexSessionTokenStats, moveCodexSessionsToTrash,
  listTrashedCodexSessions, restoreCodexSessionsFromTrash,
  syncCodexSessionsToInstance, repairCodexSessionVisibility, listCodexSessionVisibilityRepairInstances,
} from '@/services/localApi'
import { cn } from '@/lib/utils'

/**
 * 通用多实例 tab:管理隔离 profile(每实例独立 user-data-dir + 可绑账号)。
 * 启动真实 app(进程隔离)需在已安装目标 app 的真机上接入,这里先做 profile 管理。
 *
 * 实例增强(Wave I):每行可展开「配置」面板 —— 启动方式(GUI/CLI)、跟随当前账号、
 * 快捷上下文窗口/压缩阈值,统一经 instanceSetQuickConfig 落盘。
 * 跨实例会话(Wave J · codex):列会话 / token 统计 / 移入废纸篓 / 废纸篓恢复。
 */

const LAUNCH_MODES: [string, string][] = [
  ['gui', 'GUI'],
  ['cli', 'CLI'],
]

/** 受控数字输入:空串 → null;否则正整数。沿用 cockpit 口径(0/非法视为不配置)。 */
function parseIntOrNull(v: string): number | null {
  const t = v.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

function Switch({ label, checked, onToggle, busy }: {
  label: string; checked: boolean; onToggle: () => void; busy: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={busy}
      onClick={onToggle}
      className={cn(
        'cursor-pointer w-[42px] h-[24px] rounded-full relative transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed',
        checked ? 'bg-[var(--primary)]' : 'bg-[#cbd2dc]',
      )}
    >
      <span className={cn('absolute top-[3px] w-[18px] h-[18px] rounded-full bg-white transition-all', checked ? 'right-[3px]' : 'left-[3px]')} />
    </button>
  )
}

/** 每实例的配置面板:启动方式 / 跟随当前账号 / 快捷上下文,落盘走 instanceSetQuickConfig。 */
function InstanceConfigPanel({ p, onSaved, onError }: {
  p: InstanceProfile; onSaved: () => void; onError: (e: string) => void
}) {
  const [launchMode, setLaunchMode] = useState(p.launchMode === 'cli' ? 'cli' : 'gui')
  const [follow, setFollow] = useState(!!p.followLocalAccount)
  const [ctx, setCtx] = useState(p.quickContextWindow ? String(p.quickContextWindow) : '')
  const [compact, setCompact] = useState(p.quickAutoCompact ? String(p.quickAutoCompact) : '')
  const [busy, setBusy] = useState(false)

  const persist = async (next: { launchMode?: string; follow?: boolean; ctx?: string; compact?: string }) => {
    const lm = next.launchMode ?? launchMode
    const fl = next.follow ?? follow
    const c = next.ctx ?? ctx
    const cp = next.compact ?? compact
    setBusy(true)
    try {
      await instanceSetQuickConfig(p.id, lm, p.appSpeed || 'standard', fl, parseIntOrNull(c), parseIntOrNull(cp))
      onSaved()
    } catch (e) {
      onError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 rounded-[8px] border border-[var(--border-light)] bg-[var(--bg-tertiary)]/40 p-3 flex flex-col gap-3">
      {/* 启动方式 */}
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px] font-semibold text-[var(--text-primary)]">启动方式</div>
        <div className="inline-flex rounded-[8px] border border-[var(--border)] overflow-hidden">
          {LAUNCH_MODES.map(([id, label]) => {
            const active = launchMode === id
            return (
              <button
                key={id}
                type="button"
                aria-pressed={active}
                disabled={busy}
                onClick={() => { setLaunchMode(id); void persist({ launchMode: id }) }}
                className={cn(
                  'text-[11px] font-semibold px-3 h-[28px] transition-colors disabled:opacity-50',
                  active ? 'bg-[var(--primary)] text-[var(--primary-ink)]' : 'bg-[var(--bg-card)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
                )}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      {/* 跟随当前账号 */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[12px] font-semibold text-[var(--text-primary)]">跟随当前账号</div>
          <div className="text-[10px] text-[var(--text-muted)] mt-0.5">启动时自动注入本地当前(优先级)号</div>
        </div>
        <Switch label="跟随当前账号" checked={follow} busy={busy} onToggle={() => { const v = !follow; setFollow(v); void persist({ follow: v }) }} />
      </div>

      {/* 快捷上下文窗口 / 压缩阈值 */}
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-[var(--text-secondary)]">上下文窗口</span>
          <input
            aria-label="上下文窗口"
            value={ctx}
            disabled={busy}
            placeholder="继承官方"
            onChange={(e) => setCtx(e.target.value)}
            onBlur={() => void persist({})}
            className="rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 h-[30px] text-[12px] font-mono-data text-[var(--text-primary)] disabled:opacity-50"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-[var(--text-secondary)]">压缩阈值</span>
          <input
            aria-label="压缩阈值"
            value={compact}
            disabled={busy}
            placeholder="继承官方"
            onChange={(e) => setCompact(e.target.value)}
            onBlur={() => void persist({})}
            className="rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 h-[30px] text-[12px] font-mono-data text-[var(--text-primary)] disabled:opacity-50"
          />
        </label>
      </div>
    </div>
  )
}

/** 跨实例会话区(codex):活动会话 + 废纸篓两视图。 */
function CrossInstanceSessions({ onError }: { onError: (e: string) => void }) {
  const [view, setView] = useState<'active' | 'trash'>('active')
  const [titleQuery, setTitleQuery] = useState('')
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [trashed, setTrashed] = useState<TrashedSessionRecord[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [stats, setStats] = useState<Record<string, SessionTokenStats>>({})
  const [busy, setBusy] = useState(false)
  // 跨实例同步 / 可见性修复(Wave N)。
  const [repairInstances, setRepairInstances] = useState<RepairInstanceOption[]>([])
  const [moveTarget, setMoveTarget] = useState('')
  const [syncMsg, setSyncMsg] = useState('')

  useEffect(() => {
    void listCodexSessionVisibilityRepairInstances().then((x: RepairInstanceOption[]) => setRepairInstances(x || [])).catch(() => {})
  }, [])

  const onMoveToInstance = async () => {
    if (selectedIds.length === 0 || !moveTarget) return
    setBusy(true); setSyncMsg('')
    try {
      const s = await syncCodexSessionsToInstance(selectedIds, moveTarget)
      setSyncMsg(`已同步 ${s.syncedSessionCount} 个会话到「${s.targetInstanceName || moveTarget}」(跳过 ${s.skippedExistingCount})`)
      setSelected(new Set())
    } catch (e) {
      onError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const onRepairVisibility = async () => {
    setBusy(true); setSyncMsg('')
    try {
      const s = await repairCodexSessionVisibility('')
      setSyncMsg(`已修复可见性:改写 ${s.changedRolloutFileCount} 个 rollout 文件(${s.mutatedInstanceCount}/${s.instanceCount} 实例)`)
    } catch (e) {
      onError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const loadActive = useCallback(async (q = '') => {
    setBusy(true)
    try {
      const items = await listCodexSessions(q, '')
      setSessions(items || [])
    } catch (e) {
      onError(String(e))
    } finally {
      setBusy(false)
    }
  }, [onError])

  const loadTrash = useCallback(async () => {
    setBusy(true)
    try {
      const items = await listTrashedCodexSessions()
      setTrashed(items || [])
    } catch (e) {
      onError(String(e))
    } finally {
      setBusy(false)
    }
  }, [onError])

  // 切视图时清空勾选(活动/废纸篓两套选区互不沿用)。
  useEffect(() => { setSelected(new Set()) }, [view])

  // 活动视图:按 (view, titleQuery) 拉一次;废纸篓:切到时拉一次。单一来源,避免双拉。
  useEffect(() => {
    if (view === 'active') void loadActive(titleQuery)
    else void loadTrash()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, titleQuery])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const selectedIds = useMemo(() => Array.from(selected), [selected])

  const onTokenStats = async () => {
    if (selectedIds.length === 0) return
    setBusy(true)
    try {
      const rows = await codexSessionTokenStats(selectedIds)
      const map: Record<string, SessionTokenStats> = {}
      for (const r of rows || []) map[r.sessionId] = r
      setStats(map)
    } catch (e) {
      onError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const onTrash = async () => {
    if (selectedIds.length === 0) return
    setBusy(true)
    try {
      await moveCodexSessionsToTrash(selectedIds)
      setSelected(new Set())
      await loadActive(titleQuery)
    } catch (e) {
      onError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const onRestore = async () => {
    if (selectedIds.length === 0) return
    setBusy(true)
    try {
      await restoreCodexSessionsFromTrash(selectedIds)
      setSelected(new Set())
      await loadTrash()
    } catch (e) {
      onError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-[var(--border-light)] bg-[var(--bg-tertiary)]/50">
        <div className="inline-flex rounded-[8px] border border-[var(--border)] overflow-hidden">
          {([['active', '活动会话'], ['trash', '废纸篓']] as [typeof view, string][]).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={view === id}
              onClick={() => setView(id)}
              className={cn(
                'text-[11px] font-semibold px-3 h-[28px] transition-colors',
                view === id ? 'bg-[var(--primary)] text-[var(--primary-ink)]' : 'bg-[var(--bg-card)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
              )}
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
              <select
                aria-label="同步会话到实例"
                value={moveTarget}
                onChange={(e) => setMoveTarget(e.target.value)}
                className="rounded-[7px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-1.5 h-[28px] text-[11px] text-[var(--text-primary)] max-w-[110px]"
              >
                <option value="">移到实例…</option>
                {repairInstances.map((it) => <option key={it.id} value={it.id}>{it.name || it.id}</option>)}
              </select>
              <button onClick={() => void onMoveToInstance()} disabled={busy || selectedIds.length === 0 || !moveTarget} className="text-[11px] font-semibold px-2.5 h-[28px] rounded-[7px] border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50">移到实例</button>
              <button onClick={() => void onRepairVisibility()} disabled={busy} className="text-[11px] font-semibold px-2.5 h-[28px] rounded-[7px] border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50" title="重建跨实例会话可见性元数据">修复可见性</button>
            </>
          ) : (
            <button onClick={() => void onRestore()} disabled={busy || selectedIds.length === 0} className="text-[11px] font-semibold px-2.5 h-[28px] rounded-[7px] border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] inline-flex items-center gap-1 disabled:opacity-50"><RotateCcw size={12} /> 恢复</button>
          )}
        </div>
      </div>

      {syncMsg && <div className="px-4 py-1.5 text-[11px] text-[var(--success)] border-t border-[var(--border-light)]">{syncMsg}</div>}

      {view === 'active' ? (
        sessions.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-[var(--text-muted)]">没有会话。会话跨所有实例去重展示。</div>
        ) : (
          sessions.map((s) => (
            <div key={s.sessionId} className="flex items-center gap-3 px-4 py-2.5 border-t border-[var(--border-light)] first:border-t-0">
              <input type="checkbox" aria-label={`选择会话 ${s.title}`} checked={selected.has(s.sessionId)} onChange={() => toggle(s.sessionId)} className="accent-[var(--primary)]" />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold text-[var(--text-primary)] truncate">{s.title || s.sessionId}</div>
                <div className="text-[10px] font-mono-data text-[var(--text-muted)] truncate">{s.cwd}</div>
              </div>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-muted)] shrink-0">{s.locationCount} 个实例</span>
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
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-muted)] shrink-0">{s.locationCount} 个实例</span>
            </div>
          ))
        )
      )}
    </div>
  )
}

export function LocalInstancesTab({ api }: { api: ProviderLocalApi }) {
  const [list, setList] = useState<InstanceProfile[]>([])
  const [accounts, setAccounts] = useState<LocalAccountView[]>([])
  const [name, setName] = useState('')
  const [dir, setDir] = useState('')
  const [bind, setBind] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [configId, setConfigId] = useState<string | null>(null)
  const [showSessions, setShowSessions] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [items, accs] = await Promise.all([api.instanceList(), api.listAccounts()])
      setList(items || [])
      setAccounts(accs || [])
      setErr('')
    } catch (e) {
      setErr(String(e))
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => { void refresh() }, [refresh])

  /** 跨实例会话只有 codex 提供(listCodexSessions 等 codex-only);按实例 provider 推断。 */
  const isCodex = list.some((p) => p.provider === 'codex')

  const onCreate = async () => {
    if (!name.trim() || !dir.trim()) return
    setBusy('create')
    try {
      await api.instanceCreate(name.trim(), dir.trim(), '', '', bind)
      setName(''); setDir(''); setBind('')
      await refresh()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  const onDelete = async (id: string) => {
    setBusy(`del-${id}`)
    try { await api.instanceDelete(id); await refresh() } catch (e) { setErr(String(e)) } finally { setBusy(null) }
  }

  const onLaunch = async (id: string) => {
    setBusy(`launch-${id}`)
    try { await api.instanceLaunch(id); await refresh() } catch (e) { setErr(String(e)) } finally { setBusy(null) }
  }

  const onStop = async (id: string) => {
    setBusy(`stop-${id}`)
    try { await api.instanceStop(id); await refresh() } catch (e) { setErr(String(e)) } finally { setBusy(null) }
  }

  const onRebind = async (p: InstanceProfile, accId: string) => {
    setBusy(`bind-${p.id}`)
    try { await api.instanceUpdate({ ...p, bindAccountId: accId }); await refresh() } catch (e) { setErr(String(e)) } finally { setBusy(null) }
  }

  if (loading) return <div className="px-4 py-10 text-center text-[12px] text-[var(--text-muted)]">加载中…</div>

  return (
    <div className="flex flex-col gap-4">
      {err && <div className="rounded-[8px] border border-[var(--danger)] bg-[var(--danger)]/5 px-3 py-2 text-[12px] text-[var(--danger)] break-all">{err}</div>}

      {/* 创建表单 */}
      <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] p-4 flex flex-col gap-3">
        <div className="text-[12px] font-semibold text-[var(--text-primary)] inline-flex items-center gap-1.5"><Layers size={14} /> 新建实例</div>
        <div className="grid grid-cols-2 gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="实例名称" aria-label="实例名称" className="rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 h-[32px] text-[12px] text-[var(--text-primary)]" />
          <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="user-data 目录" aria-label="user-data 目录" className="rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 h-[32px] text-[12px] font-mono-data text-[var(--text-primary)]" />
        </div>
        <div className="flex items-center gap-2">
          <select value={bind} onChange={(e) => setBind(e.target.value)} aria-label="绑定账号" className="flex-1 rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 h-[32px] text-[12px] text-[var(--text-primary)]">
            <option value="">不绑定账号</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}
          </select>
          <button onClick={onCreate} disabled={busy === 'create' || !name.trim() || !dir.trim()} className="text-[12px] font-semibold px-3 h-[32px] rounded-[8px] bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)] inline-flex items-center gap-1.5 disabled:opacity-50">
            <Plus size={14} /> 创建
          </button>
        </div>
      </div>

      {/* 列表 */}
      <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border-light)] bg-[var(--bg-tertiary)]/50">
          <span className="text-[11px] font-bold text-[var(--text-muted)] tracking-wide">实例 · {list.length}</span>
          <button onClick={() => void refresh()} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="刷新"><RefreshCw size={13} /></button>
        </div>
        {list.length === 0 ? (
          <div className="px-4 py-10 text-center text-[12px] text-[var(--text-muted)]">还没有实例。每个实例有独立的 user-data 目录,可绑定不同账号。</div>
        ) : (
          list.map((p) => (
            <div key={p.id} className="px-4 py-3 border-t border-[var(--border-light)] first:border-t-0">
              <div className="grid grid-cols-[1fr_auto] gap-3 items-center">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-[13px] text-[var(--text-primary)] truncate">{p.name}</span>
                    {p.pid ? <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[rgba(22,163,74,0.12)] text-[#15803d]">运行中</span> : null}
                    <select value={p.bindAccountId || ''} onChange={(e) => onRebind(p, e.target.value)} disabled={busy === `bind-${p.id}` || !!p.pid} aria-label="改绑账号" className="text-[10px] bg-transparent border border-[var(--border-light)] rounded px-1 py-0.5 text-[var(--text-muted)] max-w-[150px] disabled:opacity-50">
                      <option value="">不绑定账号</option>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}
                    </select>
                  </div>
                  <div className="text-[10px] font-mono-data text-[var(--text-muted)] truncate mt-0.5">{p.userDataDir}</div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => setConfigId(configId === p.id ? null : p.id)} aria-label="配置实例" aria-expanded={configId === p.id} title="配置实例" className={cn('w-7 h-7 inline-flex items-center justify-center rounded-[7px] border border-[var(--border)] hover:bg-[var(--bg-hover)]', configId === p.id ? 'text-[var(--primary-strong)]' : 'text-[var(--text-secondary)]')}><SlidersHorizontal size={14} /></button>
                  {p.pid ? (
                    <button onClick={() => onStop(p.id)} disabled={busy === `stop-${p.id}`} className="text-[11px] font-semibold px-2.5 h-[28px] rounded-[7px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-50">停止</button>
                  ) : (
                    <button onClick={() => onLaunch(p.id)} disabled={busy === `launch-${p.id}`} title="需已安装目标 app" className="text-[11px] font-semibold px-2.5 h-[28px] rounded-[7px] border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] inline-flex items-center gap-1 disabled:opacity-50">
                      <Play size={12} /> 启动
                    </button>
                  )}
                  <button onClick={() => onDelete(p.id)} disabled={busy === `del-${p.id}`} className="text-[var(--text-muted)] hover:text-[var(--danger)] w-7 h-7 inline-flex items-center justify-center rounded-[7px] hover:bg-[var(--danger)]/10" title="删除"><Trash2 size={14} /></button>
                </div>
              </div>
              {configId === p.id ? (
                <InstanceConfigPanel p={p} onSaved={() => void refresh()} onError={setErr} />
              ) : null}
            </div>
          ))
        )}
      </div>

      {/* 跨实例会话(codex)*/}
      {isCodex ? (
        <div className="flex flex-col gap-3">
          <button
            onClick={() => setShowSessions((v) => !v)}
            aria-expanded={showSessions}
            className="self-start text-[12px] font-semibold px-3 h-[32px] rounded-[8px] border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] inline-flex items-center gap-1.5"
          >
            <MessagesSquare size={14} /> 跨实例会话
          </button>
          {showSessions ? <CrossInstanceSessions onError={setErr} /> : null}
        </div>
      ) : null}
    </div>
  )
}
