import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useAppStore } from '@/stores/useAppStore'
import { Button } from '@/components/ui/button'
import { Modal, useModal } from '@/components/Modal'
import { CompetingRelayDialog } from '@/components/CompetingRelayDialog'
import { LoadingOverlay } from '@/components/LoadingOverlay'
import { ProviderLogo } from '@/components/ProviderLogo'
import { cn } from '@/lib/utils'
import { isMacPlatform, isWindowsPlatform } from '@/lib/platform'
import { useT, t as tr } from '@/i18n'
import { codexLocalApi, antigravityLocalApi, type ProviderLocalApi, antigravityLocalInjected, setAntigravityLocalInjected } from '@/services/localApi'
import { useRemoteTakeover } from './useRemoteTakeover'
import { sandboxGetStatus, sandboxInstall, sandboxInstallCommand, sandboxBrowseDir, sandboxWindowsPrereq, sandboxEnableHypervisor, sandboxLogin, sandboxCreate, sandboxEnterCommand, sandboxRestore, sandboxList, sandboxStopOne, sandboxVscodeStatus, sandboxVscodeEnable, sandboxVscodeDisable, getCodexFastMode, setCodexFastMode } from '@/services/wails'
import type { PageId } from '@/types'
import { ArrowRight, Users, Plus, X, Copy, Check, ShieldAlert } from 'lucide-react'

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

/**
 * Codex 桌面「快速档(Fast)」开关。仅远程接管生效后有意义:开启时写 ~/.codex 桌面档位
 * (config.toml [desktop].default-service-tier=priority + 全局态),Codex 每条生成请求带
 * service_tier=priority;是否真放行仍由服务端授权 + 被租号能力门控(不满足则被剥回标准)。
 * 切换会重启已接管的 Codex 使其重读档位。未接管时禁用(接管后才有意义)。
 */
function CodexFastToggle({ injected }: { injected: boolean }) {
  const [fast, setFast] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void getCodexFastMode().then(setFast).catch(() => {})
  }, [])

  const choose = async (next: boolean) => {
    if (busy || next === fast) return
    setBusy(true)
    setFast(next) // 乐观更新
    try {
      await setCodexFastMode(next)
    } catch {
      setFast(!next) // 回滚
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={cn('flex items-center justify-between h-[40px]', !injected && 'opacity-40')}>
      <div className="min-w-0">
        <div className="text-[12px] text-[var(--text-primary)] font-medium">快速档 (Fast)</div>
        <div className="text-[10px] text-[var(--text-muted)] leading-tight">
          {injected ? '优先算力更快出字 · 需号支持且已授权,否则自动回标准' : '接管 Codex 后可用'}
        </div>
      </div>
      <div className={cn('inline-flex bg-[var(--bg-tertiary)] rounded-[7px] p-[2px] shrink-0', (!injected || busy) && 'pointer-events-none')}>
        {([false, true] as const).map((v) => (
          <button
            key={String(v)}
            onClick={() => void choose(v)}
            disabled={!injected || busy}
            className={cn(
              'px-2.5 py-[3px] rounded-[5px] text-[10px] font-semibold transition-colors cursor-pointer',
              fast === v ? 'bg-[var(--bg-card)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
            )}
          >
            {v ? '快速' : '标准'}
          </button>
        ))}
      </div>
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

// antigravity 本地接管的两个 app(和远程那两行 IDE + Hub 对称)。各自独立注入自己的 state.vscdb。
const AG_VARIANTS = [
  { variant: 'ide' as const, label: 'Antigravity IDE' },
  { variant: 'standalone' as const, label: 'Antigravity 独立版' },
]

/**
 * Codex / Antigravity 卡:远程/本地两模式互斥。
 * 本地自有号 = 注入式接管(把选中号写进正版客户端凭证,直连官方)——
 * codex 写 ~/.codex/auth.json,antigravity 按 app 独立写各自 state.vscdb。两者都不经反代。
 * 反代(cliproxy 网关)是单独功能,在各 suite 的「反代」tab 自开自关,与此处接管无关。
 * localDesc 描述该产品注入到哪(本地模式下作头部副标题)。
 */
function LocalCapableCard({ name, provider, note, localDesc, api, remoteRows, remoteExtra, tk, onManageAccounts }: {
  name: string
  provider: string
  note?: string
  localDesc: string
  api: ProviderLocalApi
  remoteRows: RemoteRowSpec[]
  remoteExtra?: ReactNode // 远程模式下、行下方追加的产品专属控件(如 Codex 快速档开关)
  tk: Tk
  onManageAccounts?: () => void
}) {
  const [source, setSource] = useState<Mode>('remote')
  const [mode, setMode] = useState<Mode>('remote')
  const [accounts, setAccounts] = useState(0)
  const [busyLocal, setBusyLocal] = useState(false)
  const [err, setErr] = useState('')
  const isAntigravity = provider === 'antigravity'
  // 仅 antigravity:两个 app(IDE / 独立版)各自独立的本地接管态。和远程那两行对称,互不影响。
  const [agInjected, setAgInjected] = useState<Record<'ide' | 'standalone', boolean>>({ ide: false, standalone: false })
  const [busyVariant, setBusyVariant] = useState<string | null>(null)

  const loadAgInjected = useCallback(async () => {
    if (!isAntigravity) return
    const [ide, standalone] = await Promise.all([antigravityLocalInjected('ide'), antigravityLocalInjected('standalone')])
    setAgInjected({ ide, standalone })
  }, [isAntigravity])

  // 刷新实际态(source/账号数/antigravity 两个 app 接管态)。不动 mode —— 段控只反映用户选择。
  const refresh = useCallback(async () => {
    try {
      const src = (await api.getSource?.()) === 'local' ? 'local' : 'remote'
      setSource(src)
      const list = await api.listAccounts()
      setAccounts(list.length)
      await loadAgInjected()
    } catch (e) {
      setErr(String(e))
    }
  }, [api, loadAgInjected])

  // 挂载:仅当实际已是本地接管时,把段控初始化到本地;远程则保留默认段,不强切。
  useEffect(() => {
    void (async () => {
      const src = (await api.getSource?.()) === 'local' ? 'local' : 'remote'
      setSource(src)
      if (src === 'local') setMode('local')
      try {
        const list = await api.listAccounts()
        setAccounts(list.length)
        await loadAgInjected()
      } catch (e) {
        setErr(String(e))
      }
    })()
  }, [api, loadAgInjected])

  // codex 本地接管/停止:setSource('local'/'remote')。前端只切 source、刷新实际态。
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

  // antigravity 按 app 独立接管/停止:注入/撤销该 app 的 state.vscdb,互不影响另一个。
  const onToggleVariant = async (variant: 'ide' | 'standalone', on: boolean) => {
    setBusyVariant(variant)
    setErr('')
    try {
      await setAntigravityLocalInjected(variant, on)
      await refresh()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusyVariant(null)
    }
  }

  // 远程接管:切本地→远程前先停本地(互斥,后端撤掉所有本地注入),再走通行证注入。
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
    <ProductCard name={name} provider={provider} note={mode === 'local' ? localDesc : note} mode={mode} onModeChange={setMode}>
      {mode === 'remote' ? (
        <>
          {remoteRows.map((spec) => (
            <RemoteRow key={spec.target} spec={spec} busy={tk.busy} onToggle={() => onToggleRemote(spec)} />
          ))}
          {remoteExtra}
        </>
      ) : isAntigravity ? (
        <>
          {/* 按 app 独立接管:IDE + 独立版 各一行,和远程那两行对称;各注入自己的 state.vscdb,互不影响。 */}
          {AG_VARIANTS.map(({ variant, label }) => {
            const on = agInjected[variant]
            return (
              <div key={variant} className="flex items-center justify-between gap-3 h-[40px]">
                <div className="min-w-0">
                  <div className="text-[12px] text-[var(--text-primary)] font-medium">{label}</div>
                  <div className={cn('text-[10px] flex items-center gap-1.5', on ? 'text-[var(--success)]' : 'text-[var(--text-muted)]')}>
                    <span className={cn('w-1.5 h-1.5 rounded-full', on ? 'bg-[var(--success)]' : 'bg-[var(--text-muted)]')} />
                    {on ? '已接管 · 直连官方' : '未接管'}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant={on ? 'secondary' : 'default'}
                  disabled={busyVariant === variant}
                  onClick={() => void onToggleVariant(variant, !on)}
                  className="shrink-0 cursor-pointer min-w-[68px]"
                >
                  {busyVariant === variant ? '...' : on ? '停止' : '接管'}
                </Button>
              </div>
            )
          })}
          <button
            onClick={onManageAccounts}
            className="flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--primary-strong)] py-1.5"
          >
            <Users size={11} /> {accounts} 个自有号 · 管理账号 <ArrowRight size={11} />
          </button>
        </>
      ) : (
        <div className="flex items-center justify-between gap-3 py-1.5">
          <div className="min-w-0">
            {/* 状态一行:和远程行一样只留「状态点 + 文案」;号源/落点已在头部副标题说明 */}
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className={cn('w-1.5 h-1.5 rounded-full', localActive ? 'bg-[var(--success)]' : 'bg-[var(--text-muted)]')} />
              <span className={localActive ? 'text-[var(--success)]' : 'text-[var(--text-muted)]'}>{localActive ? '已接管 · 直连官方' : '未接管'}</span>
            </div>
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

// ── Claude Code · 沙箱模式(sbx)──────────────────────────────────────────────
// 冰茶只准备(检测/装 sbx、生成 kit、放行 policy、递命令);交互式 sbx run 由用户在自己终端跑。
type SandboxMountItem = { path: string; readOnly: boolean }

function isDangerousMountPath(p: string): boolean {
  const clean = p.replace(/[/\\]+$/, '')
  if (clean === '' || clean === '/' || /^[A-Za-z]:\\?$/.test(clean)) return true
  return ['/System', '/Library', '/etc', '/usr', '/bin'].includes(clean)
}

// 把后端裸错误翻成人话。注意:别把 exit status 1 笼统当成「没装」——那会盖掉 sbx 的真实报错。
// 只有明确「找不到可执行文件」才提示安装;其余(含 sbx policy 自身报错)原样透出,便于排查。
function friendlySandboxError(e: unknown): string {
  const s = String(e)
  if (/executable file not found|未找到 sbx/i.test(s)) return '没找到 sbx 命令,请先安装 Docker sbx。'
  if (/not authenticated|sbx login/i.test(s)) return '还没登录 Docker。点上方「打开终端登录」跑一次 sbx login,登录后再点开启接管。'
  if (/请先登录账号/.test(s)) return '请先登录冰茶账号再开启接管。'
  return s.replace(/^Error:\s*/, '')
}

// 挂载读写段控:对齐 ProductCard 的模式段控视觉。
function MountRwToggle({ readOnly, onChange }: { readOnly: boolean; onChange: (ro: boolean) => void }) {
  return (
    <div className="inline-flex bg-[var(--bg-tertiary)] rounded-[7px] p-[2px] shrink-0">
      {([false, true] as const).map((ro) => (
        <button
          key={String(ro)}
          onClick={() => onChange(ro)}
          className={cn(
            'px-2 py-[3px] rounded-[5px] text-[10px] font-semibold transition-colors cursor-pointer',
            readOnly === ro ? 'bg-[var(--bg-card)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
          )}
        >
          {ro ? '只读' : '读写'}
        </button>
      ))}
    </div>
  )
}

// 终端命令块 + 悬浮复制(装 sbx / sbx run 两处复用)。
function CopyBox({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600) }).catch(() => {})
  return (
    <div className="relative rounded-[9px] border border-[var(--border-light)] bg-[var(--bg-tertiary)]">
      <pre className="font-mono-data text-[11px] leading-relaxed text-[var(--text-primary)] px-3 py-2.5 pr-[68px] overflow-x-auto whitespace-pre">{text}</pre>
      <button
        onClick={copy}
        className={cn(
          'absolute top-1.5 right-1.5 inline-flex items-center gap-1 px-2 py-1 rounded-[6px] text-[10px] font-semibold transition-colors cursor-pointer',
          copied ? 'text-[var(--success)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]',
        )}
      >
        {copied ? <><Check className="w-3 h-3" /> 已复制</> : <><Copy className="w-3 h-3" /> 复制</>}
      </button>
    </div>
  )
}

// ── Claude Code · VSCode 沙箱模式(第 7 目标,Phase 1)──
function VscodeSandboxCard() {
  const [st, setSt] = useState<Awaited<ReturnType<typeof sandboxVscodeStatus>> | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const refresh = useCallback(async () => {
    try { setSt(await sandboxVscodeStatus()) } catch { /* ignore */ }
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const run = (fn: () => Promise<string>) => {
    setBusy(true); setErr(''); setMsg('')
    fn().then(setMsg).catch((e) => setErr(friendlySandboxError(e))).finally(() => { setBusy(false); refresh() })
  }

  const editors = st?.editors ?? []
  const enabled = !!st?.enabled
  const supported = st?.supported ?? true // Windows=false:.sh wrapper 在 Windows 上 spawn 会 EFTYPE,禁用接管
  const canEnable = supported && editors.length > 0 && !!st?.sbxInstalled

  return (
    <ProductCard name="Claude Code · VSCode 沙箱模式" provider="anthropic" note="VSCode/Cursor/Antigravity 等的 Claude 面板不动,底层 claude 进沙箱跑(隔离 + 请求经冰茶)">
      <div className="flex flex-col gap-2.5 py-1">
        <div className="flex items-center justify-between h-[38px]">
          <div className="min-w-0 text-[10px] leading-tight">
            <span className={cn(editors.length > 0 ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)]')} title={editors.join('、')}>编辑器:{editors.length > 0 ? editors.join('、') : '未检测到'}</span>
            <span className="mx-1.5 text-[var(--border)]">·</span>
            <span className={cn(st?.sbxInstalled ? 'text-[var(--text-secondary)]' : 'text-[var(--warning-strong)]')}>sbx:{st?.sbxInstalled ? '已装' : '未装'}</span>
            {enabled && <span className="ml-1.5 text-[var(--success)]">· 已接管</span>}
          </div>
          {enabled ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(sandboxVscodeDisable)} className="shrink-0">
              {busy ? '处理中…' : '关闭接管'}
            </Button>
          ) : (
            <Button size="sm" variant="default" disabled={busy || !canEnable} onClick={() => run(sandboxVscodeEnable)} className="shrink-0 min-w-[92px]">
              {busy ? '处理中…' : '开启接管'}
            </Button>
          )}
        </div>
        {!supported && <p className="text-[10px] text-[var(--warning-strong)]">Windows 暂不支持:官方扩展无法执行沙箱 wrapper(点登录会报 spawn EFTYPE)。请改用上面「Claude Code · 沙箱模式」在终端里跑,或在 WSL 内使用。</p>}
        {supported && !st?.sbxInstalled && <p className="text-[10px] text-[var(--text-muted)]">需先在上面「Claude Code · 沙箱模式」卡里装好 sbx。</p>}
        {enabled && <p className="text-[10px] text-[var(--text-muted)]">重开 VSCode 的 Claude 面板生效;首次会拉沙箱镜像。native diff / 选区上下文(Phase 2)暂不可用。</p>}
        {msg && <p className="text-[10px] text-[var(--success)]">{msg}</p>}
        {err && <p className="text-[10px] text-[var(--danger)]">{err}</p>}
      </div>
    </ProductCard>
  )
}

function SandboxCard() {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof sandboxGetStatus>> | null>(null)
  const [mounts, setMounts] = useState<SandboxMountItem[]>([])
  const [msg, setMsg] = useState('') // 创建成功后的提示(替代原来复制一把梭命令)
  const [installCmd, setInstallCmd] = useState('')
  const [installing, setInstalling] = useState(false)
  const [skipPerms, setSkipPerms] = useState(true) // 沙箱已隔离,进入命令默认带 --dangerously-skip-permissions
  const [customModel, setCustomModel] = useState(false) // 默认冰茶托管;开则用自定义模型端点
  const [openNet, setOpenNet] = useState(true) // 网络全放开(默认);文件隔离不受影响
  const [modelBase, setModelBase] = useState('')
  const [modelToken, setModelToken] = useState('')
  const [modelName, setModelName] = useState('')
  const [managed, setManaged] = useState<Awaited<ReturnType<typeof sandboxList>>>([]) // 已托管沙箱(名/状态/来源/工作区)
  const [stopping, setStopping] = useState('') // 正在停止的沙箱名(给按钮即时反馈)
  const [copiedName, setCopiedName] = useState('') // 刚复制了进入命令的沙箱名
  const [winPrereq, setWinPrereq] = useState<Awaited<ReturnType<typeof sandboxWindowsPrereq>> | null>(null)
  const [busy, setBusy] = useState<'' | 'install' | 'create' | 'restore'>('')
  const [err, setErr] = useState('')
  const { modalProps, showConfirm } = useModal() // Wails webview 下 window.confirm 是 no-op,破坏性操作用它确认

  const isWin = isWindowsPlatform()

  const refresh = useCallback(async () => {
    try { setStatus(await sandboxGetStatus()) } catch { /* ignore */ }
  }, [])

  const checkPrereq = useCallback(async () => {
    if (!isWin) return
    try { setWinPrereq(await sandboxWindowsPrereq()) } catch { /* ignore */ }
  }, [isWin])

  const refreshList = useCallback(async () => {
    // Go 空 slice 会序列化成 null,兜成 [] —— 否则 managed.length 抛异常整页白屏。
    try { setManaged((await sandboxList()) ?? []) } catch { /* ignore */ }
  }, [])

  // 装 sbx 期间轮询,顺带刷沙箱列表(create 后 box 立即出现)。
  useEffect(() => { const id = setInterval(refreshList, 6000); return () => clearInterval(id) }, [refreshList])

  useEffect(() => {
    refresh()
    checkPrereq()
    refreshList()
  }, [refresh, checkPrereq, refreshList])

  const installed = !!status?.installed
  const unsupported = !!status?.unsupported // 硬性不支持(如 Intel Mac / 非 Win11)
  // Windows WHP 三态:off=需启用、pending=已启用待重启、ready=可用。off/pending 都拦,但提示不同。
  const hvState = isWin ? (winPrereq?.hypervisorState ?? 'ready') : 'ready'
  const hvBlocked = hvState !== 'ready'
  const hvPending = hvState === 'pending' // 已启用,就差一次重启

  // 装 sbx 期间轮询侦测:终端里装完,卡片自动变绿(无需用户手点重新检测)。
  useEffect(() => {
    if (!installing || installed) { if (installed) setInstalling(false); return }
    const id = setInterval(refresh, 4000)
    return () => clearInterval(id)
  }, [installing, installed, refresh])

  const run = (kind: 'install' | 'create' | 'restore', fn: () => Promise<void>) => {
    setBusy(kind); setErr('')
    fn().catch((e) => setErr(friendlySandboxError(e))).finally(() => setBusy(''))
  }

  // 帮用户装:开系统终端跑安装命令(要密码就输,看得见进度),装完自动侦测。
  // 开终端失败(如 Linux 无终端模拟器)→ 回退亮出命令让用户手动复制。
  const install = () => run('install', async () => {
    try {
      await sandboxInstall()
      setInstalling(true)
    } catch {
      setInstallCmd(await sandboxInstallCommand())
    }
  })
  // 创建 = 冰茶后台直接把 box 建出来(sbx create,box 建完 stopped);建好即进「已托管沙箱」列表,
  // 进入靠列表里的「进入」按钮复制命令。首次会拉镜像,故 busy 期间显示「创建中…」。
  const create = () => run('create', async () => {
    setMsg('')
    const name = await sandboxCreate(mounts, { custom: customModel, baseURL: modelBase, token: modelToken, model: modelName } as never, openNet)
    await refreshList()
    setMsg(`✓ 已创建沙箱 ${name.replace(/^gfa-/, '')},在下方「已托管沙箱」点「进入」复制命令到终端启动`)
  })
  const stopOne = async (name: string) => {
    setErr(''); setStopping(name)
    try { await sandboxStopOne(name); await refreshList() } catch (e) { setErr(friendlySandboxError(e)) } finally { setStopping('') }
  }
  // 进入 = 复制「进入该沙箱」的命令到剪贴板(box 已建好,sbx run --name 即读 spec 起 claude 在其工作区),
  // 用户自己贴到终端。skipPerms 决定是否给 claude 加 --dangerously-skip-permissions。
  const attach = async (name: string) => {
    try {
      const cmd = await sandboxEnterCommand(name, skipPerms)
      await navigator.clipboard.writeText(cmd)
      setCopiedName(name); setTimeout(() => setCopiedName(''), 1600)
    } catch (e) { setErr(friendlySandboxError(e)) }
  }
  const restore = async () => {
    const ok = await showConfirm('移除全部沙箱', '将停止并移除所有冰茶托管的沙箱(正在运行的会话会被终止),并撤销网关放行、删除 kit。确定继续?', { confirmLabel: '移除全部', cancelLabel: '取消' })
    if (!ok) return
    run('restore', async () => { await sandboxRestore(); setMsg(''); await refreshList() })
  }

  const addMount = async () => {
    try {
      const p = await sandboxBrowseDir('选择要挂载到沙箱的目录')
      if (p) setMounts((m) => m.some((x) => x.path === p) ? m : [...m, { path: p, readOnly: false }])
    } catch { /* cancelled */ }
  }

  // Windows:弹 UAC 启用 Hypervisor Platform(启用后需重启)。
  const enableHv = async () => { setErr(''); try { await sandboxEnableHypervisor() } catch (e) { setErr(friendlySandboxError(e)) } }
  // 开终端跑 sbx login(Docker Hub 登录,首次必做)。
  const login = async () => { setErr(''); try { await sandboxLogin() } catch (e) { setErr(friendlySandboxError(e)) } }

  return (
    <>
    <ProductCard name="Claude Code · 沙箱模式" provider="anthropic" note="在 Docker 沙箱里隔离运行 Claude Code,请求仍经冰茶网关出口">
      <div className="flex flex-col">
        {/* 运行时状态(对齐 RemoteRow 的行式) */}
        <div className="flex items-center justify-between h-[40px]">
          <div className="min-w-0">
            <div className="text-[12px] text-[var(--text-primary)] font-medium">Docker 沙箱运行时</div>
            <div className={cn('text-[10px] truncate', unsupported ? 'text-[var(--danger)]' : installed ? 'text-[var(--success)]' : 'text-[var(--text-muted)]')}>
              {unsupported ? '此设备不支持' : installed ? `已就绪${status?.version ? ' · ' + status.version.trim().split('\n')[0] : ''}` : '未检测到 sbx'}
            </div>
          </div>
          {!installed && !unsupported && (
            <Button size="sm" variant="default" disabled={busy === 'install' || installing} onClick={install} className="shrink-0 min-w-[84px]">
              {installing ? '安装中…' : '安装 sbx'}
            </Button>
          )}
        </div>

        {unsupported && (
          <div className="flex items-start gap-1.5 pt-2 pb-1 text-[11px] text-[var(--text-secondary)] leading-relaxed">
            <ShieldAlert className="w-3.5 h-3.5 mt-px shrink-0 text-[var(--danger)]" />
            <span>{status?.note}</span>
          </div>
        )}

        {status?.note && !unsupported && (
          <div className="flex items-start gap-1.5 pt-1 pb-2 text-[10px] text-[var(--warning-strong)]">
            <ShieldAlert className="w-3 h-3 mt-px shrink-0" />
            <span>{status.note}</span>
          </div>
        )}

        {/* Windows 前置:Hypervisor Platform 没启用则沙箱起不来,先拦下 */}
        {!unsupported && hvBlocked && (
          <div className="flex flex-col gap-2 mt-2 rounded-[9px] border border-[var(--warning)] bg-[var(--bg-tertiary)] p-3">
            <div className="flex items-start gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5 mt-px shrink-0 text-[var(--warning-strong)]" />
              <div className="text-[11px] text-[var(--text-primary)] leading-relaxed">
                {hvPending ? (
                  <><span className="font-semibold">已启用 Windows Hypervisor Platform,重启电脑后生效</span> —— hypervisor 要开机时加载,重启前沙箱还起不来。</>
                ) : (
                  <><span className="font-semibold">需要启用 Windows Hypervisor Platform</span> —— 沙箱靠它起虚拟机,没开 sbx 跑不起来。</>
                )}
                {winPrereq && !winPrereq.firmwareVirtOK && (
                  <span className="block mt-1 text-[var(--warning-strong)]">另外:{winPrereq.note}</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {!hvPending && <Button size="sm" variant="default" onClick={enableHv}>一键启用</Button>}
              <button onClick={checkPrereq} className="text-[11px] font-medium text-[var(--primary-strong)] hover:text-[var(--primary-hover)] transition-colors cursor-pointer">重启后点这里重新检查</button>
            </div>
            <p className="text-[10px] text-[var(--text-muted)]">
              {hvPending
                ? <>请<span className="font-semibold text-[var(--text-secondary)]">重启电脑</span>,重启后点上方「重新检查」即可,无需再点启用。</>
                : <>点后会弹管理员授权;启用完成需<span className="font-semibold text-[var(--text-secondary)]">重启电脑</span>才生效。</>}
            </p>
          </div>
        )}

        {unsupported ? null : !installed ? (
          <div className="flex flex-col gap-2 pt-2 pb-1">
            <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
              {isWin
                ? <>点「安装 sbx」冰茶会提权下载官方安装包帮你装(弹一次管理员授权即可,<span className="font-semibold text-[var(--text-secondary)]">不用 winget</span>)。装完请<span className="font-semibold text-[var(--warning-strong)]">重启冰茶客户端</span>才能识别到 sbx。</>
                : '点「安装 sbx」冰茶会开一个终端帮你装(要密码就输一下),装完这里自动变绿。装好后即可在隔离沙箱里跑 Claude Code。'}
            </p>
            {installing && (
              <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)]">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--primary-strong)] animate-pulse" />
                {isWin ? '已开始下载安装,装完请重启冰茶再识别…' : '已打开终端安装,完成后自动检测…'}
                <button onClick={refresh} className="font-medium text-[var(--primary-strong)] hover:text-[var(--primary-hover)] transition-colors cursor-pointer">立即检测</button>
              </div>
            )}
            {installCmd && (
              <>
                <div className="text-[10px] text-[var(--text-muted)]">开终端失败,请手动在终端运行:</div>
                <CopyBox text={installCmd} />
                <button
                  onClick={refresh}
                  className="self-start text-[11px] font-medium text-[var(--primary-strong)] hover:text-[var(--primary-hover)] transition-colors cursor-pointer"
                >
                  装好了?点这里重新检测
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4 pt-3.5 mt-0.5 border-t border-[var(--border-light)]">
            {/* Docker Hub 登录(首次必做;无法可靠检测登录态,故常驻提示) */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-[var(--text-secondary)]">首次使用需登录 Docker Hub(<span className="font-mono-data">sbx login</span>)</span>
              <Button size="sm" variant="secondary" onClick={login} className="shrink-0">打开终端登录</Button>
            </div>

            {/* 已托管沙箱:真查 sbx ls --json,只列 gfa- 前缀(CLI + VSCode 合到一处,Source 标签区分)。 */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-[var(--text-primary)]">已托管沙箱</span>
                <button onClick={refreshList} className="text-[11px] font-medium text-[var(--primary-strong)] hover:text-[var(--primary-hover)] transition-colors cursor-pointer">刷新</button>
              </div>
              {managed.length === 0 ? (
                <p className="text-[10px] text-[var(--text-muted)]">暂无 · 下方「新建项目沙箱」创建,或 VSCode 沙箱接管后惰性生成</p>
              ) : (
                managed.map((s) => (
                  <div key={s.name} className="flex items-center gap-2 rounded-[8px] bg-[var(--bg-tertiary)] pl-2.5 pr-1 py-1">
                    <span className="flex items-center gap-1.5 min-w-0 flex-1">
                      <span className={cn('inline-block w-1.5 h-1.5 rounded-full shrink-0', s.status === 'running' ? 'bg-[var(--success)]' : 'bg-[var(--text-muted)]')} title={s.status || '未知'} />
                      <span className="font-mono-data text-[11px] text-[var(--text-secondary)] truncate" title={s.workspace || s.name}>{s.label}</span>
                      <span className="text-[9px] font-semibold text-[var(--text-muted)] shrink-0">{s.source === 'vscode' ? 'VSCode' : 'CLI'}</span>
                    </span>
                    <Button size="sm" variant="secondary" onClick={() => attach(s.name)} className="shrink-0 min-w-[56px]" title="复制进入命令到剪贴板">{copiedName === s.name ? '已复制' : '进入'}</Button>
                    <Button size="sm" variant="ghost" disabled={stopping === s.name} onClick={() => stopOne(s.name)} className="shrink-0 min-w-[56px]">
                      {stopping === s.name ? '停止中…' : '停止'}
                    </Button>
                  </div>
                ))
              )}
            </div>

            <div className="text-[11px] font-semibold text-[var(--text-primary)] pt-1 border-t border-[var(--border-light)]">新建项目沙箱</div>

            {/* 挂载目录 */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-[var(--text-primary)]">挂载目录</span>
                <button
                  onClick={addMount}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--primary-strong)] hover:text-[var(--primary-hover)] transition-colors cursor-pointer"
                >
                  <Plus className="w-3 h-3" /> 添加目录
                </button>
              </div>
              {mounts.length === 0 ? (
                <p className="text-[10px] text-[var(--text-muted)]">未选目录 · 沙箱里的 Claude 看不到任何项目文件</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {mounts.map((m, i) => (
                    <div key={m.path} className="flex items-center gap-2 rounded-[8px] bg-[var(--bg-tertiary)] pl-2.5 pr-1.5 py-1.5">
                      <span className="font-mono-data text-[11px] text-[var(--text-secondary)] truncate flex-1" title={m.path}>{m.path}</span>
                      {isDangerousMountPath(m.path) && (
                        <span className="inline-flex items-center gap-1 text-[9px] font-semibold text-[var(--warning-strong)] shrink-0" title="挂了家目录/系统盘,沙箱里的 Claude 能改这些文件">
                          <ShieldAlert className="w-2.5 h-2.5" /> 越界
                        </span>
                      )}
                      <MountRwToggle readOnly={m.readOnly} onChange={(ro) => setMounts((ms) => ms.map((x, j) => (j === i ? { ...x, readOnly: ro } : x)))} />
                      <button
                        onClick={() => setMounts((ms) => ms.filter((_, j) => j !== i))}
                        className="p-1 rounded-[6px] text-[var(--text-muted)] hover:text-[var(--danger)] hover:bg-[var(--bg-hover)] transition-colors shrink-0 cursor-pointer"
                        aria-label={`移除挂载 ${m.path}`}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 模型来源:默认冰茶托管;自定义 = 沙箱直连你的 Anthropic 兼容端点(如火山方舟 kimi) */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold text-[var(--text-primary)]">模型来源</span>
                <div className="inline-flex bg-[var(--bg-tertiary)] rounded-[7px] p-[2px] shrink-0">
                  {([['冰茶托管', false], ['自定义模型', true]] as const).map(([label, v]) => (
                    <button
                      key={label}
                      onClick={() => setCustomModel(v)}
                      className={cn('px-2.5 py-[3px] rounded-[5px] text-[10px] font-semibold transition-colors cursor-pointer',
                        customModel === v ? 'bg-[var(--bg-card)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]')}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {customModel && (
                <div className="flex flex-col gap-1.5 rounded-[8px] bg-[var(--bg-tertiary)] p-2.5">
                  <input value={modelBase} onChange={(e) => setModelBase(e.target.value)} placeholder="Base URL(Anthropic 兼容,如 https://ark.cn-beijing.volces.com/api/plan)"
                    className="text-[11px] font-mono-data bg-[var(--bg-card)] border border-[var(--border)] rounded-[6px] h-[28px] px-2.5 text-[var(--text-primary)] focus:outline-none focus:border-[var(--primary)]" />
                  <input value={modelToken} onChange={(e) => setModelToken(e.target.value)} placeholder="API Key" type="password"
                    className="text-[11px] font-mono-data bg-[var(--bg-card)] border border-[var(--border)] rounded-[6px] h-[28px] px-2.5 text-[var(--text-primary)] focus:outline-none focus:border-[var(--primary)]" />
                  <input value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="模型名(如 kimi-k2.6)"
                    className="text-[11px] font-mono-data bg-[var(--bg-card)] border border-[var(--border)] rounded-[6px] h-[28px] px-2.5 text-[var(--text-primary)] focus:outline-none focus:border-[var(--primary)]" />
                  <span className="text-[10px] text-[var(--text-muted)]">直连此端点,不走冰茶租号。端点须 Anthropic Messages API 兼容(火山用 /api/plan,不是 /api/v3)</span>
                </div>
              )}
            </div>

            {/* 网络全放开(默认开):文件隔离不受影响,沙箱仍只见挂载目录 */}
            <label className="flex items-center justify-between gap-2 cursor-pointer">
              <div className="min-w-0">
                <span className="text-[11px] font-semibold text-[var(--text-primary)]">网络全放开</span>
                <span className="block text-[10px] text-[var(--text-muted)] leading-tight mt-0.5">沙箱可访问任意网站(fetch 文档、装包等)。文件隔离不变——本地文件/Cookie 仍碰不到,只见你挂的目录。关则仅放行模型+常见开发站点</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={openNet}
                onClick={() => setOpenNet((v) => !v)}
                className={cn('relative w-9 h-5 rounded-full transition-colors shrink-0', openNet ? 'bg-[var(--primary-strong)]' : 'bg-[var(--switch-off)]')}
              >
                <span className={cn('absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform', openNet && 'translate-x-4')} />
              </button>
            </label>

            {/* 跳过权限确认(沙箱内相对安全,默认开) */}
            <label className="flex items-center justify-between gap-2 cursor-pointer">
              <div className="min-w-0">
                <span className="text-[11px] font-semibold text-[var(--text-primary)]">跳过权限确认</span>
                <span className="block text-[10px] text-[var(--text-muted)] leading-tight mt-0.5">给 Claude 加 --dangerously-skip-permissions,不再逐条问;沙箱已隔离宿主,只能改你挂的目录</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={skipPerms}
                onClick={() => setSkipPerms((v) => !v)}
                className={cn('relative w-9 h-5 rounded-full transition-colors shrink-0', skipPerms ? 'bg-[var(--primary-strong)]' : 'bg-[var(--switch-off)]')}
              >
                <span className={cn('absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform', skipPerms && 'translate-x-4')} />
              </button>
            </label>

            {/* 操作:创建 = 冰茶后台直接建 box(不再复制一把梭命令);移除 = 停全部+撤配置 */}
            <div className="flex items-center gap-2">
              <Button size="sm" variant="default" disabled={busy !== '' || mounts.length === 0} onClick={create} className="min-w-[104px]">
                {busy === 'create' ? '创建中…' : '创建沙箱'}
              </Button>
              {managed.length > 0 && (
                <Button size="sm" variant="ghost" disabled={busy !== ''} onClick={restore}>
                  {busy === 'restore' ? '移除中…' : '移除全部'}
                </Button>
              )}
            </div>
            {mounts.length === 0 && <p className="text-[10px] text-[var(--text-muted)]">先在上面「挂载目录」选一个项目目录,才能创建沙箱</p>}
            {msg && <p className="text-[10px] text-[var(--success)]">{msg}</p>}
          </div>
        )}

        {err && (
          <div className="flex items-start gap-1.5 pt-2.5 text-[10px] text-[var(--danger)]">
            <ShieldAlert className="w-3 h-3 mt-px shrink-0" />
            <span>{err}</span>
          </div>
        )}
      </div>
    </ProductCard>
    <Modal {...modalProps} />
    </>
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
    // 接管前检测并处理第三方中转配置(cc-switch 等),避免母号被判定异常。
    if (!injected && !(await tk.preflightSanitize(target))) return
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

        {/* ── Claude Code · 沙箱模式(sbx) ── */}
        <SandboxCard />

        {/* ── Claude Code · VSCode 沙箱模式(第 7 目标) ── */}
        <VscodeSandboxCard />

        {/* ── Codex(远程 / 本地) ── */}
        <LocalCapableCard
          name="Codex"
          provider="codex"
          note={t('takeover.codexNote')}
          localDesc="本地自有号 · 注入 ~/.codex/auth.json,codex CLI 直连 OpenAI(不走反代)"
          api={codexLocalApi}
          remoteRows={codexRows}
          remoteExtra={<CodexFastToggle injected={!!codexApp?.injected} />}
          tk={tk}
          onManageAccounts={() => onNavigate?.('local_codex')}
        />

        {/* ── Antigravity(远程 / 本地) ── */}
        <LocalCapableCard
          name="Antigravity"
          provider="antigravity"
          note={t('takeover.agNote')}
          localDesc="本地自有号 · 注入 state.vscdb,直连官方(不走反代)"
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
      <CompetingRelayDialog {...tk.relayDialogProps} />
      <LoadingOverlay show={tk.busy !== null} label={tk.busyLabel} />
    </div>
  )
}
