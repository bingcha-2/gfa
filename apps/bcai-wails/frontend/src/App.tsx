import { useState, useEffect } from 'react'
import { AppShell } from '@/components/layout/AppShell'
import { DashboardPage } from '@/pages/DashboardPage'
import { LogsPage } from '@/pages/LogsPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { FaqPage } from '@/pages/FaqPage'
import { LoginPage } from '@/pages/LoginPage'
import { ToastHost } from '@/components/ToastHost'
import { useAppStore } from '@/stores/useAppStore'
import { useLogStore } from '@/stores/useLogStore'
import { usePolling } from '@/hooks/usePolling'
import { useLocale } from '@/i18n'
import type { PageId } from '@/types'

export default function App() {
  const [currentPage, setCurrentPage] = useState<PageId>('home')
  // 语言切换时以 key 整树重挂,保证所有文案(含非订阅的 t() 调用)立即刷新。
  const locale = useLocale()

  const { fetchStats, fetchConfig, fetchIDEStatus, fetchAnnouncement, fetchAccountState, account } = useAppStore()
  const { fetchLogs } = useLogStore()

  // Initialize on mount
  useEffect(() => {
    fetchAccountState()
    fetchConfig()
    fetchIDEStatus()
    fetchAnnouncement()
  }, [])

  const isLoggedIn = account?.loggedIn === true

  // Polling: account state every 60s while logged in
  usePolling(fetchAccountState, 60000, isLoggedIn)

  // Polling: stats every 2s, IDE every 15s, announcement every 5min (only when logged in)
  // 降低频率 + 后端缓存，避免 IPC 阻塞导致界面卡死
  usePolling(fetchStats, 2000, isLoggedIn)
  usePolling(fetchIDEStatus, 15000, isLoggedIn)
  usePolling(fetchAnnouncement, 30 * 60 * 1000)

  // 日志仅在日志页时才轮询（减少非活跃页的 IPC 开销）
  usePolling(fetchLogs, 3000, currentPage === 'logs' && isLoggedIn)

  // Show login page when not logged in (null = loading, false = not logged in)
  // Only show login after initial account state has been fetched
  if (account !== null && !isLoggedIn) {
    return (
      <div key={locale} className="contents">
        <LoginPage />
        <ToastHost />
      </div>
    )
  }

  const renderPage = () => {
    switch (currentPage) {
      case 'home': return <DashboardPage />
      case 'logs': return <LogsPage />
      case 'faq': return <FaqPage />
      case 'settings': return <SettingsPage />
    }
  }

  return (
    <div key={locale} className="contents">
      <AppShell currentPage={currentPage} onPageChange={setCurrentPage}>
        {renderPage()}
      </AppShell>
      <ToastHost />
    </div>
  )
}
