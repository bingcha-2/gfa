import { useState } from 'react'
import { useAppStore } from '@/stores/useAppStore'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { t as tr } from '@/i18n'
import { Users, Copy, Check, Mail, Crown } from 'lucide-react'
import type { AccountSubscription, BoundAccountInfo } from '@/types'

// 产品展示元信息(顺序即展示顺序)。后端 product 用 antigravity/codex/anthropic,
// 与卡 products 轴一致;旧卡可能仍带 'claude',归一到 anthropic。
const PRODUCT_META: Record<string, { label: string; dot: string }> = {
  antigravity: { label: 'Antigravity', dot: 'bg-[var(--primary)]' },
  codex: { label: 'Codex', dot: 'bg-[var(--primary)]' },
  anthropic: { label: 'Anthropic', dot: 'bg-[var(--primary)]' },
}
const PRODUCT_ORDER = ['antigravity', 'codex', 'anthropic']

const normalizeProduct = (p: string) => (p === 'claude' ? 'anthropic' : p)

// 会员等级展示名(各产品词表不同):antigravity ultra/premium/…;codex plus/pro;anthropic max/pro。
const PLAN_LABEL: Record<string, string> = {
  ultra: 'Ultra', premium: 'Premium', standard: 'Standard',
  max: 'Max', pro: 'Pro', plus: 'Plus', team: 'Team', business: 'Business',
  free: 'Free',
}
function planLabel(plan: string): string {
  if (!plan) return ''
  const k = plan.toLowerCase()
  return PLAN_LABEL[k] || plan.charAt(0).toUpperCase() + plan.slice(1)
}
// 付费档 → 高亮,free → 灰,未知 → 默认。
function planTone(plan: string): 'success' | 'muted' | 'default' {
  const k = plan.toLowerCase()
  if (!k) return 'muted'
  if (k === 'free') return 'muted'
  return 'success'
}

function CopyButton({ value, title }: { value: string; title: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard 不可用时静默 */
    }
  }
  return (
    <Button size="sm" variant="ghost" onClick={onCopy} title={title} className="h-6 px-1.5">
      {copied ? <Check size={13} className="text-[var(--success)]" /> : <Copy size={13} />}
    </Button>
  )
}

function AccountRow({ acc, displayPlanType }: { acc: BoundAccountInfo; displayPlanType: string }) {
  const product = normalizeProduct(acc.product)
  const meta = PRODUCT_META[product] || { label: product, dot: 'bg-[var(--primary)]' }

  return (
    <div className="rounded-[10px] border border-[var(--border-light)] bg-[var(--bg-tertiary)] p-3 flex flex-col gap-2">
      {/* 产品 + 状态 */}
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--text-primary)]">
          <span className={cn('w-2 h-2 rounded-full', meta.dot)} />
          {meta.label}
        </span>
        <Badge variant={acc.accessToken ? 'success' : 'muted'}>{acc.accessToken ? '当前' : tr('bound.fetching')}</Badge>
      </div>

      {/* 账号邮箱 */}
      <div className="flex items-center justify-between text-[12px]">
        <span className="flex items-center gap-1 text-[var(--text-muted)]">
          <Mail size={12} /> {tr('bound.account')}
        </span>
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="font-mono-data text-[var(--text-secondary)] truncate max-w-[150px]">
            {acc.emailHint || '—'}
          </span>
          {acc.emailHint && <CopyButton value={acc.emailHint} title={tr('bound.copyAccount')} />}
        </span>
      </div>

      {/* 会员等级 */}
      <div className="flex items-center justify-between text-[12px]">
        <span className="flex items-center gap-1 text-[var(--text-muted)]">
          <Crown size={12} /> {tr('bound.planLevel')}
        </span>
        {displayPlanType ? (
          <Badge variant={planTone(displayPlanType)}>{planLabel(displayPlanType)}</Badge>
        ) : (
          <span className="font-mono-data text-[var(--text-muted)]">—</span>
        )}
      </div>
    </div>
  )
}

function purchasedLevelsByProduct(subscriptions: AccountSubscription[] | undefined): Map<string, string> {
  const out = new Map<string, string>()
  const sorted = [...(subscriptions ?? [])].sort((a, b) => a.priority - b.priority)
  for (const sub of sorted) {
    for (const [rawProduct, level] of Object.entries(sub.levels ?? {})) {
      const product = normalizeProduct(rawProduct)
      if (!out.has(product) && level.trim()) {
        out.set(product, level)
      }
    }
  }
  return out
}

/**
 * 最新 lease 实际服务账号。preferred-dynamic 可能换号,
 * 所以这里不承诺固定绑定账号。
 */
export function BoundAccountsCard() {
  const boundAccounts = useAppStore((s) => s.boundAccounts)
  const cardProducts = useAppStore((s) => s.cardProducts)
  const account = useAppStore((s) => s.account)
  const purchasedLevels = purchasedLevelsByProduct(account?.subscriptions)

  const products = (cardProducts && cardProducts.length > 0)
    ? cardProducts.map(normalizeProduct)
    : boundAccounts.map((a) => normalizeProduct(a.product))
  const byProduct = new Map(boundAccounts.map((a) => [normalizeProduct(a.product), a]))

  // 按卡绑定的产品顺序展示;未租到的产品给一个占位(获取中)。
  const rows = PRODUCT_ORDER.filter((p) => products.includes(p)).map((p) => {
    return (
      byProduct.get(p) ||
      ({ product: p, accountId: 0, emailHint: '', planType: '', accessToken: '', expiresAt: 0, leasedAt: 0 } as BoundAccountInfo)
    )
  })

  if (rows.length === 0) return null

  return (
    <Card>
      <CardHeader><CardTitle><Users size={15} /> 当前服务账号</CardTitle></CardHeader>
      <CardContent>
        <div
          className="grid gap-2.5 items-start"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}
        >
          {rows.map((acc) => (
            <AccountRow
              key={normalizeProduct(acc.product)}
              acc={acc}
              displayPlanType={purchasedLevels.get(normalizeProduct(acc.product)) || acc.planType}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
