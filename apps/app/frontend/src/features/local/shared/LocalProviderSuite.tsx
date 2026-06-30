import { useCallback, useEffect, useState } from 'react'
import { Power, PlugZap, Lock } from 'lucide-react'
import { type LocalGatewayStatus, type ProviderLocalApi } from '@/services/localApi'
import { cn } from '@/lib/utils'
import { LocalAccountsTab } from './LocalAccountsTab'
import { LocalStatsTab } from './LocalStatsTab'
import { LocalWakeupTab } from './LocalWakeupTab'
import { LocalInstancesTab } from './LocalInstancesTab'

/**
 * 通用「本地自有号」suite —— 纯编排壳:
 * 头部(网关运行态 + 启停 + 可选接管号源切换)+ tab 栏 + 四个独立 tab 组件
 *(账号/统计/保活/实例)。codex / antigravity 共用,仅 api 与 title 不同。
 * 样式沿用 GFA 客户端 token(琥珀单色、近白/深靛、克制语义色)。
 */

export interface LocalProviderSuiteProps {
  title: string
  api: ProviderLocalApi
  /** 是否提供「接管模式」远程/本地切换。 */
  supportsSource?: boolean
}

const TABS = [['accounts', '账号'], ['stats', '统计'], ['wakeup', '保活'], ['instances', '实例']] as const
type TabId = (typeof TABS)[number][0]

export function LocalProviderSuite({ title, api, supportsSource = false }: LocalProviderSuiteProps) {
  const [gw, setGw] = useState<LocalGatewayStatus>({ running: false, addr: '', port: 0 })
  const [source, setSource] = useState<'remote' | 'local'>('remote')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [tab, setTab] = useState<TabId>('accounts')

  const refresh = useCallback(async () => {
    try {
      setGw(await api.gatewayStatus())
      if (supportsSource && api.getSource) {
        const src = await api.getSource()
        setSource(src === 'local' ? 'local' : 'remote')
      }
      setErr('')
    } catch (e) {
      setErr(String(e))
    }
  }, [api, supportsSource])

  useEffect(() => { void refresh() }, [refresh])

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
        <button
          onClick={onToggleGateway}
          disabled={busy === 'gateway'}
          className="text-[12px] font-semibold px-3 h-[34px] rounded-[8px] border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] inline-flex items-center gap-1.5 disabled:opacity-50"
        >
          <Power size={14} /> {gw.running ? '停止网关' : '启动网关'}
        </button>
      </div>

      {/* 接管模式:远程托管 vs 本地自有号(互斥,仅支持的 provider) */}
      {supportsSource && (
        <div className="flex items-center justify-between rounded-[12px] border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3">
          <div>
            <div className="text-[12px] font-semibold text-[var(--text-primary)]">接管模式</div>
            <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
              {source === 'local' ? `本地自有号:${title} 指向本地网关,用你自己的账号。` : `远程托管:${title} 用通行证租号(在主页接管面板开启)。`}
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

      {/* tab 栏 */}
      <div className="flex gap-5 border-b border-[var(--border-light)]">
        {TABS.map(([id, label]) => (
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

      {tab === 'accounts' && <LocalAccountsTab title={title} api={api} />}
      {tab === 'stats' && <LocalStatsTab api={api} />}
      {tab === 'wakeup' && <LocalWakeupTab api={api} />}
      {tab === 'instances' && <LocalInstancesTab api={api} />}
    </div>
  )
}
