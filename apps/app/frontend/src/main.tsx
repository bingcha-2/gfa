import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { initTheme } from './lib/theme'

// 渲染前应用主题,避免首帧闪烁
initTheme()

const root = ReactDOM.createRoot(document.getElementById('root')!)

// 本地造数据预览(VITE_MOCK=1 npm run dev):脱离 Go 后端渲染仪表盘看独享 badge + 彩蛋。
// 动态引入,mock 代码不进生产包。
if (import.meta.env.VITE_MOCK) {
  import('./dev/MockPreview').then(({ MockPreview }) => {
    root.render(
      <React.StrictMode>
        <MockPreview />
      </React.StrictMode>,
    )
  })
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}
