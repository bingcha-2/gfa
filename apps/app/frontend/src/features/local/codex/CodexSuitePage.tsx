import { LocalProviderSuite } from '@/features/local/shared/LocalProviderSuite'
import { codexLocalApi } from '@/services/localApi'
import type { PageId } from '@/types'

/** 本地自有号 · Codex。账号管理 + 反代 + 供应商 + 统计 + 保活 + 实例。接管模式切换在「接管中心」。 */
export function CodexSuitePage({ onNavigate }: { onNavigate?: (p: PageId) => void } = {}) {
  return <LocalProviderSuite title="Codex" api={codexLocalApi} onNavigate={onNavigate} hasGateway hasModelProviders hasSettings />
}
