import { LayoutDashboard, ScrollText, PanelLeftClose, PanelLeftOpen, Download, BookOpen, PlugZap } from 'lucide-react'
import { useAppStore } from '@/stores/useAppStore'
import { cn } from '@/lib/utils'
import * as api from '@/services/wails'
import { useT } from '@/i18n'
import { BAR_H, topInset } from './chrome'
import type { PageId } from '@/types'
import bcaiIcon from '@/assets/images/bcai-icon.png'
import { AccountDock } from '@/components/AccountDock'

const SIDEBAR_EXPANDED = 200
const SIDEBAR_COLLAPSED = 88

interface SidebarProps {
  currentPage: PageId
  onPageChange: (page: PageId) => void
  collapsed: boolean
  onToggleCollapse: () => void
}

export function Sidebar({ currentPage, onPageChange, collapsed, onToggleCollapse }: SidebarProps) {
  const t = useT()
  const appVersion = useAppStore((s) => s.appVersion)
  const updateStatus = useAppStore((s) => s.updateStatus)
  const width = collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED
  const inset = topInset()

  const hasUpdate = updateStatus && updateStatus.status === 'available'

  const navItems: { id: PageId; label: string; icon: React.ElementType }[] = [
    { id: 'home', label: t('nav.home'), icon: LayoutDashboard },
    { id: 'faq', label: t('nav.faq'), icon: BookOpen },
    { id: 'logs', label: t('nav.logs'), icon: ScrollText },
  ]

  return (
    <>
      <nav
        className="relative flex flex-col h-full bg-[var(--sidebar-bg)] border-r border-[var(--border-light)]"
        style={{
          width: `${width}px`,
          transition: 'width 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {/* ① 顶部安全区:mac 给红绿灯让位(簇底 ~28px),其余平台仅留空气;整条可拖拽 */}
        <div
          className="shrink-0"
          style={{ height: `${inset}px`, '--wails-draggable': 'drag' } as React.CSSProperties}
        />

        {/* ② Brand row:固定 48px,与内容区 header 等高 → 两栏分隔线连成一条贯通线 */}
        <div
          className={cn(
            'shrink-0 mx-3 flex items-center border-b border-[var(--border-light)]',
            collapsed ? 'justify-center' : 'gap-2.5'
          )}
          style={{ height: `${BAR_H}px`, '--wails-draggable': 'drag' } as React.CSSProperties}
        >
          <div
            className="flex items-center gap-2.5"
            style={{ '--wails-draggable': 'no-drag' } as React.CSSProperties}
          >
            <img src={bcaiIcon} alt="冰茶AI" className="w-8 h-8 rounded-[10px] shadow-sm" />
            {!collapsed && (
              <span className="text-[14px] font-bold text-[var(--text-primary)] tracking-tight select-none">冰茶AI</span>
            )}
          </div>
        </div>

        {/* ③ Main nav(分隔线下 8px 起步) */}
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
                    ? 'bg-[var(--primary-light)] text-[var(--primary-strong)] font-semibold'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                )}
              >
                <Icon size={20} strokeWidth={isActive ? 2.2 : 1.7} className="flex-shrink-0" />
                {!collapsed && item.label}
              </button>
            )
          })}

          {/* 本地自有号分组 */}
          {!collapsed && (
            <div className="px-3 pt-3 pb-1 text-[10px] font-bold tracking-wider text-[var(--text-muted)] select-none">本地自有号</div>
          )}
          <button
            onClick={() => onPageChange('local_codex')}
            title={collapsed ? 'Codex' : undefined}
            className={cn(
              'flex items-center rounded-[10px] text-[13px] font-medium transition-all duration-200 text-left',
              collapsed ? 'justify-center w-[48px] h-[48px]' : 'gap-3 px-3 h-[42px] w-full',
              currentPage === 'local_codex'
                ? 'bg-[var(--primary-light)] text-[var(--primary-strong)] font-semibold'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
            )}
          >
            <PlugZap size={20} strokeWidth={currentPage === 'local_codex' ? 2.2 : 1.7} className="flex-shrink-0" />
            {!collapsed && 'Codex'}
          </button>
        </div>

        {/* ④ Bottom: Settings + Version + Update */}
        <div className={cn('pb-3', collapsed ? 'px-3' : 'px-3')}>
          <div className="border-t border-[var(--border-light)] mb-2" />

          <div className={cn('flex flex-col gap-[3px]', collapsed && 'items-center')}>
            {/* 设置 / 意见反馈已收纳进账户坞菜单(见 AccountDock),左导航只留主页面入口,更清爽。 */}

            {/* Update button */}
            {hasUpdate && (
              <button
                onClick={() => api.downloadUpdate()}
                title={t('nav.updateTo', { version: updateStatus!.version })}
                className={cn(
                  'flex items-center rounded-[10px] text-[12px] font-semibold transition-all duration-200',
                  collapsed
                    ? 'justify-center w-[48px] h-[48px] bg-[var(--primary-light)] text-[var(--primary-strong)]'
                    : 'gap-2.5 px-3 h-[36px] w-full bg-[var(--primary-light)] text-[var(--primary-strong)] hover:brightness-95'
                )}
              >
                <Download size={15} className="flex-shrink-0" />
                {!collapsed && t('nav.updateAvailable', { version: updateStatus!.version })}
              </button>
            )}
          </div>

          {/* Account dock — 会员头像 + 点开会员通行证面板 */}
          <div className="border-t border-[var(--border-light)] mt-2 pt-2">
            <AccountDock collapsed={collapsed} onNavigate={onPageChange} />
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
          top: `${inset + BAR_H + 8}px`,
          left: `${width}px`,
          transition: 'left 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
          '--wails-draggable': 'no-drag',
        } as React.CSSProperties}
        title={collapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
      >
        {collapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
      </button>
    </>
  )
}
