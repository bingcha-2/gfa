import React, { useState } from 'react'
import { Sidebar } from './Sidebar'
import { AnnouncementBar } from '@/components/AnnouncementBar'
import { ThemeToggle } from '@/components/ThemeToggle'
import type { PageId } from '@/types'

const pageTitles: Record<string, string> = {
  home: '控制台',
  faq: '使用指南',
  logs: '日志',
  settings: '设置',
}

interface AppShellProps {
  currentPage: PageId
  onPageChange: (page: PageId) => void
  children: React.ReactNode
}

export function AppShell({ currentPage, onPageChange, children }: AppShellProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar
        currentPage={currentPage}
        onPageChange={onPageChange}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
      />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Drag region */}
        <div
          className="h-[20px] shrink-0"
          style={{ '--wails-draggable': 'drag' } as React.CSSProperties}
        />

        {/* Top bar: page title + global controls */}
        <header className="shrink-0 flex items-center justify-between gap-3 px-6 h-[44px] border-b border-[var(--border-light)]">
          <h1 className="text-[15px] font-bold text-[var(--text-primary)] tracking-tight">
            {pageTitles[currentPage] || ''}
          </h1>
          <div
            className="flex items-center gap-2"
            style={{ '--wails-draggable': 'no-drag' } as React.CSSProperties}
          >
            <ThemeToggle />
          </div>
        </header>

        {/* Ad banner */}
        <div className="shrink-0 px-6 pt-3">
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
