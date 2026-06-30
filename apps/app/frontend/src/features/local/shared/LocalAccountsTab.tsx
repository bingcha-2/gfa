import { useCallback, useEffect, useState } from 'react'
import { Plus, RefreshCw, Trash2, ArrowUpRight, Loader2, Download, Upload, X } from 'lucide-react'
import { type LocalAccountView, type ProviderLocalApi } from '@/services/localApi'
import { cn } from '@/lib/utils'

/** 账号 tab(本地主功能):列表 + 登录 + 池/优先/删除 + 导入导出 + 批量多选。 */

function planBadgeClass(plan: string): string {
  if (/pro/i.test(plan)) return 'bg-[var(--primary-light)] text-[var(--primary-strong)]'
  return 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
}

function statusLabel(s: string): { text: string; cls: string } {
  switch (s) {
    case 'ok': return { text: '在线', cls: 'text-[var(--success)]' }
    case 'cooling': return { text: '冷却中', cls: 'text-[var(--warning)]' }
    case 'exhausted': return { text: '额度用尽', cls: 'text-[var(--danger)]' }
    case 'error': return { text: '需重登', cls: 'text-[var(--danger)]' }
    default: return { text: '未知', cls: 'text-[var(--text-muted)]' }
  }
}

function QuotaBar({ label, percent }: { label: string; percent: number }) {
  const p = Math.max(0, Math.min(100, percent))
  const color = p >= 90 ? 'var(--danger)' : p >= 75 ? 'var(--warning)' : 'var(--primary)'
  return (
    <div className="flex-1 min-w-[80px]">
      <div className="flex justify-between text-[10px] text-[var(--text-muted)] mb-1">
        <span>{label}</span>
        <span className="font-mono-data">{p}%</span>
      </div>
      <div className="h-[5px] rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${p}%`, background: color }} />
      </div>
    </div>
  )
}

export function LocalAccountsTab({ title, api }: { title: string; api: ProviderLocalApi }) {
  const [accounts, setAccounts] = useState<LocalAccountView[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const toggleSel = (id: string) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const refresh = useCallback(async () => {
    try {
      setAccounts((await api.listAccounts()) || [])
      setErr('')
    } catch (e) {
      setErr(String(e))
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => { void refresh() }, [refresh])

  const onLogin = async () => {
    setBusy('login')
    try {
      const id = await api.startLogin()
      await api.waitLogin(id) // SDK 自动开浏览器,等回调
      await refresh()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    try { await fn(); await refresh() } catch (e) { setErr(String(e)) } finally { setBusy(null) }
  }

  const onExport = async () => {
    setBusy('export')
    try {
      const json = await api.exportAccounts([])
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${title.toLowerCase()}-accounts.json`
      link.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  const onBatchDelete = async () => {
    if (selected.size === 0) return
    setBusy('batch')
    try {
      await api.deleteAccounts([...selected])
      setSelected(new Set())
      await refresh()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  const onImportConfirm = async () => {
    setBusy('import')
    try {
      await api.importFromJSON(importText)
      setImportOpen(false)
      setImportText('')
      await refresh()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {err && <div className="rounded-[8px] border border-[var(--danger)] bg-[var(--danger)]/5 px-3 py-2 text-[12px] text-[var(--danger)] break-all">{err}</div>}

      <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border-light)] bg-[var(--bg-tertiary)]/50">
          <span className="text-[11px] font-bold text-[var(--text-muted)] tracking-wide">我的 {title} 账号 · {accounts.length}</span>
          <div className="flex items-center gap-1.5">
            <button onClick={() => setImportOpen(true)} className="text-[11px] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex items-center gap-1" title="从 JSON 导入">
              <Upload size={12} /> 导入
            </button>
            <button onClick={onExport} disabled={busy === 'export' || accounts.length === 0} className="text-[11px] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex items-center gap-1 disabled:opacity-40" title="导出全部为 JSON">
              <Download size={12} /> 导出
            </button>
            <button onClick={onLogin} disabled={busy === 'login'} className="text-[11px] font-semibold px-2.5 h-[26px] rounded-[7px] bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)] inline-flex items-center gap-1 disabled:opacity-50">
              {busy === 'login' ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} 登录
            </button>
            <button onClick={() => void refresh()} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] ml-1" title="刷新">
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {selected.size > 0 && (
          <div className="flex items-center justify-between px-4 py-2 bg-[var(--primary-light)] border-b border-[var(--border-light)] text-[12px]">
            <span className="text-[var(--primary-strong)] font-semibold">已选 {selected.size}</span>
            <div className="flex gap-3">
              <button onClick={() => setSelected(new Set())} className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]">取消</button>
              <button onClick={onBatchDelete} disabled={busy === 'batch'} className="text-[var(--danger)] font-semibold hover:underline disabled:opacity-50">批量删除</button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="px-4 py-10 text-center text-[12px] text-[var(--text-muted)]">加载中…</div>
        ) : accounts.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <div className="text-[13px] font-semibold text-[var(--text-primary)] mb-1">还没有本地账号</div>
            <div className="text-[12px] text-[var(--text-muted)] mb-4">登录你自己的账号,接管本地 {title},凭证只留在本机。</div>
            <button onClick={onLogin} disabled={busy === 'login'} className="text-[12px] font-semibold px-3 h-[32px] rounded-[8px] bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)] inline-flex items-center gap-1.5">
              <Plus size={14} /> 登录新账号
            </button>
          </div>
        ) : (
          accounts.map((a) => {
            const st = statusLabel(a.quotaStatus)
            return (
              <div key={a.id} className={cn('grid grid-cols-[auto_1fr_auto] gap-3 items-center px-4 py-3 border-t border-[var(--border-light)] first:border-t-0', a.priority && 'bg-[var(--primary-light)]')}>
                <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleSel(a.id)} className="w-3.5 h-3.5 accent-[var(--primary)] cursor-pointer" aria-label="选择账号" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {a.priority && <ArrowUpRight size={15} className="text-[var(--primary-strong)] shrink-0" />}
                    <span className="font-semibold text-[13px] text-[var(--text-primary)] truncate">{a.email || '(未知邮箱)'}</span>
                    {a.planType && <span className={cn('text-[10px] font-semibold px-2 py-0.5 rounded-full', planBadgeClass(a.planType))}>{a.planType}</span>}
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">{a.authKind === 'apikey' ? 'API Key' : 'OAuth'}</span>
                    <span className={cn('text-[11px] ml-1', st.cls)}>{st.text}</span>
                  </div>
                  <div className="flex gap-4 mt-2 max-w-[420px]">
                    <QuotaBar label="5 小时" percent={a.hourlyPercent} />
                    <QuotaBar label="本周" percent={a.weeklyPercent} />
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => act(`pool-${a.id}`, () => api.setPoolEnabled(a.id, !a.poolEnabled))}
                    disabled={busy === `pool-${a.id}`}
                    className={cn('text-[11px] font-semibold px-2.5 h-[28px] rounded-[7px] border', a.poolEnabled ? 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]' : 'border-[var(--primary)] text-[var(--primary-strong)] bg-[var(--primary-light)]')}
                  >
                    {a.poolEnabled ? '移出池' : '加入池'}
                  </button>
                  <button
                    onClick={() => act(`prio-${a.id}`, () => api.setPriority(a.id))}
                    disabled={busy === `prio-${a.id}` || a.priority}
                    className="text-[11px] font-semibold px-2.5 h-[28px] rounded-[7px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
                    title="设为优先出口"
                  >
                    优先
                  </button>
                  <button
                    onClick={() => act(`del-${a.id}`, () => api.deleteAccount(a.id))}
                    disabled={busy === `del-${a.id}`}
                    className="text-[var(--text-muted)] hover:text-[var(--danger)] w-7 h-7 inline-flex items-center justify-center rounded-[7px] hover:bg-[var(--danger)]/10"
                    title="删除"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>

      {importOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" onClick={() => setImportOpen(false)}>
          <div className="w-[460px] max-w-[90vw] rounded-[12px] bg-[var(--bg-card)] border border-[var(--border)] shadow-lg p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[13px] font-bold text-[var(--text-primary)]">从 JSON 导入账号</span>
              <button onClick={() => setImportOpen(false)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={15} /></button>
            </div>
            <div className="text-[11px] text-[var(--text-muted)] mb-2">粘贴导出的 JSON,按邮箱去重(已存在的自动跳过)。</div>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={8}
              placeholder='[{"email":"you@example.com","authKind":"oauth","refreshToken":"..."}]'
              className="w-full rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] p-2 text-[12px] font-mono-data text-[var(--text-primary)] resize-none"
            />
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setImportOpen(false)} className="text-[12px] font-semibold px-3 h-[32px] rounded-[8px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">取消</button>
              <button onClick={onImportConfirm} disabled={busy === 'import' || !importText.trim()} className="text-[12px] font-semibold px-3 h-[32px] rounded-[8px] bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)] disabled:opacity-50">导入</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
