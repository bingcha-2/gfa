import { LayoutDashboard, Database, ScrollText, Settings, PanelLeftClose, PanelLeftOpen, Download } from 'lucide-react'
import { useAppStore } from '@/stores/useAppStore'
import { cn } from '@/lib/utils'
import * as api from '@/services/wails'
import type { PageId } from '@/types'

const SIDEBAR_EXPANDED = 200
const SIDEBAR_COLLAPSED = 88

interface SidebarProps {
  currentPage: PageId
  onPageChange: (page: PageId) => void
  collapsed: boolean
  onToggleCollapse: () => void
}

const navItems: { id: PageId; label: string; icon: React.ElementType }[] = [
  { id: 'home', label: '控制台', icon: LayoutDashboard },
  { id: 'pool', label: '本地号池', icon: Database },
  { id: 'logs', label: '日志', icon: ScrollText },
]

export function Sidebar({ currentPage, onPageChange, collapsed, onToggleCollapse }: SidebarProps) {
  const appVersion = useAppStore((s) => s.appVersion)
  const updateStatus = useAppStore((s) => s.updateStatus)
  const width = collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED

  const hasUpdate = updateStatus && updateStatus.status === 'available'

  return (
    <>
      <nav
        className="relative flex flex-col h-full bg-[var(--sidebar-bg)] backdrop-blur-xl border-r border-[var(--border-light)]"
        style={{
          width: `${width}px`,
          transition: 'width 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {/* ① Traffic lights zone */}
        <div
          className="h-[56px] shrink-0"
          style={{ '--wails-draggable': 'drag' } as React.CSSProperties}
        />

        {/* ② Brand row */}
        <div
          className={cn(
            'shrink-0 pb-3 mb-1',
            collapsed ? 'mx-3 flex justify-center' : 'mx-3 flex items-center gap-2.5'
          )}
          style={{ borderBottom: '1px solid var(--border-light)' }}
        >
          <div
            className="flex items-center gap-2.5"
            style={{ '--wails-draggable': 'no-drag' } as React.CSSProperties}
          >
            <img src="/src/assets/images/bcai-icon.png" alt="冰茶AI" className="w-10 h-10 rounded-xl shadow-sm" />
            {!collapsed && (
              <span className="text-[14px] font-bold text-[var(--text-primary)] tracking-tight select-none">冰茶AI</span>
            )}
          </div>
        </div>

        {/* ③ Main nav */}
        <div className={cn('flex-1 flex flex-col gap-[3px] pt-2', collapsed ? 'px-3 items-center' : 'px-3')}>
          {navItems.map((item) => {
            const Icon = item.icon
            const isActive = currentPage === item.id
            return (
              <button
                key={item.id}
                onClick={() => onPageChange(item.id)}
                title={collapsed ? item.label : undefined}
                className={cn(
                  'flex items-center rounded-[10px] text-[13px] font-medium transition-all duration-200 text-left',
                  collapsed ? 'justify-center w-[48px] h-[48px]' : 'gap-3 px-3 h-[42px] w-full',
                  isActive
                    ? 'bg-[rgba(37,99,235,0.12)] text-[var(--primary)] font-semibold'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                )}
              >
                <Icon size={20} strokeWidth={isActive ? 2.2 : 1.7} className="flex-shrink-0" />
                {!collapsed && item.label}
              </button>
            )
          })}
        </div>

        {/* ④ Bottom: Settings + Version + Update */}
        <div className={cn('pb-3', collapsed ? 'px-3' : 'px-3')}>
          <div className="border-t border-[var(--border-light)] mb-2" />

          <div className={cn('flex flex-col gap-[3px]', collapsed && 'items-center')}>
            {/* Settings button */}
            <button
              onClick={() => onPageChange('settings')}
              title={collapsed ? '设置' : undefined}
              className={cn(
                'flex items-center rounded-[10px] text-[13px] font-medium transition-all duration-200 text-left',
                collapsed ? 'justify-center w-[48px] h-[48px]' : 'gap-3 px-3 h-[42px] w-full',
                currentPage === 'settings'
                  ? 'bg-[rgba(37,99,235,0.12)] text-[var(--primary)] font-semibold'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
              )}
            >
              <Settings size={20} strokeWidth={currentPage === 'settings' ? 2.2 : 1.7} className="flex-shrink-0" />
              {!collapsed && '设置'}
            </button>

            {/* Update button — next to settings */}
            {hasUpdate && (
              <button
                onClick={() => api.downloadUpdate()}
                title={`更新到 v${updateStatus!.version}`}
                className={cn(
                  'flex items-center rounded-[10px] text-[12px] font-semibold transition-all duration-200',
                  collapsed
                    ? 'justify-center w-[48px] h-[48px] bg-[var(--primary-light)] text-[var(--primary)]'
                    : 'gap-2.5 px-3 h-[36px] w-full bg-[var(--primary-light)] text-[var(--primary)] hover:bg-[rgba(37,99,235,0.18)]'
                )}
              >
                <Download size={15} className="flex-shrink-0" />
                {!collapsed && `v${updateStatus!.version} 可用`}
              </button>
            )}
          </div>

          {/* Version */}
          {!collapsed && (
            <div className="px-3 pt-2 text-[10px] text-[var(--text-muted)] font-mono select-none">v{appVersion}</div>
          )}
        </div>
      </nav>

      {/* ⑤ Collapse handle */}
      <button
        onClick={onToggleCollapse}
        className="fixed z-50 flex items-center justify-center border border-[var(--border-light)] border-l-0 rounded-r-[10px] bg-[var(--bg-card)] backdrop-blur-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer w-[18px] h-[30px] shadow-[4px_0_12px_rgba(15,23,42,0.08)]"
        style={{
          top: '72px',
          left: `${width}px`,
          transition: 'left 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
          '--wails-draggable': 'no-drag',
        } as React.CSSProperties}
        title={collapsed ? '展开侧边栏' : '收起侧边栏'}
      >
        {collapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
      </button>
    </>
  )
}
