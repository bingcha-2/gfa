import {
  BookOpen,
  Cloud,
  Download,
  PanelLeftClose,
  PanelLeftOpen,
  PlugZap,
  Rocket,
  ScrollText,
  Settings,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react'
import { useAppStore } from '@/stores/useAppStore'
import { cn } from '@/lib/utils'
import * as api from '@/services/wails'
import { useT } from '@/i18n'
import { BAR_H, topInset } from './chrome'
import type { PageId } from '@/types'
import bcaiIcon from '@/assets/images/bcai-icon.png'
import { AccountDock } from '@/components/AccountDock'

const SIDEBAR_EXPANDED = 194
const SIDEBAR_COLLAPSED = 68

interface SidebarProps {
  currentPage: PageId
  onPageChange: (page: PageId) => void
  collapsed: boolean
  onToggleCollapse: () => void
}

function NavItem({
  icon: Icon,
  label,
  active,
  collapsed,
  onClick,
}: {
  icon: LucideIcon
  label: string
  active: boolean
  collapsed: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={collapsed ? label : undefined}
      className={cn(
        'flex h-[40px] items-center rounded-[10px] text-[12px] font-medium transition-colors',
        collapsed ? 'w-[42px] justify-center' : 'w-full gap-2.5 px-3 text-left',
        active
          ? 'bg-[var(--primary-light)] font-semibold text-[var(--primary-strong)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
      )}
    >
      <Icon size={17} strokeWidth={active ? 2.2 : 1.7} className="shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </button>
  )
}

export function Sidebar({ currentPage, onPageChange, collapsed, onToggleCollapse }: SidebarProps) {
  const t = useT()
  const appVersion = useAppStore((state) => state.appVersion)
  const updateStatus = useAppStore((state) => state.updateStatus)
  const width = collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED
  const hasUpdate = updateStatus?.status === 'available'

  const primaryItems: { id: PageId; label: string; icon: LucideIcon }[] = [
    { id: 'takeover', label: t('nav.takeover'), icon: SlidersHorizontal },
    { id: 'remote', label: t('nav.home'), icon: Cloud },
  ]
  const localItems: { id: PageId; label: string; icon: LucideIcon }[] = [
    { id: 'local_codex', label: 'Codex', icon: PlugZap },
    { id: 'local_antigravity', label: 'Antigravity', icon: Rocket },
  ]
  const utilityItems: { id: PageId; label: string; icon: LucideIcon }[] = [
    { id: 'faq', label: t('nav.faq'), icon: BookOpen },
    { id: 'logs', label: t('nav.logs'), icon: ScrollText },
    { id: 'settings', label: t('nav.settings'), icon: Settings },
  ]

  return (
    <nav
      className="relative flex h-full shrink-0 flex-col border-r border-[var(--border-light)] bg-[var(--sidebar-bg)]"
      style={{ width, transition: 'width 0.24s cubic-bezier(0.16, 1, 0.3, 1)' }}
    >
      <div className="shrink-0" style={{ height: topInset(), '--wails-draggable': 'drag' } as React.CSSProperties} />

      <div
        className={cn('mx-3 flex shrink-0 items-center border-b border-[var(--border-light)]', collapsed ? 'justify-center' : 'gap-2.5 px-1')}
        style={{ height: BAR_H, '--wails-draggable': 'drag' } as React.CSSProperties}
      >
        <img src={bcaiIcon} alt="冰茶AI" className="h-8 w-8 shrink-0 rounded-[10px] shadow-sm" />
        {!collapsed && <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-[var(--text-primary)]">冰茶AI</span>}
        {!collapsed && (
          <button
            type="button"
            onClick={onToggleCollapse}
            title={t('nav.collapseSidebar')}
            className="grid h-7 w-7 place-items-center rounded-[7px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            style={{ '--wails-draggable': 'no-drag' } as React.CSSProperties}
          >
            <PanelLeftClose size={14} />
          </button>
        )}
      </div>

      {collapsed && (
        <button
          type="button"
          onClick={onToggleCollapse}
          title={t('nav.expandSidebar')}
          className="mx-auto mt-2 grid h-8 w-[42px] place-items-center rounded-[8px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <PanelLeftOpen size={14} />
        </button>
      )}

      <div className={cn('flex flex-1 flex-col gap-0.5 pt-2', collapsed ? 'items-center px-2' : 'px-3')}>
        {primaryItems.map((item) => (
          <NavItem key={item.id} {...item} collapsed={collapsed} active={currentPage === item.id} onClick={() => onPageChange(item.id)} />
        ))}

        {!collapsed && <div className="px-3 pb-1 pt-3 text-[9px] font-semibold text-[var(--text-muted)]">本地自有号</div>}
        {localItems.map((item) => (
          <NavItem key={item.id} {...item} collapsed={collapsed} active={currentPage === item.id} onClick={() => onPageChange(item.id)} />
        ))}
      </div>

      <div className={cn('mx-3 border-t border-[var(--border-light)] py-2.5', collapsed && 'flex flex-col items-center')}>
        {utilityItems.map((item) => (
          <NavItem key={item.id} {...item} collapsed={collapsed} active={currentPage === item.id} onClick={() => onPageChange(item.id)} />
        ))}

        {hasUpdate && (
          <button
            type="button"
            onClick={() => api.downloadUpdate()}
            title={t('nav.updateTo', { version: updateStatus!.version })}
            className={cn(
              'mt-1 flex h-9 items-center rounded-[9px] bg-[var(--primary-light)] text-[10px] font-semibold text-[var(--primary-strong)]',
              collapsed ? 'w-[42px] justify-center' : 'w-full gap-2 px-3',
            )}
          >
            <Download size={14} />{!collapsed && t('nav.updateAvailable', { version: updateStatus!.version })}
          </button>
        )}

        <div className="mt-2 w-full border-t border-[var(--border-light)] pt-2">
          <AccountDock collapsed={collapsed} onNavigate={onPageChange} />
        </div>
        {!collapsed && <div className="px-2 pt-2 font-mono-data text-[8px] text-[var(--text-muted)]">v{appVersion}</div>}
      </div>
    </nav>
  )
}
