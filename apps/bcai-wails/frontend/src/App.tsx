import { useState, useEffect } from 'react'
import { AppShell } from '@/components/layout/AppShell'
import { DashboardPage } from '@/pages/DashboardPage'
import { PoolPage } from '@/pages/PoolPage'
import { LogsPage } from '@/pages/LogsPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { Modal } from '@/components/Modal'
import { useAppStore } from '@/stores/useAppStore'
import { useLogStore } from '@/stores/useLogStore'
import { usePoolStore } from '@/stores/usePoolStore'
import { usePolling } from '@/hooks/usePolling'
import type { PageId } from '@/types'

export default function App() {
  const [currentPage, setCurrentPage] = useState<PageId>('home')

  const { fetchStats, fetchConfig, fetchIDEStatus, fetchAnnouncement } = useAppStore()
  const { fetchLogs } = useLogStore()
  const { initMode } = usePoolStore()

  // Initialize on mount
  useEffect(() => {
    fetchConfig()
    fetchIDEStatus()
    fetchAnnouncement()
    initMode()
  }, [])

  // Polling: stats every 1.5s, logs every 1.5s, IDE every 5s, announcement every 5min
  usePolling(fetchStats, 1500)
  usePolling(fetchLogs, 1500)
  usePolling(fetchIDEStatus, 5000)
  usePolling(fetchAnnouncement, 5 * 60 * 1000)

  const renderPage = () => {
    switch (currentPage) {
      case 'home': return <DashboardPage />
      case 'pool': return <PoolPage />
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
