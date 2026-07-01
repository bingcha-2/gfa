import { useCallback, useEffect, useState } from 'react'
import {
  RefreshCw, Trash2, Play, Square, RotateCcw, Eye, History as HistoryIcon, Check, X, Package,
} from 'lucide-react'
import {
  type AntigravitySwitchHistoryItem, type AntigravityAppView,
  antigravityApps, antigravityAppStart, antigravityAppStop, antigravityAppRestart, antigravityAppFocus,
  antigravitySwitchHistory, clearAntigravitySwitchHistory,
} from '@/services/localApi'
import { cn } from '@/lib/utils'

/**
 * Antigravity 运行时:Antigravity 是两个独立 app —— Antigravity IDE(编辑器)与 Antigravity(独立版)。
 * 各自可检测/启停/重启/聚焦(对齐 cockpit 的两个 RuntimeTarget);外加自有号切换历史。
 * 只在 antigravity 的「实例」tab 里挂载(codex 无此块)。
 *
 * 红线:只控制本机 app 进程,切换历史只读写本地 JSON,与远程租号 / 网关出口无关。
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
  'text-[12px] font-semibold px-3 h-[30px] rounded-[8px] border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed'

export function LocalAntigravityRuntimeTab() {
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [apps, setApps] = useState<AntigravityAppView[]>([])
  const [history, setHistory] = useState<AntigravitySwitchHistoryItem[]>([])

  const refreshRuntime = useCallback(async () => {
    try {
      const [a, h] = await Promise.all([antigravityApps(), antigravitySwitchHistory()])
      setApps(a || [])
      setHistory(h || [])
      setErr('')
    } catch (e) {
      setErr(String(e))
    }
  }, [])

  useEffect(() => { void refreshRuntime() }, [refreshRuntime])

  const act = (key: string, fn: () => Promise<void>) => async () => {
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

  const onClearHistory = act('clear-history', clearAntigravitySwitchHistory)

  return (
    <div className="flex flex-col gap-4">
      {err && <div className="rounded-[8px] border border-[var(--danger)] bg-[var(--danger)]/5 px-3 py-2 text-[12px] text-[var(--danger)] break-all">{err}</div>}

      <Section
        icon={<Package size={14} />}
        title="Antigravity 应用运行时"
        desc="Antigravity 有两个独立 app:IDE(编辑器)与独立版。各自检测 / 启动 / 停止 / 重启 / 聚焦。"
      >
        <div className="flex items-center justify-end -mt-1">
          <button onClick={() => void refreshRuntime()} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="刷新状态"><RefreshCw size={13} /></button>
        </div>
        <div className="grid md:grid-cols-2 gap-3">
          {apps.map((appv) => {
            const on = appv.variant
            return (
              <div key={on} className="rounded-[10px] border border-[var(--border-light)] bg-[var(--bg-tertiary)]/40 p-3 flex flex-col gap-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-semibold text-[var(--text-primary)]">{appv.name}</span>
                  {!appv.detected ? (
                    <span className="text-[11px] text-[var(--text-muted)]">未安装</span>
                  ) : (
                    <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-semibold', appv.running ? 'text-[var(--success)]' : 'text-[var(--text-muted)]')}>
                      <span className={cn('w-1.5 h-1.5 rounded-full', appv.running ? 'bg-[var(--success)] dot-pulse' : 'bg-[var(--text-muted)]')} />
                      {appv.running ? '运行中' : '已停止'}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button onClick={act(`start-${on}`, () => antigravityAppStart(on))} disabled={!appv.detected || busy === `start-${on}`} className={BTN_CLS}>
                    <Play size={12} /> 启动
                  </button>
                  <button onClick={act(`stop-${on}`, () => antigravityAppStop(on))} disabled={!appv.detected || busy === `stop-${on}`} className={BTN_CLS}>
                    <Square size={12} /> 停止
                  </button>
                  <button onClick={act(`restart-${on}`, () => antigravityAppRestart(on))} disabled={!appv.detected || busy === `restart-${on}`} className={BTN_CLS}>
                    <RotateCcw size={12} /> 重启
                  </button>
                  <button onClick={act(`focus-${on}`, () => antigravityAppFocus(on))} disabled={!appv.detected || busy === `focus-${on}`} className={BTN_CLS}>
                    <Eye size={12} /> 聚焦
                  </button>
                </div>
              </div>
            )
          })}
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
