import { useEffect, useState } from 'react'
import {
  Boxes,
  BookOpen,
  ChevronDown,
  CircleDot,
  Cloud,
  Command,
  LayoutDashboard,
  MonitorCog,
  Moon,
  Network,
  ScrollText,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  TerminalSquare,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ProviderLogo } from '@/components/ProviderLogo'
import {
  HostProtectionPanel,
  type HostProtectionMode,
} from '@/features/takeover/HostProtectionPanel'
import { cn } from '@/lib/utils'
import bcaiIcon from '@/assets/images/bcai-icon.png'
import {
  DashboardPreview,
  GuidePreview,
  LocalProviderPreview,
  LogsPreview,
  SettingsPreview,
} from './RedesignedPages'

type PreviewPage = 'takeover' | 'dashboard' | 'codex' | 'antigravity' | 'guide' | 'logs' | 'settings'

const PAGE_TITLES: Record<PreviewPage, string> = {
  takeover: '接管中心',
  dashboard: '用量看板',
  codex: 'Codex 本地账号',
  antigravity: 'Antigravity 本地账号',
  guide: '使用指南',
  logs: '运行日志',
  settings: '设置',
}

function NavItem({ icon: Icon, label, active = false, onClick }: { icon: typeof Cloud; label: string; active?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-[42px] w-full items-center gap-3 rounded-[10px] px-3 text-left text-[12px] font-medium transition-colors',
        active ? 'bg-[var(--primary-light)] font-semibold text-[var(--primary-strong)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
      )}
    >
      <Icon size={18} strokeWidth={active ? 2.2 : 1.7} />{label}
    </button>
  )
}

function CompactProduct({ provider, name, note, status, children }: { provider: string; name: string; note: string; status: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[13px] border border-[var(--border-light)] bg-[var(--bg-card)] px-4 py-3.5" aria-label={name}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <ProviderLogo provider={provider} size={16} />
          <div className="min-w-0"><h3 className="text-[12px] font-bold text-[var(--text-primary)]">{name}</h3><p className="mt-0.5 truncate text-[9px] text-[var(--text-muted)]">{note}</p></div>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 text-[9px] text-[var(--text-muted)]"><CircleDot size={10} />{status}</span>
      </div>
      <div className="mt-3 border-t border-[var(--border-light)] pt-3">{children}</div>
    </section>
  )
}

function ModeSwitch({ value }: { value: 'remote' | 'local' }) {
  return (
    <div className="inline-flex rounded-[8px] bg-[var(--bg-tertiary)] p-0.5">
      <button type="button" className={cn('rounded-[6px] px-2.5 py-1 text-[9px] font-semibold', value === 'remote' ? 'bg-[var(--bg-card)] text-[var(--text-primary)] shadow-[var(--shadow-sm)]' : 'text-[var(--text-muted)]')}>远程托管</button>
      <button type="button" className={cn('rounded-[6px] px-2.5 py-1 text-[9px] font-semibold', value === 'local' ? 'bg-[var(--bg-card)] text-[var(--text-primary)] shadow-[var(--shadow-sm)]' : 'text-[var(--text-muted)]')}>本地自有号</button>
    </div>
  )
}

export function TakeoverProtectionPreview() {
  const [page, setPage] = useState<PreviewPage>('takeover')
  const [mode, setMode] = useState<HostProtectionMode>('configure')
  const [platform, setPlatform] = useState<'windows' | 'macos'>('macos')
  const [sandboxOpen, setSandboxOpen] = useState(false)

  useEffect(() => {
    document.documentElement.classList.remove('dark')
  }, [])

  const startTakeover = () => setMode('active')
  const startRestore = () => {
    setMode('restoring')
    window.setTimeout(() => setMode('restored'), 1600)
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--bg-primary)]">
      <aside className="flex h-full w-[194px] shrink-0 flex-col border-r border-[var(--border-light)] bg-[var(--sidebar-bg)]">
        <div className="h-5 shrink-0" />
        <div className="mx-3 flex h-12 shrink-0 items-center gap-2.5 border-b border-[var(--border-light)] px-1">
          <img src={bcaiIcon} alt="冰茶AI" className="h-8 w-8 rounded-[10px] shadow-sm" />
          <span className="text-[13px] font-bold text-[var(--text-primary)]">冰茶AI</span>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-3 pt-2">
          <NavItem icon={SlidersHorizontal} label="接管中心" active={page === 'takeover'} onClick={() => setPage('takeover')} />
          <NavItem icon={LayoutDashboard} label="用量看板" active={page === 'dashboard'} onClick={() => setPage('dashboard')} />
          <div className="px-3 pb-1 pt-3 text-[9px] font-semibold text-[var(--text-muted)]">本地自有号</div>
          <NavItem icon={TerminalSquare} label="Codex" active={page === 'codex'} onClick={() => setPage('codex')} />
          <NavItem icon={Command} label="Antigravity" active={page === 'antigravity'} onClick={() => setPage('antigravity')} />
        </nav>
        <div className="mx-3 border-t border-[var(--border-light)] py-3">
          <NavItem icon={BookOpen} label="使用指南" active={page === 'guide'} onClick={() => setPage('guide')} />
          <NavItem icon={ScrollText} label="运行日志" active={page === 'logs'} onClick={() => setPage('logs')} />
          <NavItem icon={Settings} label="设置" active={page === 'settings'} onClick={() => setPage('settings')} />
          <div className="mt-2 flex items-center gap-2 rounded-[10px] px-2 py-2">
            <span className="grid h-8 w-8 place-items-center rounded-[9px] border border-[var(--border-light)] bg-[var(--bg-card)]"><img src={bcaiIcon} alt="" className="h-5 w-5 rounded-[5px]" /></span>
            <div className="min-w-0"><div className="truncate text-[10px] font-semibold text-[var(--text-primary)]">会员通行证</div><div className="truncate text-[9px] text-[var(--text-muted)]">design@bcai.lol</div></div>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="h-5 shrink-0" />
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border-light)] px-6">
          <div className="text-[13px] font-bold text-[var(--text-primary)]">{PAGE_TITLES[page]}</div>
          <div className="flex items-center gap-2">
            <button type="button" className="grid h-8 w-8 place-items-center rounded-[8px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"><Network size={15} /></button>
            <button type="button" className="grid h-8 w-8 place-items-center rounded-[8px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"><Moon size={15} /></button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto px-6 pb-16 pt-5">
          {page === 'takeover' && <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4">
            <div className="flex items-end justify-between gap-4">
              <div>
                <h1 className="text-[19px] font-bold tracking-tight text-[var(--text-primary)]">本机接管</h1>
                <p className="mt-1 text-[11px] text-[var(--text-secondary)]">为每个产品选择号源。Claude 接管会同步保护宿主环境，取消时自动还原。</p>
              </div>
              <div className="flex shrink-0 items-center gap-2 rounded-[9px] bg-[var(--bg-tertiary)] px-3 py-2">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--success)]" />
                <span className="text-[9px] text-[var(--text-muted)]">本地代理</span>
                <span className="font-mono-data text-[9px] text-[var(--text-secondary)]">127.0.0.1:48800</span>
              </div>
            </div>

            <HostProtectionPanel
              mode={mode}
              platform={platform}
              exitTimezone="Asia/Singapore"
              originalTimezone="Asia/Shanghai"
              onTakeover={startTakeover}
              onRestore={startRestore}
              onRecover={startRestore}
              onContinue={() => setMode('configure')}
            />

            <div className="mt-1 flex items-center justify-between">
              <div><h2 className="text-[12px] font-bold text-[var(--text-primary)]">其他产品</h2><p className="mt-0.5 text-[9px] text-[var(--text-muted)]">保留现有远程托管与本地自有号模式</p></div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <CompactProduct provider="codex" name="Codex" note="CLI + Desktop，共用 ~/.codex 配置" status="未接管">
                <div className="flex items-center justify-between gap-3"><ModeSwitch value="remote" /><Button size="sm">接管</Button></div>
              </CompactProduct>
              <CompactProduct provider="antigravity" name="Antigravity" note="IDE 与独立版可分别接管" status="1 个客户端接管中">
                <div className="flex items-center justify-between gap-3"><ModeSwitch value="local" /><Button size="sm" variant="secondary">管理账号</Button></div>
              </CompactProduct>
            </div>

            <section className="overflow-hidden rounded-[13px] border border-[var(--border-light)] bg-[var(--bg-card)]">
              <button type="button" onClick={() => setSandboxOpen((current) => !current)} className="flex w-full items-center gap-3 px-4 py-3.5 text-left">
                <span className="grid h-8 w-8 place-items-center rounded-[9px] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"><Boxes size={15} /></span>
                <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h2 className="text-[12px] font-semibold text-[var(--text-primary)]">隔离沙箱</h2><span className="rounded-full bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[8px] font-semibold text-[var(--text-muted)]">高级</span></div><p className="mt-0.5 text-[9px] text-[var(--text-muted)]">配置复杂，适合需要文件与网络隔离的场景；非沙箱接管为默认方案</p></div>
                <ChevronDown size={15} className={cn('text-[var(--text-muted)] transition-transform', sandboxOpen && 'rotate-180')} />
              </button>
              {sandboxOpen && (
                <div className="border-t border-[var(--border-light)] px-4 py-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-[10px] bg-[var(--bg-tertiary)] p-3"><div className="flex items-center gap-2 text-[10px] font-semibold text-[var(--text-primary)]"><TerminalSquare size={13} />Claude Code CLI</div><p className="mt-1.5 text-[9px] leading-relaxed text-[var(--text-muted)]">为项目目录创建独立 sbx 环境，模型请求可走冰茶托管。</p></div>
                    <div className="rounded-[10px] bg-[var(--bg-tertiary)] p-3"><div className="flex items-center gap-2 text-[10px] font-semibold text-[var(--text-primary)]"><MonitorCog size={13} />VSCode 扩展</div><p className="mt-1.5 text-[9px] leading-relaxed text-[var(--text-muted)]">保留编辑器界面，底层 Claude 进程在隔离环境运行。</p></div>
                  </div>
                </div>
              )}
            </section>
          </div>}
          {page === 'dashboard' && <DashboardPreview />}
          {page === 'codex' && <LocalProviderPreview provider="codex" />}
          {page === 'antigravity' && <LocalProviderPreview provider="antigravity" />}
          {page === 'guide' && <GuidePreview />}
          {page === 'logs' && <LogsPreview />}
          {page === 'settings' && <SettingsPreview />}
        </main>
      </div>

      {page === 'takeover' && <div className="fixed bottom-4 left-1/2 z-[var(--z-sticky)] flex -translate-x-1/2 items-center gap-1 rounded-[11px] border border-[var(--border)] bg-[var(--bg-card)] p-1 shadow-[var(--shadow-md)]">
        <span className="px-2 text-[9px] font-semibold text-[var(--text-muted)]">设计状态</span>
        {([
          ['configure', '接管前'],
          ['active', '生效中'],
          ['restoring', '还原中'],
          ['restored', '已还原'],
          ['residue', '异常恢复'],
        ] as const).map(([value, label]) => (
          <button key={value} type="button" onClick={() => setMode(value)} className={cn('rounded-[7px] px-2.5 py-1.5 text-[9px] font-semibold', mode === value ? 'bg-[var(--primary-strong)] text-[var(--primary-ink)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>{label}</button>
        ))}
        <span className="mx-1 h-4 w-px bg-[var(--border-light)]" />
        <button type="button" onClick={() => setPlatform((current) => current === 'macos' ? 'windows' : 'macos')} className="rounded-[7px] px-2.5 py-1.5 text-[9px] font-semibold text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
          {platform === 'macos' ? 'macOS' : 'Windows'}
        </button>
      </div>}
    </div>
  )
}
