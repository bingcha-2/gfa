import { useEffect } from 'react'
import { installMock } from './installMock'
import { useAppStore } from '@/stores/useAppStore'
import { DashboardPage } from '@/pages/DashboardPage'
import { PatronThanks } from '@/components/PatronThanks'

// 装了 mock 才能让 store 的 fetch* 拿到伪数据。install 必须在任何 fetch 之前跑,故放模块顶层。
installMock()

export function MockPreview() {
  useEffect(() => {
    const s = useAppStore.getState()
    s.fetchAccountState()
    s.fetchStats()
    s.fetchConfig()
  }, [])

  return (
    <div className="min-h-screen bg-[var(--bg-primary)] p-6">
      <div className="mb-4 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-[12px] text-amber-600">
        🧪 MOCK 预览 · 非真机数据。连点皇冠 badge <b>6 下</b> → 觉醒(撒金 + 文案变「氪金之王 金主大大」)+ 屏幕底部滑跪「感谢金主大大」。独享卡出 badge,拼车卡作对照无 badge。
      </div>
      <DashboardPage />
      <PatronThanks />
    </div>
  )
}
