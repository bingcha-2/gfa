/**
 * 服务商品牌标识(Antigravity / Codex / Anthropic)。
 * 品牌 logo 自带各自颜色(codex 近黑、claude 橙、antigravity 渐变),为了在深浅两套
 * 主题下都看得清,统一放在一个白底圆角小片里。anthropic 用 claude.svg。
 */
import { cn } from '@/lib/utils'

export type Provider = 'antigravity' | 'codex' | 'anthropic'

const LOGO_SRC: Record<Provider, string> = {
  antigravity: '/logos/antigravity.svg',
  codex: '/logos/codex.svg',
  anthropic: '/logos/claude.svg',
}

export function ProviderLogo({ provider, size = 15, className }: { provider: string; size?: number; className?: string }) {
  const src = LOGO_SRC[provider as Provider]
  if (!src) return null
  const box = size + 9
  return (
    <span
      className={cn('inline-flex items-center justify-center rounded-[7px] border border-[var(--border-light)] bg-white shrink-0', className)}
      style={{ width: box, height: box }}
    >
      <img src={src} alt="" width={size} height={size} style={{ width: size, height: size, objectFit: 'contain' }} />
    </span>
  )
}
