import { LocalProviderSuite } from '@/features/local/shared/LocalProviderSuite'
import { antigravityLocalApi } from '@/services/localApi'
import type { PageId } from '@/types'

/** 本地自有号 · Antigravity。账号管理 + 统计 + 保活。app 启停与注入目标(IDE/独立版)在「接管中心」。 */
export function AntigravitySuitePage({ onNavigate }: { onNavigate?: (p: PageId) => void } = {}) {
  return <LocalProviderSuite title="Antigravity" api={antigravityLocalApi} onNavigate={onNavigate} />
}
