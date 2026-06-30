import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useAppStore } from '@/stores/useAppStore'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/Modal'
import { LoadingOverlay } from '@/components/LoadingOverlay'
import { ProviderLogo } from '@/components/ProviderLogo'
import { cn } from '@/lib/utils'
import { isMacPlatform, isWindowsPlatform } from '@/lib/platform'
import { useT, t as tr } from '@/i18n'
import { codexLocalApi, antigravityLocalApi, type ProviderLocalApi } from '@/services/localApi'
import { useRemoteTakeover } from './useRemoteTakeover'
import type { PageId } from '@/types'
import { Lock, ArrowRight, Users } from 'lucide-react'

/**
 * 接管中心 —— 统一控制面。每个产品一张卡:决定该产品走「远程托管」还是「本地自有号」接管,
 * 以及接管/停止。这是接管的唯一入口(原先散在主页底部 + 各本地 suite 头部)。
 *
 *   Claude(Anthropic):仅远程托管(MITM)。Claude Code(CLI+VSCode)+ Claude Desktop 两行。
 *   Codex / Antigravity:模式段控〔远程托管 | 本地自有号〕。
 *     远程托管 = 通行证租号(injectSelected,复用 useRemoteTakeover 全部分支语义);
 *     本地自有号 —— 两种产品语义不同:
 *       · Codex(kind='gateway'):指向本地反代网关(localApi.setSource('local'),
 *         codex CLI 指向反代)。需在该 suite 的「反代」tab 把网关开起来。
 *       · Antigravity(kind='inject'):直接把选中自有号 token 注入 IDE 的 state.vscdb,
 *         直连官方,**不走反代、不池化**(localApi.setSource('local') 内部直写)。
 *
 * 「接管」(指向/注入)与「反代」(API 服务,在各 suite 的反代 tab)是两件事:
 * 接管只决定本机 IDE/CLI 用谁的号;反代是对外提供 API 网关。
 *
 * 数据/账号管理仍在各本地 suite,二者解耦;这里只是控制面。
 * 安全不变式不变:远程租号绝不经本地网关出口。
 */

type Mode = 'remote' | 'local'

interface RemoteRowSpec {
  target: string
  name: string
  injected: boolean
  detected: boolean
  undetectedText?: string
}

type Tk = ReturnType<typeof useRemoteTakeover>

/** 统一的远程接管行:名称 + 状态 + 接管/停止。 */
function RemoteRow({ spec, busy, onToggle }: { spec: RemoteRowSpec; busy: string | null; onToggle: () => void }) {
  const t = useT()
  const { target, name, injected, detected, undetectedText = tr('takeover.notInstalled') } = spec
  return (
    <div className={cn('flex items-center justify-between h-[40px]', !detected && 'opacity-40')}>
      <div>
        <div className="text-[12px] text-[var(--text-primary)] font-medium">{name}</div>
        <div className={cn('text-[10px]', injected ? 'text-[var(--success)]' : 'text-[var(--text-muted)]')}>
          {!detected ? undetectedText : injected ? t('takeover.injected') : t('takeover.notInjected')}
        </div>
      </div>
      <Button
        size="sm"
        variant={injected ? 'secondary' : 'default'}
        disabled={!detected || busy === target}
        onClick={onToggle}
        className="shrink-0 cursor-pointer min-w-[68px]"
      >
        {busy === target ? '...' : injected ? t('takeover.stop') : t('takeover.takeover')}
      </Button>
    </div>
  )
}

/** 产品卡外壳:logo + 名称 + 可选模式段控 + 卡体。 */
function ProductCard({ name, provider, note, mode, onModeChange, children }: {
  name: string
  provider: string
  note?: string
  mode?: Mode
  onModeChange?: (m: Mode) => void
  children: ReactNode
}) {
  return (
    <section
      aria-label={name}
      className="rounded-[12px] border border-[var(--border-light)] bg-[var(--bg-card)] p-4 flex flex-col gap-3"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <ProviderLogo provider={provider} />
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-[var(--text-primary)] leading-tight">{name}</div>
            {note && <div className="text-[10px] text-[var(--text-muted)] mt-0.5 leading-tight">{note}</div>}
          </div>
        </div>
        {mode && onModeChange && (
          <div className="inline-flex bg-[var(--bg-tertiary)] rounded-[9px] p-[3px] shrink-0">
            {(['remote', 'local'] as const).map((m) => (
              <button
                key={m}
                onClick={() => onModeChange(m)}
                className={cn(
                  'px-3 py-[5px] rounded-[7px] text-[12px] font-semibold transition-colors',
                  mode === m ? 'bg-[var(--bg-card)] text-[var(--primary-strong)] shadow-sm' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
                )}
              >
                {m === 'remote' ? '远程托管' : '本地自有号'}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-col divide-y divide-[var(--border-light)]">{children}</div>
    </section>
  )
}

/**
 * Codex / Antigravity 卡:远程/本地两模式互斥。
 * 本地自有号 = 注入式接管(把选中号写进正版客户端凭证,直连官方)——
 * codex 写 ~/.codex/auth.json,antigravity 写 IDE state.vscdb。两者都不经反代。
 * 反代(cliproxy 网关)是单独功能,在各 suite 的「反代」tab 自开自关,与此处接管无关。
 * localDesc 描述该产品注入到哪。
 */
function LocalCapableCard({ name, provider, note, localDesc, api, remoteRows, tk, onManageAccounts }: {
  name: string
  provider: string
  note?: string
  localDesc: string
  api: ProviderLocalApi
  remoteRows: RemoteRowSpec[]
  tk: Tk
  onManageAccounts?: () => void
}) {
  const [source, setSource] = useState<Mode>('remote')
  const [mode, setMode] = useState<Mode>('remote')
  const [accounts, setAccounts] = useState(0)
  const [busyLocal, setBusyLocal] = useState(false)
  const [err, setErr] = useState('')

  // 刷新实际态(source/账号数)。不动 mode —— 段控只反映用户选择,实际态由 source 承载,
  // 避免异步刷新把用户刚切的段顶回去。
  const refresh = useCallback(async () => {
    try {
      const src = (await api.getSource?.()) === 'local' ? 'local' : 'remote'
      setSource(src)
      const list = await api.listAccounts()
      setAccounts(list.length)
    } catch (e) {
      setErr(String(e))
    }
  }, [api])

  // 挂载:仅当实际已是本地接管时,把段控初始化到本地;远程则保留默认段,不强切。
  useEffect(() => {
    void (async () => {
      const src = (await api.getSource?.()) === 'local' ? 'local' : 'remote'
      setSource(src)
      if (src === 'local') setMode('local')
      try {
        const list = await api.listAccounts()
        setAccounts(list.length)
      } catch (e) {
        setErr(String(e))
      }
    })()
  }, [api])

  // 本地接管/停止:setSource('local')/setSource('remote')。后端把选中号注入正版客户端
  //(codex auth.json / antigravity state.vscdb),前端只切 source、刷新实际态。
  const onToggleLocal = async () => {
    setBusyLocal(true)
    setErr('')
    try {
      await api.setSource?.(source === 'local' ? 'remote' : 'local')
      await refresh()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusyLocal(false)
    }
  }

  // 远程接管:切本地→远程前先停本地(互斥),再走通行证注入。
  const onToggleRemote = async (spec: RemoteRowSpec) => {
    if (!spec.injected && !(await tk.ensureCard(name))) return
    if (!spec.injected && source === 'local') {
      try { await api.setSource?.('remote') } catch { /* 后端 inject 会覆盖配置,失败不阻断 */ }
      await refresh()
    }
    await tk.runTakeover(spec.target, !spec.injected)
    await refresh()
  }

  const localActive = source === 'local'

  return (
    <ProductCard name={name} provider={provider} note={note} mode={mode} onModeChange={setMode}>
      {mode === 'remote' ? (
        remoteRows.map((spec) => (
          <RemoteRow key={spec.target} spec={spec} busy={tk.busy} onToggle={() => onToggleRemote(spec)} />
        ))
      ) : (
        <div className="flex items-center justify-between gap-3 py-1.5">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[11px]">
              {/* 注入式接管:直连官方,只看是否已接管 */}
              <span className={cn('w-1.5 h-1.5 rounded-full', localActive ? 'bg-[var(--success)]' : 'bg-[var(--text-muted)]')} />
              <span className="text-[var(--text-secondary)]">{localActive ? '已注入 · 直连官方' : '未接管'}</span>
              <span className="inline-flex items-center gap-1 text-[var(--success)]"><Lock size={10} /> 仅自有号</span>
            </div>
            {/* 点明注入到哪;反代是另一回事(在 suite 的反代 tab) */}
            <div className="mt-1 text-[10px] text-[var(--text-muted)] leading-tight">{localDesc}</div>
            <button
              onClick={onManageAccounts}
              className="mt-1 inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--primary-strong)]"
            >
              <Users size={11} /> {accounts} 个自有号 · 管理账号 <ArrowRight size={11} />
            </button>
          </div>
          <Button
            size="sm"
            variant={localActive ? 'secondary' : 'default'}
            disabled={busyLocal}
            onClick={onToggleLocal}
            className="shrink-0 cursor-pointer min-w-[68px]"
          >
            {busyLocal ? '...' : localActive ? '停止' : '接管'}
          </Button>
        </div>
      )}
      {err && <div className="text-[10px] text-[var(--danger)] break-all pt-1">{err}</div>}
    </ProductCard>
  )
}

export function TakeoverCenterPage({ onNavigate }: { onNavigate?: (p: PageId) => void } = {}) {
  const t = useT()
  const tk = useRemoteTakeover()
  const ideProducts = useAppStore((s) => s.ideProducts)
  const proxyRunning = useAppStore((s) => s.proxyRunning)
  const proxyPort = useAppStore((s) => s.proxyPort)

  const isMac = isMacPlatform()
  const showClaudeDesktop = isMac || isWindowsPlatform()

  const find = (id: string) => ideProducts.find((p) => p.id === id)
  const codexApp = find('codex')
  const claudeApp = find('claude_code')
  const claudeDesktopApp = find('claude_desktop')
  const agApps = ideProducts.filter((p) => p.id.startsWith('antigravity'))

  // Claude(Anthropic)远程行:Claude Code + Claude Desktop。
  const claudeToggle = async (target: string, injected: boolean, label: string, desktop = false) => {
    if (!injected && !(await tk.ensureCard(label))) return
    if (desktop && !injected && !(await tk.confirmDesktopTakeover())) return
    await tk.runTakeover(target, !injected)
  }

  const codexRows: RemoteRowSpec[] = [{
    target: 'codex',
    name: 'Codex',
    injected: !!codexApp?.injected,
    detected: !!codexApp?.detected,
  }]

  const agRows: RemoteRowSpec[] = agApps.map((p) => ({
    target: p.id === 'antigravity_ide' ? 'ide' : 'hub',
    name: p.name,
    injected: p.injected,
    detected: p.detected,
  }))

  return (
    <div className="max-w-[760px] flex flex-col gap-4">
      <div>
        <div className="text-[18px] font-bold tracking-tight text-[var(--text-primary)]">接管中心</div>
        <div className="text-[12px] text-[var(--text-secondary)] mt-1">
          每个产品选一种号源接管:远程托管用通行证租号,本地自有号用你自己的账号。
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {/* ── Anthropic · Claude(仅远程) ── */}
        <ProductCard name="Anthropic" provider="anthropic" note={t('takeover.claudeNote')}>
          <RemoteRow
            spec={{ target: 'claude', name: 'Claude Code (CLI + VSCode)', injected: !!claudeApp?.injected, detected: !!claudeApp?.detected, undetectedText: t('takeover.noClaudeDir') }}
            busy={tk.busy}
            onToggle={() => claudeToggle('claude', !!claudeApp?.injected, 'Claude Code')}
          />
          {showClaudeDesktop && (
            <RemoteRow
              spec={{ target: 'claude_desktop', name: 'Claude Desktop (Code/Cowork)', injected: !!claudeDesktopApp?.injected, detected: !!claudeDesktopApp?.detected, undetectedText: t('takeover.notInstalledOrDetected') }}
              busy={tk.busy}
              onToggle={() => claudeToggle('claude_desktop', !!claudeDesktopApp?.injected, 'Claude Desktop', true)}
            />
          )}
        </ProductCard>

        {/* ── Codex(远程 / 本地) ── */}
        <LocalCapableCard
          name="Codex"
          provider="codex"
          note={t('takeover.codexNote')}
          localDesc="把选中号注入 ~/.codex/auth.json,真 codex CLI 直连 OpenAI —— 无反代、不池化(反代见 suite 的反代 tab)"
          api={codexLocalApi}
          remoteRows={codexRows}
          tk={tk}
          onManageAccounts={() => onNavigate?.('local_codex')}
        />

        {/* ── Antigravity(远程 / 本地) ── */}
        <LocalCapableCard
          name="Antigravity"
          provider="antigravity"
          note={t('takeover.agNote')}
          localDesc="把选中号注入 IDE 的 state.vscdb,真 IDE 直连官方 —— 无反代、不池化"
          api={antigravityLocalApi}
          remoteRows={agRows}
          tk={tk}
          onManageAccounts={() => onNavigate?.('local_antigravity')}
        />
      </div>

      {/* 本地代理状态(整宽页脚) */}
      <div className="flex items-center justify-between px-3 py-2 rounded-[8px] bg-[var(--bg-tertiary)] border border-[var(--border-light)]">
        <div className="flex items-center gap-2">
          <span className={cn('w-2 h-2 rounded-full', proxyRunning ? 'bg-[var(--success)]' : 'bg-[var(--text-muted)]')} />
          <span className="text-[12px] text-[var(--text-secondary)]">{t('takeover.localProxy')}</span>
          <span className="text-[10px] text-[var(--text-muted)]">{t('takeover.localProxyNote')}</span>
        </div>
        <span className="text-[12px] font-mono-data text-[var(--text-muted)] shrink-0">
          {proxyRunning ? t('takeover.proxyRunning', { port: proxyPort }) : t('takeover.proxyStopped')}
        </span>
      </div>

      <Modal {...tk.modalProps} />
      <LoadingOverlay show={tk.busy !== null} label={tk.busyLabel} />
    </div>
  )
}
