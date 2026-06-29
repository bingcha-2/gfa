import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Router } from 'lucide-react'
import { type LocalStatsSnapshot, type ProviderLocalApi } from '@/services/localApi'
import { formatTokens } from '@/lib/utils'

/** 通用本地统计 tab:数据来自某 provider 的本地网关用量插件,与远程主页统计分开。 */

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'primary' | 'danger' }) {
  return (
    <div className="rounded-[10px] bg-[var(--bg-tertiary)] px-3 py-2.5">
      <div className="text-[11px] text-[var(--text-muted)]">{label}</div>
      <div
        className="text-[18px] font-bold font-mono-data tabular-nums mt-0.5"
        style={{ color: tone === 'primary' ? 'var(--primary)' : tone === 'danger' ? 'var(--danger)' : 'var(--text-primary)' }}
      >
        {value}
      </div>
    </div>
  )
}

export function LocalStatsTab({ api }: { api: ProviderLocalApi }) {
  const [snap, setSnap] = useState<LocalStatsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const refresh = useCallback(async () => {
    try {
      setSnap(await api.stats())
      setErr('')
    } catch (e) {
      setErr(String(e))
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => { void refresh() }, [refresh])

  if (loading) return <div className="px-4 py-10 text-center text-[12px] text-[var(--text-muted)]">加载中…</div>
  if (err) return <div className="rounded-[8px] border border-[var(--danger)] bg-[var(--danger)]/5 px-3 py-2 text-[12px] text-[var(--danger)] break-all">{err}</div>
  if (!snap) return null

  const errRate = snap.totalRequests > 0 ? ((snap.totalFailed / snap.totalRequests) * 100).toFixed(1) : '0.0'
  const byAccount = snap.byAccount ?? []
  const byModel = snap.byModel ?? []
  const recent = snap.recent ?? []

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-[var(--text-muted)] inline-flex items-center gap-1.5"><Router size={13} /> 来源:本地网关 · 与远程主页分开</span>
        <button onClick={() => void refresh()} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="刷新"><RefreshCw size={13} /></button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        <Metric label="请求数" value={snap.totalRequests.toLocaleString()} />
        <Metric label="输入 Token" value={formatTokens(snap.totalInputTokens)} tone="primary" />
        <Metric label="输出 Token" value={formatTokens(snap.totalOutputTokens)} />
        <Metric label="错误率" value={`${errRate}%`} tone={snap.totalFailed > 0 ? 'danger' : undefined} />
      </div>

      {snap.totalRequests === 0 ? (
        <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] px-4 py-10 text-center text-[12px] text-[var(--text-muted)]">
          还没有请求。接管 CLI 并发起对话后,这里会显示按账号与模型的用量。
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-3">
          <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] p-3.5">
            <div className="text-[11px] font-bold text-[var(--text-muted)] mb-2">按账号</div>
            <div className="flex flex-col divide-y divide-[var(--border-light)]">
              {byAccount.map((a) => (
                <div key={a.authId} className="flex items-center justify-between py-1.5 text-[12px]">
                  <span className="truncate text-[var(--text-primary)] font-medium max-w-[60%]">{a.email || a.authId}</span>
                  <span className="font-mono-data text-[var(--text-secondary)]">{a.requests} · {formatTokens(a.totalTokens)}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] p-3.5">
            <div className="text-[11px] font-bold text-[var(--text-muted)] mb-2">按模型</div>
            <div className="flex flex-col divide-y divide-[var(--border-light)]">
              {byModel.map((m) => (
                <div key={m.model} className="flex items-center justify-between py-1.5 text-[12px]">
                  <span className="truncate text-[var(--text-primary)] font-medium max-w-[60%]">{m.model}</span>
                  <span className="font-mono-data text-[var(--text-secondary)]">{m.requests} · {formatTokens(m.totalTokens)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {recent.length > 0 && (
        <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] p-3.5">
          <div className="text-[11px] font-bold text-[var(--text-muted)] mb-2">最近请求</div>
          <div className="flex flex-col divide-y divide-[var(--border-light)]">
            {recent.slice(0, 10).map((r, i) => (
              <div key={i} className="grid grid-cols-[auto_1fr_auto_auto] gap-3 items-center py-1.5 text-[11px]">
                <span className="font-mono-data text-[var(--text-muted)]">{r.atMs ? new Date(r.atMs).toLocaleTimeString() : '—'}</span>
                <span className="truncate text-[var(--text-secondary)]">{r.model}</span>
                <span className="font-mono-data text-[var(--text-muted)]">{r.latencyMs ? `${r.latencyMs}ms` : '—'}</span>
                <span className={r.failed ? 'text-[var(--danger)]' : 'text-[var(--success)]'}>{r.failed ? '失败' : '成功'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
