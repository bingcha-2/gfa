import React, { useState } from 'react'
import { Sidebar } from './Sidebar'
import { AnnouncementBar } from '@/components/AnnouncementBar'
import type { PageId } from '@/types'

const pageTitles: Record<string, string> = {
  home: '控制台',
  pool: '本地号池',
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

        {/* Ad banner — above everything */}
        <div className="shrink-0 px-6">
          <AnnouncementBar />
        </div>

        {/* Page title */}
        <div className="shrink-0 px-6 pb-2">
          <h1 className="text-[16px] font-bold text-[var(--text-primary)]">
            {pageTitles[currentPage] || ''}
          </h1>
        </div>

        {/* Scrollable content */}
        <main className="flex-1 overflow-y-auto px-6 pb-5">
          {children}
        </main>
      </div>
    </div>
  )
}
