import { LocalProviderSuite } from '@/features/local/shared/LocalProviderSuite'
import { antigravityLocalApi } from '@/services/localApi'

/** 本地自有号 · Antigravity。账号管理 + 网关 + 统计(接管号源切换待 IDE 注入接入)。 */
export function AntigravitySuitePage() {
  return <LocalProviderSuite title="Antigravity" api={antigravityLocalApi} />
}
