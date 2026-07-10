import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Clock3,
  Globe2,
  LockKeyhole,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ProviderLogo } from '@/components/ProviderLogo'
import { cn } from '@/lib/utils'

export type TimezoneStrategy = 'follow' | 'fixed' | 'unchanged'
export type HostProtectionMode = 'configure' | 'active' | 'restoring' | 'restored' | 'residue'

export interface HostProtectionConfig {
  timezoneStrategy: TimezoneStrategy
  fixedTimezone: string
  blockWebRTC: boolean
  blockGeolocation: boolean
  targets: string[]
}

export interface HostProtectionPanelProps {
  mode: HostProtectionMode
  platform: 'windows' | 'macos'
  exitTimezone?: string
  originalTimezone?: string
  availableTargets?: string[]
  disabledTargets?: string[]
  runtimeStatus?: {
    timezoneStrategy?: TimezoneStrategy
    appliedTimezone?: string
    blockWebRTC?: boolean
    blockGeolocation?: boolean
    dnsCleared?: boolean
    targets?: string[]
    lastError?: string
  }
  busy?: boolean
  error?: string
  requireExitTimezone?: boolean
  onTakeover?: (config: HostProtectionConfig) => void
  onRestore?: () => void
  onRecover?: () => void
  onContinue?: () => void
  onStopTarget?: (target: string) => void
}

const TIMEZONES = [
  ['Asia/Singapore', '新加坡', 'Singapore Standard Time'],
  ['Asia/Kuala_Lumpur', '马来西亚（半岛）', 'Singapore Standard Time'],
  ['Asia/Kuching', '马来西亚（沙捞越）', 'Singapore Standard Time'],
  ['Asia/Taipei', '台湾', 'Taipei Standard Time'],
  ['Asia/Manila', '菲律宾', 'Singapore Standard Time'],
  ['Asia/Brunei', '文莱', 'Singapore Standard Time'],
  ['Asia/Makassar', '印尼中部', 'Singapore Standard Time'],
  ['Asia/Ulaanbaatar', '蒙古', 'Ulaanbaatar Standard Time'],
  ['Asia/Irkutsk', '俄罗斯伊尔库茨克', 'North Asia East Standard Time'],
  ['Australia/Perth', '澳洲西部', 'W. Australia Standard Time'],
] as const

function StatusDot({ tone = 'muted' }: { tone?: 'success' | 'warning' | 'muted' }) {
  return (
    <span
      className={cn(
        'inline-block h-1.5 w-1.5 rounded-full',
        tone === 'success' ? 'bg-[var(--success)]' : tone === 'warning' ? 'bg-[var(--warning)]' : 'bg-[var(--text-muted)]',
      )}
    />
  )
}

function TargetButton({ selected, title, note, disabled = false, onClick }: { selected: boolean; title: string; note: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex min-w-0 flex-1 items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-left transition-colors',
        disabled
          ? 'cursor-not-allowed bg-[var(--bg-tertiary)] text-[var(--text-muted)] opacity-45'
          : selected
          ? 'bg-[var(--primary-light)] text-[var(--text-primary)]'
          : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
      )}
    >
      <span
        className={cn(
          'grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[5px] border',
          selected ? 'border-[var(--primary-strong)] bg-[var(--primary-strong)] text-[var(--primary-ink)]' : 'border-[var(--border)]',
        )}
      >
        {selected && <Check size={12} strokeWidth={3} />}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[12px] font-semibold">{title}</span>
        <span className="mt-0.5 block text-[10px] text-[var(--text-muted)]">{note}</span>
      </span>
    </button>
  )
}

function DialogFrame({ title, icon: Icon, children, footer }: { title: string; icon: typeof LockKeyhole; children: React.ReactNode; footer: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[var(--z-modal-backdrop)] grid place-items-center bg-slate-950/45 px-6">
      <section role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-[430px] overflow-hidden rounded-[14px] bg-[var(--bg-card)] shadow-[var(--shadow-lg)]">
        <div className="flex items-start gap-3 border-b border-[var(--border-light)] px-5 py-4">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-[var(--primary-light)] text-[var(--primary-strong)]">
            <Icon size={18} />
          </span>
          <div>
            <h2 className="text-[15px] font-bold text-[var(--text-primary)]">{title}</h2>
            <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">操作前把影响讲清楚，再交给系统完成。</p>
          </div>
        </div>
        <div className="px-5 py-4">{children}</div>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--border-light)] bg-[var(--bg-tertiary)]/55 px-5 py-3">{footer}</div>
      </section>
    </div>
  )
}

export function HostProtectionPanel({
  mode,
  platform,
  exitTimezone = 'Asia/Singapore',
  originalTimezone = 'Asia/Shanghai',
  availableTargets = ['claude', 'claude_desktop'],
  disabledTargets = [],
  runtimeStatus,
  busy = false,
  error = '',
  requireExitTimezone = true,
  onTakeover,
  onRestore,
  onRecover,
  onContinue,
  onStopTarget,
}: HostProtectionPanelProps) {
  const [timezoneStrategy, setTimezoneStrategy] = useState<TimezoneStrategy>('follow')
  const [fixedTimezone, setFixedTimezone] = useState('Asia/Singapore')
  const [targets, setTargets] = useState(['claude', 'claude_desktop'])
  const [dialog, setDialog] = useState<'waiver' | 'authorization' | null>(null)
  const [waiverAccepted, setWaiverAccepted] = useState(false)

  useEffect(() => {
    if (!runtimeStatus) return
    if (runtimeStatus.timezoneStrategy) setTimezoneStrategy(runtimeStatus.timezoneStrategy)
    if (runtimeStatus.targets?.length) setTargets(runtimeStatus.targets)
  }, [runtimeStatus])

  const availableKey = availableTargets.join('|')
  const disabledKey = disabledTargets.join('|')
  const selectableTargets = availableTargets.filter((target) => !disabledTargets.includes(target))
  useEffect(() => {
    if (mode !== 'configure') return
    setTargets((current) => {
      const kept = current.filter((target) => selectableTargets.includes(target))
      return kept.length > 0 ? kept : [...selectableTargets]
    })
  // 数组由检测结果派生，用稳定 key 避免每次 render 重置用户选择。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableKey, disabledKey, mode])

  const selectedTimezone = runtimeStatus?.appliedTimezone || (timezoneStrategy === 'follow'
    ? exitTimezone
    : timezoneStrategy === 'fixed'
      ? fixedTimezone
      : originalTimezone)
  const fixedMismatch = timezoneStrategy === 'fixed' && fixedTimezone !== exitTimezone

  const targetLabel = useMemo(() => {
    if (targets.length === 2) return 'Claude Code + Desktop'
    return targets[0] === 'claude_desktop' ? 'Claude Desktop' : 'Claude Code'
  }, [targets])

  const toggleTarget = (target: string) => {
    setTargets((current) => current.includes(target) ? current.filter((item) => item !== target) : [...current, target])
  }

  const submit = () => {
    if (targets.length === 0) return
    if (timezoneStrategy === 'unchanged' && !waiverAccepted) {
      setDialog('waiver')
      return
    }
    if (platform === 'macos' && timezoneStrategy !== 'unchanged') {
      setDialog('authorization')
      return
    }
    onTakeover?.({ timezoneStrategy, fixedTimezone, blockWebRTC: true, blockGeolocation: true, targets })
  }

  const confirmAuthorization = () => {
    setDialog(null)
    onTakeover?.({ timezoneStrategy, fixedTimezone, blockWebRTC: true, blockGeolocation: true, targets })
  }

  if (mode === 'residue') {
    return (
      <section className="overflow-hidden rounded-[14px] border border-[var(--warning)] bg-[var(--bg-card)]" aria-label="检测到未还原设置">
        <div className="flex items-start gap-3 bg-[var(--warning)]/10 px-5 py-4">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-[var(--warning)]/15 text-[var(--warning-deep)]">
            <AlertTriangle size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[14px] font-bold text-[var(--text-primary)]">检测到未还原的防护设置</h2>
              <span className="rounded-full bg-[var(--warning)]/15 px-2 py-0.5 text-[10px] font-semibold text-[var(--warning-deep)]">上次异常退出</span>
            </div>
            <p className="mt-1 max-w-[68ch] text-[11px] leading-relaxed text-[var(--text-secondary)]">
              上次接管可能因崩溃或强制结束而中断。本机时区仍为 <span className="font-mono-data text-[var(--text-primary)]">{exitTimezone}</span>。
            </p>
          </div>
        </div>
        <div className="flex items-center justify-between gap-4 px-5 py-3.5">
          <p className="text-[10px] text-[var(--text-muted)]">将按备份恢复到 {originalTimezone}，完成后才能再次接管。</p>
          <Button onClick={onRecover}><RotateCcw size={14} />立即还原</Button>
        </div>
      </section>
    )
  }

  return (
    <>
      <section className="overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-card)]" aria-label="Anthropic">
        <div className="flex items-start justify-between gap-4 border-b border-[var(--border-light)] px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <ProviderLogo provider="anthropic" size={19} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-[14px] font-bold text-[var(--text-primary)]">Claude · Anthropic</h2>
                <span className="rounded-full bg-[var(--primary-light)] px-2 py-0.5 text-[9px] font-semibold text-[var(--primary-strong)]">主防线</span>
              </div>
              <p className="mt-0.5 text-[10px] text-[var(--text-muted)]">非沙箱本地接管，出口与宿主环境一起对齐</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-[10px] text-[var(--text-muted)]">
            <StatusDot tone={exitTimezone ? 'success' : 'muted'} />{exitTimezone ? '出口已就绪' : '正在识别出口'}
            {exitTimezone && <span className="font-mono-data">{exitTimezone}</span>}
          </div>
        </div>

        {mode === 'configure' && (
          <div className="px-5 py-4">
            <div className="mb-4">
              <div className="mb-2 flex items-center justify-between">
                <div>
                  <h3 className="text-[12px] font-semibold text-[var(--text-primary)]">接管对象</h3>
                  <p className="mt-0.5 text-[10px] text-[var(--text-muted)]">已检测到 {selectableTargets.length} 个可接管客户端</p>
                </div>
                <span className="text-[10px] text-[var(--text-muted)]">已选 {targets.length}/{selectableTargets.length}</span>
              </div>
              <div className="flex gap-2">
                {availableTargets.includes('claude') && <TargetButton selected={targets.includes('claude')} title="Claude Code (CLI + VSCode)" note={disabledTargets.includes('claude') ? '未检测到 Claude 配置目录' : '终端与编辑器扩展'} disabled={disabledTargets.includes('claude')} onClick={() => toggleTarget('claude')} />}
                {availableTargets.includes('claude_desktop') && <TargetButton selected={targets.includes('claude_desktop')} title="Claude Desktop (Code/Cowork)" note={disabledTargets.includes('claude_desktop') ? '未安装 / 未检测到' : '官方桌面客户端'} disabled={disabledTargets.includes('claude_desktop')} onClick={() => toggleTarget('claude_desktop')} />}
              </div>
            </div>

            <div className="rounded-[12px] bg-[var(--bg-tertiary)]/70 px-4 py-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <ShieldCheck size={15} className="text-[var(--primary-strong)]" />
                    <h3 className="text-[12px] font-semibold text-[var(--text-primary)]">时区策略</h3>
                  </div>
                  <p className="mt-1 text-[10px] leading-relaxed text-[var(--text-muted)]">接管前记录原始时区，取消接管时自动还原。</p>
                </div>
                <div className="hidden shrink-0 items-center gap-1.5 rounded-full bg-[var(--bg-card)] px-2.5 py-1 text-[9px] text-[var(--text-muted)] sm:flex">
                  <LockKeyhole size={11} /> 可完整还原
                </div>
              </div>

              <div className="mt-3 overflow-hidden rounded-[10px] bg-[var(--bg-card)] px-3.5">
                <div className="py-3">
                  <div className="flex items-center gap-3">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"><Clock3 size={15} /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] font-semibold text-[var(--text-primary)]">时区对齐</span>
                        <span className="rounded-full bg-[var(--primary-light)] px-1.5 py-0.5 text-[8px] font-semibold text-[var(--primary-strong)]">最关键</span>
                      </div>
                      <p className="mt-0.5 text-[10px] text-[var(--text-muted)]">本机当前 {originalTimezone}，出口位于 {exitTimezone}</p>
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-1 rounded-[9px] bg-[var(--bg-tertiary)] p-1">
                    {([
                      ['follow', '跟随出口 IP', '推荐'],
                      ['fixed', '固定时区', 'UTC+8'],
                      ['unchanged', '不改', '需免责'],
                    ] as const).map(([value, label, note]) => (
                      <button
                        type="button"
                        key={value}
                        onClick={() => {
                          setTimezoneStrategy(value)
                          if (value !== 'unchanged') setWaiverAccepted(false)
                        }}
                        className={cn(
                          'rounded-[7px] px-2 py-1.5 text-left transition-colors',
                          timezoneStrategy === value ? 'bg-[var(--bg-card)] shadow-[var(--shadow-sm)]' : 'hover:bg-[var(--bg-hover)]',
                        )}
                      >
                        <span className={cn('block text-[10px] font-semibold', timezoneStrategy === value ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]')}>{label}</span>
                        <span className={cn('mt-0.5 block text-[8px]', value === 'unchanged' ? 'text-[var(--warning-deep)]' : 'text-[var(--text-muted)]')}>{note}</span>
                      </button>
                    ))}
                  </div>

                  {timezoneStrategy === 'fixed' && (
                    <div className="mt-2.5">
                      <label className="relative block">
                        <select
                          value={fixedTimezone}
                          onChange={(event) => setFixedTimezone(event.target.value)}
                          className="h-9 w-full appearance-none rounded-[8px] border border-[var(--border)] bg-[var(--bg-card)] px-3 pr-8 font-mono-data text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--primary)]"
                        >
                          {TIMEZONES.map(([iana, region]) => <option key={iana} value={iana}>{region} · {iana}</option>)}
                        </select>
                        <ChevronDown size={14} className="pointer-events-none absolute right-3 top-2.5 text-[var(--text-muted)]" />
                      </label>
                      <p className="mt-1.5 text-[9px] leading-relaxed text-[var(--text-muted)]">Windows 上部分城市会归并为同一系统时区；界面保留 IANA 名，实际结果以系统能力为准。</p>
                    </div>
                  )}

                  {timezoneStrategy === 'unchanged' && (
                    <div className="mt-2.5 flex items-start gap-2 rounded-[8px] bg-[var(--warning)]/10 px-2.5 py-2 text-[9px] leading-relaxed text-[var(--warning-deep)]">
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" />保留真实时区可能与出口所在地矛盾。继续前需要确认风险，封号不包赔。
                    </div>
                  )}

                  {fixedMismatch && (
                    <div className="mt-2.5 flex items-start gap-2 rounded-[8px] bg-[var(--warning)]/10 px-2.5 py-2 text-[9px] leading-relaxed text-[var(--warning-deep)]">
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" />固定为 {fixedTimezone}，但当前出口为 {exitTimezone}。错误的固定时区会制造新的矛盾，建议改用“跟随出口 IP”。
                    </div>
                  )}
                </div>

              </div>
            </div>

            {(error || runtimeStatus?.lastError) && <div className="mt-3 rounded-[9px] bg-[var(--danger)]/10 px-3 py-2 text-[10px] leading-relaxed text-[var(--danger)]">{error || runtimeStatus?.lastError}</div>}
            <div className="mt-4 flex items-center justify-between gap-4">
              <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)]">
                <CircleDot size={12} className="text-[var(--success)]" />
                {platform === 'macos' ? 'macOS 将在确认后说明管理员授权用途' : 'Windows 全程静默，不弹管理员授权'}
              </div>
              <Button disabled={targets.length === 0 || busy || (requireExitTimezone && !exitTimezone && timezoneStrategy === 'follow')} onClick={submit}><ShieldCheck size={14} />{busy ? '处理中…' : '确认并接管'}</Button>
            </div>
          </div>
        )}

        {mode === 'active' && (
          <div className="px-5 py-4">
            <div className="mb-4 flex items-center justify-between gap-4 rounded-[11px] bg-[var(--success)]/10 px-3.5 py-3">
              <div className="flex items-center gap-2.5">
                <CheckCircle2 size={18} className="text-[var(--success-strong)]" />
                <div><div className="text-[12px] font-semibold text-[var(--text-primary)]">防护已生效，接管中</div><div className="mt-0.5 text-[10px] text-[var(--text-muted)]">{targetLabel} · 所有原值已备份</div></div>
              </div>
              <span className="font-mono-data text-[10px] text-[var(--success-strong)]">ACTIVE</span>
            </div>

            {onStopTarget && (
              <div className="mb-3 grid grid-cols-2 gap-2">
                {targets.map((target) => {
                  const label = target === 'claude_desktop' ? 'Claude Desktop' : 'Claude Code'
                  return <div key={target} className="flex items-center gap-2 rounded-[9px] bg-[var(--bg-tertiary)] px-3 py-2"><StatusDot tone="success" /><span className="min-w-0 flex-1 truncate text-[10px] font-medium text-[var(--text-secondary)]">{label} · 接管中</span><Button size="sm" variant="ghost" disabled={busy} onClick={() => onStopTarget(target)} aria-label={`仅停止 ${label}`} className="h-6 px-2 text-[9px]">仅停止</Button></div>
                })}
              </div>
            )}

            <div className="overflow-hidden rounded-[10px] border border-[var(--border-light)]">
              {[
                ['时区', `已设为 ${selectedTimezone}`, '可还原'],
              ].map(([label, value, tag], index) => (
                <div key={label} className={cn('flex items-center gap-3 px-3.5 py-2.5', index > 0 && 'border-t border-[var(--border-light)]')}>
                  <Check size={13} className="text-[var(--success-strong)]" />
                  <span className="w-[88px] text-[11px] font-medium text-[var(--text-secondary)]">{label}</span>
                  <span className="min-w-0 flex-1 truncate font-mono-data text-[10px] text-[var(--text-primary)]">{value}</span>
                  <span className="text-[9px] text-[var(--text-muted)]">{tag}</span>
                </div>
              ))}
            </div>

            <div className="mt-4 flex items-center justify-between gap-4">
              <p className="text-[10px] text-[var(--text-muted)]">取消接管会先停止客户端，再恢复备份的宿主设置。</p>
              <Button variant="secondary" disabled={busy} onClick={onRestore}><RotateCcw size={14} />{busy ? '处理中…' : '取消接管并还原'}</Button>
            </div>
          </div>
        )}

        {mode === 'restoring' && (
          <div className="px-5 py-5">
            <div className="flex items-center gap-3 rounded-[11px] bg-[var(--primary-light)] px-4 py-3.5">
              <RefreshCw size={18} className="animate-spin text-[var(--primary-strong)]" />
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-semibold text-[var(--text-primary)]">正在还原宿主环境</div>
                <p className="mt-0.5 text-[10px] text-[var(--text-muted)]">请保持冰茶运行，完成后会自动刷新状态。</p>
              </div>
              <span className="font-mono-data text-[10px] text-[var(--primary-strong)]">2 / 3</span>
            </div>
            <div className="mt-3 space-y-2 px-1">
              <div className="flex items-center gap-2 text-[10px] text-[var(--primary-strong)]"><RefreshCw size={12} className="animate-spin" />正在恢复时区至 {originalTimezone}</div>
              <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)]"><Clock3 size={12} />正在验证还原结果</div>
            </div>
          </div>
        )}

        {mode === 'restored' && (
          <div className="px-5 py-5">
            <div className="flex items-start gap-3 rounded-[11px] bg-[var(--success)]/10 px-4 py-3.5">
              <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-[var(--success-strong)]" />
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-semibold text-[var(--text-primary)]">宿主环境已完整还原</div>
                <p className="mt-0.5 text-[10px] leading-relaxed text-[var(--text-muted)]">接管已停止，时区已恢复为 {originalTimezone}。</p>
              </div>
              <span className="font-mono-data text-[10px] text-[var(--success-strong)]">RESTORED</span>
            </div>
            <div className="mt-4 flex items-center justify-between gap-4">
              <p className="text-[10px] text-[var(--text-muted)]">备份已核验并清除，本机没有遗留接管设置。</p>
              <Button variant="secondary" onClick={onContinue}><RotateCcw size={14} />返回接管配置</Button>
            </div>
          </div>
        )}
      </section>

      {dialog === 'waiver' && (
        <DialogFrame
          title="确认保留真实时区"
          icon={AlertTriangle}
          footer={<><Button variant="secondary" onClick={() => setDialog(null)}>返回修改</Button><Button disabled={!waiverAccepted} onClick={() => { setDialog(null); submit() }}>接受风险并继续</Button></>}
        >
          <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">不对齐时区会保留真机的 <span className="font-mono-data text-[var(--text-primary)]">{originalTimezone}</span>。如果它与出口 <span className="font-mono-data text-[var(--text-primary)]">{exitTimezone}</span> 矛盾，可能被识别为异常环境。</p>
          <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-[10px] bg-[var(--warning)]/10 p-3">
            <input type="checkbox" checked={waiverAccepted} onChange={(event) => setWaiverAccepted(event.target.checked)} className="mt-0.5 accent-[var(--primary-strong)]" />
            <span className="text-[10px] leading-relaxed text-[var(--text-primary)]">我理解不改时区可能增加风控风险，并确认继续。因这一选择导致的封号不包赔。</span>
          </label>
        </DialogFrame>
      )}

      {dialog === 'authorization' && (
        <DialogFrame
          title="需要一次管理员授权"
          icon={LockKeyhole}
          footer={<><Button variant="secondary" onClick={() => setDialog(null)}>取消</Button><Button onClick={confirmAuthorization}>继续并唤起系统密码框</Button></>}
        >
          <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">macOS 需要授权冰茶修改系统时区。其他宿主防护会随接管自动执行，不需要额外操作。</p>
          <div className="mt-4 overflow-hidden rounded-[10px] border border-[var(--border-light)]">
            <div className="flex items-center gap-3 px-3 py-2.5"><Globe2 size={14} className="text-[var(--primary-strong)]" /><span className="flex-1 text-[10px] text-[var(--text-secondary)]">系统时区</span><span className="font-mono-data text-[10px] text-[var(--text-primary)]">{originalTimezone} → {selectedTimezone}</span></div>
          </div>
          <p className="mt-3 text-[9px] leading-relaxed text-[var(--text-muted)]">原始时区已记录。取消接管时会自动还原；若系统授权已过期，macOS 可能再次要求确认。</p>
        </DialogFrame>
      )}
    </>
  )
}
