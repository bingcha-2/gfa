import { useAppStore } from '@/stores/useAppStore'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/Modal'
import { LoadingOverlay } from '@/components/LoadingOverlay'
import { ProviderLogo } from '@/components/ProviderLogo'
import { isMacPlatform, isWindowsPlatform } from '@/lib/platform'
import { useRemoteTakeover } from './useRemoteTakeover'
import type { PageId } from '@/types'

export function TakeoverCenterPage(_props: { onNavigate?: (p: PageId) => void } = {}) {
  const tk = useRemoteTakeover()
  const products = useAppStore(s => s.ideProducts)
  const account = useAppStore(s => s.account)
  const targets = [
    { id: 'claude_code', target: 'claude', name: 'Claude Code', provider: 'claude', note: '终端与 VS Code' },
    ...((isMacPlatform() || isWindowsPlatform()) ? [{ id: 'claude_desktop', target: 'claude_desktop', name: 'Claude Desktop', provider: 'claude', note: '桌面客户端' }] : []),
    { id: 'codex', target: 'codex', name: 'Codex', provider: 'codex', note: '终端与桌面客户端' },
    { id: 'antigravity_ide', target: 'ide', name: 'Antigravity IDE', provider: 'antigravity', note: '' },
    { id: 'antigravity_hub', target: 'hub', name: 'Antigravity Hub', provider: 'antigravity', note: '' },
  ]
  const toggle = async (target: typeof targets[number], injected: boolean) => {
    if (!injected && target.target === 'claude_desktop' && !(await tk.confirmDesktopTakeover())) return
    if (!injected && !(await tk.ensureCard(target.name))) return
    await tk.runTakeover(target.target, !injected)
  }
  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 pt-3">
      <div>
        <h2 className="text-[20px] font-semibold text-[var(--text-primary)]">连接你的客户端</h2>
        <p className="mt-1 text-[12px] text-[var(--text-secondary)]">选择要使用的客户端，点击接管。</p>
      </div>
      <div className="overflow-hidden rounded-xl border border-[var(--border-light)] bg-[var(--bg-card)] divide-y divide-[var(--border-light)]">
      {targets.map(target => {
        const product = products.find(p => p.id === target.id)
        const injected = !!product?.injected
        const entitlement = target.provider === 'claude' ? 'anthropic' : target.provider
        const subscribed = account?.subscriptions?.some(sub => sub.status.toUpperCase() === 'ACTIVE' && (!sub.expiresAt || Date.parse(sub.expiresAt) > Date.now()) && sub.products.includes(entitlement))
        const unavailable = account != null && !subscribed
        return <section key={target.id} aria-label={target.name} className="flex flex-wrap items-center gap-4 px-5 py-5">
          <ProviderLogo provider={target.provider} size={28} />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">{target.name}</h2>
            {target.note && <p className="mt-1 text-xs text-[var(--text-muted)]">{target.note}</p>}
            <p className="mt-1 text-xs text-[var(--text-secondary)]">{!product ? '正在检测客户端…' : injected ? '已接管' : product.detected ? '待接管' : '未安装 / 未检测到'}</p>
          </div>
          <div className="min-w-[120px] text-xs leading-6">
            <p className={unavailable || account == null ? 'text-[var(--text-muted)]' : 'text-[var(--success-strong)]'}>{account == null ? '订阅待确认' : subscribed ? '订阅有效' : '未订阅此产品'}</p>
          </div>
          <Button title={unavailable && !injected ? '需要有效的产品订阅才能接管' : undefined} disabled={tk.busy !== null || (!injected && (unavailable || !product?.detected))} variant={injected ? 'secondary' : 'default'} onClick={() => void toggle(target, injected)}>
            {injected ? '停止' : '接管'}
          </Button>
        </section>
      })}
      </div>
      {tk.busy && <LoadingOverlay show label={tk.busyLabel} />}
      <Modal {...tk.modalProps} />
    </div>
  )
}
