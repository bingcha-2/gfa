import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2, RefreshCw, Layers, Play } from 'lucide-react'
import { type ProviderLocalApi, type InstanceProfile, type LocalAccountView } from '@/services/localApi'

/**
 * 通用多实例 tab:管理隔离 profile(每实例独立 user-data-dir + 可绑账号)。
 * 启动真实 app(进程隔离)需在已安装目标 app 的真机上接入,这里先做 profile 管理。
 */
export function LocalInstancesTab({ api }: { api: ProviderLocalApi }) {
  const [list, setList] = useState<InstanceProfile[]>([])
  const [accounts, setAccounts] = useState<LocalAccountView[]>([])
  const [name, setName] = useState('')
  const [dir, setDir] = useState('')
  const [bind, setBind] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')

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
            <div key={p.id} className="grid grid-cols-[1fr_auto] gap-3 items-center px-4 py-3 border-t border-[var(--border-light)] first:border-t-0">
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
          ))
        )}
      </div>
    </div>
  )
}
