import { useCallback, useEffect, useState } from 'react'
import { Plus, RefreshCw, Trash2, ArrowUpRight, Power, PlugZap, Lock, Loader2, Download, Upload, X } from 'lucide-react'
import { type LocalAccountView, type LocalGatewayStatus, type ProviderLocalApi } from '@/services/localApi'
import { cn } from '@/lib/utils'
import { LocalStatsTab } from './LocalStatsTab'
import { LocalWakeupTab } from './LocalWakeupTab'
import { LocalInstancesTab } from './LocalInstancesTab'

/**
 * 通用「本地自有号」suite:账号 tab(主)+ 统计 tab + 网关运行态头 + 可选接管号源切换。
 * codex / antigravity 共用此组件,仅 api 与 title 不同。
 * 样式沿用 GFA 客户端 token(琥珀单色、近白/深靛、克制语义色)。
 */

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

export interface LocalProviderSuiteProps {
  title: string
  api: ProviderLocalApi
  /** 是否提供「接管模式」远程/本地切换(目前仅 codex)。 */
  supportsSource?: boolean
}

export function LocalProviderSuite({ title, api, supportsSource = false }: LocalProviderSuiteProps) {
  const [accounts, setAccounts] = useState<LocalAccountView[]>([])
  const [gw, setGw] = useState<LocalGatewayStatus>({ running: false, addr: '', port: 0 })
  const [source, setSource] = useState<'remote' | 'local'>('remote')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [tab, setTab] = useState<'accounts' | 'stats' | 'wakeup' | 'instances'>('accounts')
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
      const [list, status] = await Promise.all([api.listAccounts(), api.gatewayStatus()])
      setAccounts(list || [])
      setGw(status)
      if (supportsSource && api.getSource) {
        const src = await api.getSource()
        setSource(src === 'local' ? 'local' : 'remote')
      }
      setErr('')
    } catch (e) {
      setErr(String(e))
    } finally {
      setLoading(false)
    }
  }, [api, supportsSource])

  const onSwitchSource = async (next: 'remote' | 'local') => {
    if (next === source || !api.setSource) return
    setBusy('source')
    try {
      await api.setSource(next)
      await refresh()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

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

  const onToggleGateway = async () => {
    setBusy('gateway')
    try {
      if (gw.running) await api.gatewayStop()
      else await api.gatewayStart()
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
    <div className="max-w-[960px] flex flex-col gap-4">
      {/* 头部:产品 + 本地自有号 + 网关运行态 */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-[10px] bg-[var(--bg-card)] border border-[var(--border-light)] flex items-center justify-center text-[var(--text-primary)]">
            <PlugZap size={18} />
          </div>
          <div>
            <div className="text-[17px] font-bold tracking-tight text-[var(--text-primary)]">{title}</div>
            <div className="flex items-center gap-2 mt-0.5 text-[11px] text-[var(--text-secondary)]">
              <span className="px-2 py-0.5 rounded-full bg-[var(--primary-light)] text-[var(--primary-strong)] font-semibold">本地自有号</span>
              <span className="inline-flex items-center gap-1.5">
                <span className={cn('w-1.5 h-1.5 rounded-full', gw.running ? 'bg-[var(--success)] dot-pulse' : 'bg-[var(--text-muted)]')} />
                {gw.running ? `网关 ${gw.addr}` : '网关未启动'}
              </span>
              <span className="inline-flex items-center gap-1 text-[var(--success)]"><Lock size={11} /> 仅自有号</span>
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onToggleGateway}
            disabled={busy === 'gateway'}
            className="text-[12px] font-semibold px-3 h-[34px] rounded-[8px] border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <Power size={14} /> {gw.running ? '停止网关' : '启动网关'}
          </button>
          <button
            onClick={onLogin}
            disabled={busy === 'login'}
            className="text-[12px] font-semibold px-3 h-[34px] rounded-[8px] bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)] inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            {busy === 'login' ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} 登录新账号
          </button>
        </div>
      </div>

      {/* 接管模式:远程托管 vs 本地自有号(互斥,仅支持的 provider) */}
      {supportsSource && (
        <div className="flex items-center justify-between rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3">
          <div>
            <div className="text-[12px] font-semibold text-[var(--text-primary)]">接管模式</div>
            <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
              {source === 'local' ? `本地自有号:${title} CLI 指向本地网关,用你自己的账号。` : `远程托管:${title} 用通行证租号(在主页接管面板开启)。`}
            </div>
          </div>
          <div className="inline-flex bg-[var(--bg-tertiary)] rounded-[9px] p-[3px]">
            {(['remote', 'local'] as const).map((m) => (
              <button
                key={m}
                onClick={() => onSwitchSource(m)}
                disabled={busy === 'source'}
                className={cn(
                  'px-3 py-[5px] rounded-[7px] text-[12px] font-semibold transition-colors disabled:opacity-60',
                  source === m ? 'bg-[var(--bg-card)] text-[var(--primary-strong)] shadow-sm' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                )}
              >
                {m === 'remote' ? '远程托管' : '本地自有号'}
              </button>
            ))}
          </div>
        </div>
      )}

      {err && (
        <div className="rounded-[8px] border border-[var(--danger)] bg-[var(--danger)]/5 px-3 py-2 text-[12px] text-[var(--danger)] break-all">{err}</div>
      )}

      {/* tab 栏:账号(主) / 统计 */}
      <div className="flex gap-5 border-b border-[var(--border-light)]">
        {([['accounts', '账号'], ['stats', '统计'], ['wakeup', '保活'], ['instances', '实例']] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              'py-2 text-[13px] font-semibold border-b-2 -mb-px transition-colors',
              tab === id ? 'text-[var(--text-primary)] border-[var(--primary)]' : 'text-[var(--text-muted)] border-transparent hover:text-[var(--text-secondary)]'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'stats' && <LocalStatsTab api={api} />}
      {tab === 'wakeup' && <LocalWakeupTab api={api} />}
      {tab === 'instances' && <LocalInstancesTab api={api} />}

      {/* 账号列表(主功能) */}
      {tab === 'accounts' && (
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
      )}

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
