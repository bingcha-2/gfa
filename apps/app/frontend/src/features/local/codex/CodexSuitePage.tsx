import { LocalProviderSuite } from '@/features/local/shared/LocalProviderSuite'
import { codexLocalApi } from '@/services/localApi'

/** 本地自有号 · Codex。账号管理 + 网关 + 统计 + 接管号源切换(codex 支持)。 */
export function CodexSuitePage() {
  return <LocalProviderSuite title="Codex" api={codexLocalApi} supportsSource />
}
