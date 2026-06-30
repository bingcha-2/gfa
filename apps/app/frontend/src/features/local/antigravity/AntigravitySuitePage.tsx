import { LocalProviderSuite } from '@/features/local/shared/LocalProviderSuite'
import { antigravityLocalApi } from '@/services/localApi'
import type { PageId } from '@/types'

/** 本地自有号 · Antigravity。账号管理 + 统计 + 保活 + 实例 + 数据(含默认实例运行时 + 切换历史)。接管模式切换在「接管中心」。 */
export function AntigravitySuitePage({ onNavigate }: { onNavigate?: (p: PageId) => void } = {}) {
  return <LocalProviderSuite title="Antigravity" api={antigravityLocalApi} onNavigate={onNavigate} hasData antigravityRuntime />
}
