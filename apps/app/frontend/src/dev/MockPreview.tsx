import { installMock } from './installMock'
import App from '@/App'

// 装了 mock 才能让 store 的 fetch* 拿到伪数据。install 必须在任何 fetch 之前跑,故放模块顶层。
installMock()

export function MockPreview() {
  return <App />
}
