import { useCallback, useEffect, useState } from 'react'
import { Plus, RefreshCw, Trash2, ArrowUpRight, Power, PlugZap, Lock, Loader2 } from 'lucide-react'
import { localApi, type LocalAccountView, type LocalGatewayStatus } from '@/services/localApi'
import { cn } from '@/lib/utils'

/**
 * 本地自有号 · Codex suite(P1:账号 tab 为主功能 + 网关运行态头部)。
 * 远程托管与本地自有号在代码与 UI 上分离;本页只管自有号。
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

export function CodexSuitePage() {
  const [accounts, setAccounts] = useState<LocalAccountView[]>([])
  const [gw, setGw] = useState<LocalGatewayStatus>({ running: false, addr: '', port: 0 })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')

  const refresh = useCallback(async () => {
    try {
      const [list, status] = await Promise.all([localApi.listCodexAccounts(), localApi.gatewayStatus()])
      setAccounts(list || [])
      setGw(status)
      setErr('')
    } catch (e) {
      setErr(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const onLogin = async () => {
    setBusy('login')
    try {
      const id = await localApi.startCodexLogin()
      await localApi.waitCodexLogin(id) // SDK 自动开浏览器,等回调
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
      if (gw.running) await localApi.gatewayStop()
      else await localApi.gatewayStart()
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

  return (
    <div className="max-w-[960px] flex flex-col gap-4">
      {/* 头部:产品 + 本地自有号 + 网关运行态 */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-[10px] bg-[var(--bg-card)] border border-[var(--border-light)] flex items-center justify-center text-[var(--text-primary)]">
            <PlugZap size={18} />
          </div>
          <div>
            <div className="text-[17px] font-bold tracking-tight text-[var(--text-primary)]">Codex</div>
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

      {err && (
        <div className="rounded-[8px] border border-[var(--danger)] bg-[var(--danger)]/5 px-3 py-2 text-[12px] text-[var(--danger)] break-all">{err}</div>
      )}

      {/* 账号列表(主功能) */}
      <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border-light)] bg-[var(--bg-tertiary)]/50">
          <span className="text-[11px] font-bold text-[var(--text-muted)] tracking-wide">我的 Codex 账号 · {accounts.length}</span>
          <button onClick={() => void refresh()} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="刷新">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        {loading ? (
          <div className="px-4 py-10 text-center text-[12px] text-[var(--text-muted)]">加载中…</div>
        ) : accounts.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <div className="text-[13px] font-semibold text-[var(--text-primary)] mb-1">还没有本地账号</div>
            <div className="text-[12px] text-[var(--text-muted)] mb-4">登录你自己的 ChatGPT 账号,接管本地 Codex CLI,凭证只留在本机。</div>
            <button onClick={onLogin} disabled={busy === 'login'} className="text-[12px] font-semibold px-3 h-[32px] rounded-[8px] bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)] inline-flex items-center gap-1.5">
              <Plus size={14} /> 登录新账号
            </button>
          </div>
        ) : (
          accounts.map((a) => {
            const st = statusLabel(a.quotaStatus)
            return (
              <div key={a.id} className={cn('grid grid-cols-[1fr_auto] gap-3 items-center px-4 py-3 border-t border-[var(--border-light)] first:border-t-0', a.priority && 'bg-[var(--primary-light)]')}>
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
                    onClick={() => act(`pool-${a.id}`, () => localApi.setPoolEnabled(a.id, !a.poolEnabled))}
                    disabled={busy === `pool-${a.id}`}
                    className={cn('text-[11px] font-semibold px-2.5 h-[28px] rounded-[7px] border', a.poolEnabled ? 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]' : 'border-[var(--primary)] text-[var(--primary-strong)] bg-[var(--primary-light)]')}
                  >
                    {a.poolEnabled ? '移出池' : '加入池'}
                  </button>
                  <button
                    onClick={() => act(`prio-${a.id}`, () => localApi.setCodexPriority(a.id))}
                    disabled={busy === `prio-${a.id}` || a.priority}
                    className="text-[11px] font-semibold px-2.5 h-[28px] rounded-[7px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
                    title="设为优先出口"
                  >
                    优先
                  </button>
                  <button
                    onClick={() => act(`del-${a.id}`, () => localApi.deleteAccount(a.id))}
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
    </div>
  )
}
