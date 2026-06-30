import { useCallback, useEffect, useState } from 'react'
import { Power, Copy, Check, Loader2, Globe, Lock, Plug } from 'lucide-react'
import { type LocalGatewayStatus, type LocalStatRecent, type ProviderLocalApi } from '@/services/localApi'
import { cn } from '@/lib/utils'

/**
 * 反代 tab —— 本地网关(CLIProxyAPI)作为 OpenAI 兼容 API 服务的入口:
 * 运行态 + 启停 + base URL(可复制)+ 在服务的自有号数 + 最近请求。
 * 对应 cockpit 的「Codex API 服务」页,但收进 suite 一个 tab,不另起页面。
 * 这里只用现有绑定(gatewayStart/Stop/Status、listAccounts、stats),不依赖未实现的控制面。
 */
export function LocalGatewayTab({ api }: { api: ProviderLocalApi }) {
  const [gw, setGw] = useState<LocalGatewayStatus>({ running: false, addr: '', port: 0 })
  const [accounts, setAccounts] = useState(0)
  const [recent, setRecent] = useState<LocalStatRecent[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState(false)
  const [portInput, setPortInput] = useState('')
  const [portBusy, setPortBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const status = await api.gatewayStatus()
      setGw(status)
      setPortInput((prev) => (prev === '' && status.port > 0 ? String(status.port) : prev))
      const list = await api.listAccounts()
      setAccounts((list || []).length)
      const s = await api.stats()
      setRecent((s.recent || []).slice(0, 20))
      setErr('')
    } catch (e) {
      setErr(String(e))
    }
  }, [api])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => { void refresh() }, 4000)
    return () => clearInterval(id)
  }, [refresh])

  const onToggle = async () => {
    setBusy(true)
    setErr('')
    try {
      if (gw.running) await api.gatewayStop()
      else await api.gatewayStart()
      await refresh()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  const baseUrl = gw.addr ? `http://${gw.addr}/v1` : ''
  const onCopy = async () => {
    if (!baseUrl) return
    try {
      await navigator.clipboard.writeText(baseUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* 忽略:剪贴板不可用时不阻断 */ }
  }

  const onApplyPort = async () => {
    const port = Number(portInput)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setErr('端口需为 1–65535 的整数')
      return
    }
    if (port === gw.port) return
    setPortBusy(true)
    setErr('')
    try {
      const status = await api.setGatewayPort(port)
      setGw(status)
      setPortInput(status.port > 0 ? String(status.port) : portInput)
      await refresh()
    } catch (e) {
      setErr(String(e))
    } finally {
      setPortBusy(false)
    }
  }

  const portDirty = portInput !== '' && Number(portInput) !== gw.port

  return (
    <div className="flex flex-col gap-3">
      {err && <div className="rounded-[8px] border border-[var(--danger)] bg-[var(--danger)]/5 px-3 py-2 text-[12px] text-[var(--danger)] break-all">{err}</div>}

      {/* 运行态 + 启停 */}
      <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] p-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-[10px] bg-[var(--bg-tertiary)] flex items-center justify-center">
            <Globe size={18} className="text-[var(--text-secondary)]" />
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-[var(--text-primary)] flex items-center gap-2">
              本地反代
              <span className="inline-flex items-center gap-1 text-[10px] text-[var(--success)] font-normal"><Lock size={10} /> 仅自有号</span>
            </div>
            <div className="text-[11px] text-[var(--text-muted)] mt-0.5 inline-flex items-center gap-1.5">
              <span className={cn('w-1.5 h-1.5 rounded-full', gw.running ? 'bg-[var(--success)] dot-pulse' : 'bg-[var(--text-muted)]')} />
              {gw.running ? `运行中 · ${gw.addr}` : '未运行'} · {accounts} 个号在服务
            </div>
          </div>
        </div>
        <button
          onClick={onToggle}
          disabled={busy}
          className={cn(
            'text-[12px] font-semibold px-3 h-[34px] rounded-[8px] inline-flex items-center gap-1.5 disabled:opacity-50',
            gw.running
              ? 'border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
              : 'bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)]',
          )}
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
          {gw.running ? '停止' : '启动'}
        </button>
      </div>

      {/* 端口设置 */}
      <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] p-4">
        <div className="text-[11px] font-bold text-[var(--text-muted)] tracking-wide mb-2 inline-flex items-center gap-1.5">
          <Plug size={12} /> 反代端口(共享网关 · codex/antigravity 同口)
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={65535}
            value={portInput}
            onChange={(e) => setPortInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && portDirty && !portBusy) void onApplyPort() }}
            placeholder="8317"
            disabled={portBusy}
            className="w-[120px] rounded-[8px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-3 h-[34px] text-[12px] font-mono-data text-[var(--text-primary)] tabular-nums outline-none focus:border-[var(--primary)] disabled:opacity-50"
          />
          <button
            onClick={onApplyPort}
            disabled={portBusy || !portDirty}
            className="text-[12px] font-semibold px-3 h-[34px] rounded-[8px] bg-[var(--primary)] text-[var(--primary-ink)] hover:bg-[var(--primary-strong)] inline-flex items-center gap-1.5 disabled:opacity-50 shrink-0"
          >
            {portBusy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            应用并重启
          </button>
        </div>
        <div className="text-[11px] text-[var(--text-muted)] mt-1.5">改端口会重启网关;若端口被占用,系统会回退到下一个空闲端口。</div>
      </div>

      {/* base URL */}
      {gw.running && baseUrl && (
        <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] p-4">
          <div className="text-[11px] font-bold text-[var(--text-muted)] tracking-wide mb-2">OpenAI 兼容地址(填进任意客户端的 Base URL)</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate rounded-[8px] bg-[var(--bg-tertiary)] px-3 py-2 text-[12px] font-mono-data text-[var(--text-primary)]">{baseUrl}</code>
            <button
              onClick={onCopy}
              className="text-[12px] font-semibold px-2.5 h-[34px] rounded-[8px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] inline-flex items-center gap-1.5 shrink-0"
            >
              {copied ? <Check size={14} className="text-[var(--success)]" /> : <Copy size={14} />}
              {copied ? '已复制' : '复制'}
            </button>
          </div>
        </div>
      )}

      {/* 最近请求 */}
      <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[var(--border-light)] bg-[var(--bg-tertiary)]/50 text-[11px] font-bold text-[var(--text-muted)] tracking-wide">最近请求 · {recent.length}</div>
        {recent.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-[var(--text-muted)]">还没有请求,接管后经反代的调用会显示在这里</div>
        ) : (
          <div className="divide-y divide-[var(--border-light)]">
            {recent.map((r, i) => (
              <div key={i} className="grid grid-cols-[1fr_auto_auto] gap-3 items-center px-4 py-2 text-[12px]">
                <span className="font-mono-data text-[var(--text-primary)] truncate">{r.model || '—'}</span>
                <span className={cn('text-[11px]', r.failed ? 'text-[var(--danger)]' : 'text-[var(--success)]')}>{r.failed ? '失败' : '成功'}</span>
                <span className="text-[11px] font-mono-data text-[var(--text-muted)] tabular-nums w-[64px] text-right">{r.latencyMs}ms</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
