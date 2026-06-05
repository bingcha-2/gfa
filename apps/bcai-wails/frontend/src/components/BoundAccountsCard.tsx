import { useState } from 'react'
import { useAppStore } from '@/stores/useAppStore'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { Users, Copy, Check, Mail, Crown } from 'lucide-react'
import type { BoundAccountInfo } from '@/types'

// 产品展示元信息(顺序即展示顺序)。后端 product 用 antigravity/codex/anthropic,
// 与卡 products 轴一致;旧卡可能仍带 'claude',归一到 anthropic。
const PRODUCT_META: Record<string, { label: string; dot: string }> = {
  antigravity: { label: 'Antigravity', dot: 'bg-[var(--accent)]' },
  codex: { label: 'Codex', dot: 'bg-emerald-500' },
  anthropic: { label: 'Anthropic', dot: 'bg-purple-500' },
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

/** token 过期时间 → "有效至 HH:MM:SS",无法解析则空。 */
function formatExpiry(ms: number): string {
  if (!ms || ms <= 0) return ''
  const d = new Date(ms)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('zh-CN', { hour12: false })
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

function AccountRow({ acc }: { acc: BoundAccountInfo }) {
  const product = normalizeProduct(acc.product)
  const meta = PRODUCT_META[product] || { label: product, dot: 'bg-[var(--primary)]' }
  const expiry = formatExpiry(acc.expiresAt)

  return (
    <div className="rounded-[8px] border border-[var(--border-light)] bg-[var(--bg-card)] p-3 flex flex-col gap-2">
      {/* 产品 + 状态 */}
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--text-primary)]">
          <span className={cn('w-2 h-2 rounded-full', meta.dot)} />
          {meta.label}
        </span>
        <Badge variant={acc.accessToken ? 'success' : 'muted'}>{acc.accessToken ? '已绑定' : '获取中'}</Badge>
      </div>

      {/* 账号邮箱 */}
      <div className="flex items-center justify-between text-[12px]">
        <span className="flex items-center gap-1 text-[var(--text-muted)]">
          <Mail size={12} /> 账号
        </span>
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="font-mono-data text-[var(--text-secondary)] truncate max-w-[150px]">
            {acc.emailHint || '—'}
          </span>
          {acc.emailHint && <CopyButton value={acc.emailHint} title="复制账号" />}
        </span>
      </div>

      {/* 会员等级 */}
      <div className="flex items-center justify-between text-[12px]">
        <span className="flex items-center gap-1 text-[var(--text-muted)]">
          <Crown size={12} /> 会员等级
        </span>
        {acc.planType ? (
          <Badge variant={planTone(acc.planType)}>{planLabel(acc.planType)}</Badge>
        ) : (
          <span className="font-mono-data text-[var(--text-muted)]">—</span>
        )}
      </div>

      {/* 令牌状态 —— 出于安全,绝不展示/复制真实 token,仅显示是否已下发 + 脱敏串 */}
      <div className="flex items-center justify-between text-[12px]">
        <span className="text-[var(--text-muted)]">Access Token</span>
        <span className="flex items-center gap-1.5 min-w-0">
          {acc.accessToken ? (
            <code className="text-[11px] font-mono-data text-[var(--text-muted)] truncate max-w-[150px] select-none">
              {acc.accessToken}
            </code>
          ) : (
            <span className="text-[var(--text-muted)]">获取中…</span>
          )}
          {expiry && <span className="text-[10px] text-[var(--text-muted)] font-mono-data shrink-0">· 有效至 {expiry}</span>}
        </span>
      </div>
    </div>
  )
}

/**
 * 绑定卡每个产品当前租到的账号信息 + token。仅对绑定卡(有 products)显示。
 * 池子卡每次请求轮换账号,展示「绑定账号」无意义,故隐藏。
 */
export function BoundAccountsCard() {
  const boundAccounts = useAppStore((s) => s.boundAccounts)
  const cardProducts = useAppStore((s) => s.cardProducts)

  // 池子卡(无 products)→ 不展示绑定账号面板。
  if (!cardProducts || cardProducts.length === 0) return null

  const products = cardProducts.map(normalizeProduct)
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
      <CardHeader><CardTitle><Users size={15} /> 绑定账号信息</CardTitle></CardHeader>
      <CardContent>
        <div className="flex flex-col gap-2.5">
          {rows.map((acc) => (
            <AccountRow key={normalizeProduct(acc.product)} acc={acc} />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
