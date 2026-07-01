import { useCallback, useEffect, useState } from 'react'
import { PlugZap, Lock, ArrowRight, AlertTriangle } from 'lucide-react'
import { type ProviderLocalApi } from '@/services/localApi'
import type { PageId } from '@/types'
import { cn } from '@/lib/utils'
import { LocalAccountsTab } from './LocalAccountsTab'
import { LocalStatsTab } from './LocalStatsTab'
import { LocalWakeupTab } from './LocalWakeupTab'
import { LocalSessionsTab } from './LocalSessionsTab'
import { LocalGatewayTab } from './LocalGatewayTab'
import { LocalModelProvidersTab } from './LocalModelProvidersTab'
import { LocalSettingsTab } from './LocalSettingsTab'

/**
 * 通用「本地自有号」suite —— 纯账号管理壳:
 * 头部(只读接管态:本地自有号徽记 + 网关运行态 + 当前模式 + 去接管中心链接)+ tab 栏 +
 * 若干独立 tab(账号/统计/保活,codex 另有反代/供应商/会话/设置)。codex / antigravity 共用,仅 api 与 title 不同。
 *
 * 接管模式(远程托管 / 本地自有号)的切换已上移至「接管中心」—— 此处只读展示当前态,
 * 专注账号管理。样式沿用 GFA 客户端 token(琥珀单色、近白/深靛、克制语义色)。
 */

export interface LocalProviderSuiteProps {
  title: string
  api: ProviderLocalApi
  onNavigate?: (p: PageId) => void
  /** 是否有反代(cliproxy 网关 API 服务)。仅 codex;antigravity 走注入、无反代,不显示反代 tab。 */
  hasGateway?: boolean
  /** 是否有自定义模型供应商(OpenAI 兼容供应商喂号 + 动态目录)。仅 codex;antigravity 不显示供应商 tab。 */
  hasModelProviders?: boolean
  /** 是否有「Codex 设置」面板(本地 Codex 设置 + config.toml 快捷配置)。仅 codex。 */
  hasSettings?: boolean
  /** 是否有「会话」tab(codex 会话列表/回收站/统计,读默认 Codex 主目录)。仅 codex。 */
  hasSessions?: boolean
}

type TabId = 'accounts' | 'gateway' | 'providers' | 'stats' | 'wakeup' | 'sessions' | 'settings'

export function LocalProviderSuite({ title, api, onNavigate, hasGateway = false, hasModelProviders = false, hasSettings = false, hasSessions = false }: LocalProviderSuiteProps) {
  const tabs: [TabId, string][] = [
    ['accounts', '账号'],
    ...(hasGateway ? ([['gateway', '反代']] as [TabId, string][]) : []),
    ...(hasModelProviders ? ([['providers', '供应商']] as [TabId, string][]) : []),
    ['stats', '统计'],
    ['wakeup', '保活'],
    ...(hasSessions ? ([['sessions', '会话']] as [TabId, string][]) : []),
    ...(hasSettings ? ([['settings', '设置']] as [TabId, string][]) : []),
  ]
  const [source, setSource] = useState<'remote' | 'local'>('remote')
  const [tab, setTab] = useState<TabId>('accounts')

  const refresh = useCallback(async () => {
    try {
      if (api.getSource) {
        const src = await api.getSource()
        setSource(src === 'local' ? 'local' : 'remote')
      }
    } catch {
      // 只读状态条:失败不打断账号管理。
    }
  }, [api])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => { void refresh() }, 5000)
    return () => clearInterval(id)
  }, [refresh])

  const localActive = source === 'local'

  return (
    <div className="max-w-[960px] flex flex-col gap-4">
      {/* 头部:产品 + 本地自有号徽记 + 只读接管态 + 去接管中心 */}
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
                <span className={cn('w-1.5 h-1.5 rounded-full', localActive ? 'bg-[var(--success)] dot-pulse' : 'bg-[var(--text-muted)]')} />
                {localActive ? '本地接管中 · 已注入' : '远程托管(接管中心切换)'}
              </span>
              <span className="inline-flex items-center gap-1 text-[var(--success)]"><Lock size={11} /> 仅自有号</span>
            </div>
          </div>
        </div>
        <button
          onClick={() => onNavigate?.('takeover')}
          className="text-[12px] font-semibold px-3 h-[34px] rounded-[8px] border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-secondary)] hover:text-[var(--primary-strong)] hover:bg-[var(--bg-hover)] inline-flex items-center gap-1.5"
        >
          去接管中心 <ArrowRight size={14} />
        </button>
      </div>

      {/* 使用风险提示:本地自有号本质是代理转发,口径对齐 cockpit,克制不渲染封号。 */}
      <div className="rounded-[8px] border border-[var(--warning)] bg-[var(--warning)]/10 px-3 py-2 text-[12px] text-[var(--text-secondary)] flex items-start gap-2">
        <AlertTriangle size={14} className="text-[var(--warning)] mt-0.5 shrink-0" />
        <span>
          <span className="font-semibold text-[var(--warning)]">使用风险提示</span> —— 本地自有号本质上属于代理转发的用法。就目前情况看,官方暂未对此类行为明确管控,但后续政策、规则或可用性是否变化仍存在不确定性。继续使用即表示你已知悉相关情况,并愿意自行承担可能产生的风险。
        </span>
      </div>

      {/* tab 栏 */}
      <div className="flex gap-5 border-b border-[var(--border-light)]">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              'py-2 text-[13px] font-semibold border-b-2 -mb-px transition-colors',
              tab === id ? 'text-[var(--text-primary)] border-[var(--primary)]' : 'text-[var(--text-muted)] border-transparent hover:text-[var(--text-secondary)]',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'accounts' && <LocalAccountsTab title={title} api={api} />}
      {tab === 'gateway' && <LocalGatewayTab api={api} />}
      {tab === 'providers' && <LocalModelProvidersTab />}
      {tab === 'stats' && <LocalStatsTab api={api} />}
      {tab === 'wakeup' && <LocalWakeupTab api={api} />}
      {tab === 'sessions' && <LocalSessionsTab />}
      {tab === 'settings' && <LocalSettingsTab onNavigate={(p) => { if (p === 'wakeup') setTab('wakeup'); else onNavigate?.(p) }} />}
    </div>
  )
}
