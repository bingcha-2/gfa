import { useState, useEffect } from 'react'
import { AppShell } from '@/components/layout/AppShell'
import { DashboardPage } from '@/pages/DashboardPage'
import { LogsPage } from '@/pages/LogsPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { Modal } from '@/components/Modal'
import { useAppStore } from '@/stores/useAppStore'
import { useLogStore } from '@/stores/useLogStore'
import { usePolling } from '@/hooks/usePolling'
import type { PageId } from '@/types'

export default function App() {
  const [currentPage, setCurrentPage] = useState<PageId>('home')

  const { fetchStats, fetchConfig, fetchIDEStatus, fetchAnnouncement } = useAppStore()
  const { fetchLogs } = useLogStore()

  // Initialize on mount
  useEffect(() => {
    fetchConfig()
    fetchIDEStatus()
    fetchAnnouncement()
  }, [])

  // Polling: stats every 2s, IDE every 15s, announcement every 5min
  // 降低频率 + 后端缓存，避免 IPC 阻塞导致界面卡死
  usePolling(fetchStats, 2000)
  usePolling(fetchIDEStatus, 15000)
  usePolling(fetchAnnouncement, 30 * 60 * 1000)

  // 日志仅在日志页时才轮询（减少非活跃页的 IPC 开销）
  usePolling(fetchLogs, 3000, currentPage === 'logs')

  const renderPage = () => {
    switch (currentPage) {
      case 'home': return <DashboardPage />
      case 'logs': return <LogsPage />
      case 'settings': return <SettingsPage />
    }
  }

  return (
    <AppShell currentPage={currentPage} onPageChange={setCurrentPage}>
      {renderPage()}
    </AppShell>
  )
}
