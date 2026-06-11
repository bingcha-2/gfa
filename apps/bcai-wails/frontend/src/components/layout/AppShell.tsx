import React, { useState } from 'react'
import { Sidebar } from './Sidebar'
import { AnnouncementBar } from '@/components/AnnouncementBar'
import { UpdateBanner } from '@/components/UpdateBanner'
import { WhatsNewBanner } from '@/components/WhatsNewBanner'
import { ThemeToggle } from '@/components/ThemeToggle'
import { LanguageMenu } from '@/components/LanguageMenu'
import { BAR_H, topInset } from './chrome'
import { useT } from '@/i18n'
import type { PageId } from '@/types'

interface AppShellProps {
  currentPage: PageId
  onPageChange: (page: PageId) => void
  children: React.ReactNode
}

export function AppShell({ currentPage, onPageChange, children }: AppShellProps) {
  const t = useT()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  const pageTitles: Record<string, string> = {
    home: t('nav.home'),
    faq: t('nav.faq'),
    logs: t('nav.logs'),
    settings: t('nav.settings'),
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar
        currentPage={currentPage}
        onPageChange={onPageChange}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
      />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* 顶部安全区:高度与侧边栏一致(mac 44 / 其它 16),保证分隔线贯通 */}
        <div
          className="shrink-0"
          style={{ height: `${topInset()}px`, '--wails-draggable': 'drag' } as React.CSSProperties}
        />

        {/* Top bar: page title + global controls(48px,与侧边栏品牌行等高) */}
        <header
          className="shrink-0 flex items-center justify-between gap-3 px-6 border-b border-[var(--border-light)]"
          style={{ height: `${BAR_H}px`, '--wails-draggable': 'drag' } as React.CSSProperties}
        >
          <h1 className="text-[15px] font-bold text-[var(--text-primary)] tracking-tight">
            {pageTitles[currentPage] || ''}
          </h1>
          <div
            className="flex items-center gap-2"
            style={{ '--wails-draggable': 'no-drag' } as React.CSSProperties}
          >
            <LanguageMenu />
            <ThemeToggle />
          </div>
        </header>

        {/* 更新提示 / 更新完成 / 公告 */}
        <div className="shrink-0 px-6 pt-3">
          <UpdateBanner />
          <WhatsNewBanner />
          <AnnouncementBar />
        </div>

        {/* Scrollable content */}
        <main className="flex-1 overflow-y-auto px-6 pb-5">
          {children}
        </main>
      </div>
    </div>
  )
}
