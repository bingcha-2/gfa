import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { initTheme } from './lib/theme'

// 渲染前应用主题,避免首帧闪烁
initTheme()

const root = ReactDOM.createRoot(document.getElementById('root')!)

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
