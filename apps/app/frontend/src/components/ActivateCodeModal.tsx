import { useState } from 'react'
import { KeyRound, CheckCircle2 } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import * as api from '@/services/wails'
import type { ActivateCodeResult } from '@/services/wails'
import { formatDate } from '@/lib/utils'
import { productLabel } from '@/lib/usageBars'
import { useT } from '@/i18n'

/**
 * ActivateCodeModal — 激活码兑换弹窗:输入激活码 → 调 Go 侧 ActivateCode(同一套
 * customer JWT,POST /account/activate-code)开通一条独立订阅。成功后回调 onActivated
 * (调用方心跳刷新本地多订阅快照,让新订阅立即出现),并在原地展示订阅摘要。
 *
 * 错误码透传:Go 把后端可读码透传为 "CODE_X: 消息",这里按码映射本地化文案;
 * 未识别(座位不足/目录非法等)→ 展示后端原始消息;再兜底 fallback。
 */
const KNOWN_ERROR_CODES = ['CODE_NOT_FOUND', 'CODE_DISABLED', 'CODE_ALREADY_USED', 'CODE_REQUIRED'] as const

export function ActivateCodeModal({
  open,
  onClose,
  onActivated,
}: {
  open: boolean
  onClose: () => void
  onActivated?: () => void
}) {
  const t = useT()
  const [code, setCode] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ActivateCodeResult | null>(null)

  function reset() {
    setCode('')
    setError(null)
    setResult(null)
    setPending(false)
  }

  function handleOpenChange(next: boolean) {
    if (next || pending) return
    reset()
    onClose()
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (pending) return
    const trimmed = code.trim()
    if (!trimmed) return
    setPending(true)
    setError(null)
    setResult(null)
    try {
      const res = await api.activateCode(trimmed)
      setResult(res)
      if (!res.alreadyActivated) onActivated?.()
    } catch (err) {
      const msg = String((err as { message?: string } | undefined)?.message ?? err ?? '')
      const hit = KNOWN_ERROR_CODES.find((c) => msg.includes(c))
      if (hit) {
        setError(t(`activate.errors.${hit}`))
      } else if (msg) {
        // 座位不足 / 目录非法等带可读信息的后端错误:去掉可能的 "CODE: " 前缀后直接展示。
        setError(msg.replace(/^[A-Z_]+:\s*/, '') || t('activate.errors.fallback'))
      } else {
        setError(t('activate.errors.fallback'))
      }
    } finally {
      setPending(false)
    }
  }

  const sub = result?.subscription

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound size={16} className="text-[var(--primary)]" />
            {t('activate.title')}
          </DialogTitle>
          <DialogDescription>{t('activate.desc')}</DialogDescription>
        </DialogHeader>

        {result && sub ? (
          <div className="rounded-[12px] border border-[var(--border-light)] bg-[var(--bg-card)] p-4">
            <div className="flex items-center gap-2 text-[14px] font-semibold text-[var(--text-primary)]">
              <CheckCircle2 size={16} className="text-[var(--success)]" />
              {result.alreadyActivated ? t('activate.alreadyTitle') : t('activate.successTitle')}
            </div>
            {sub.products.length > 0 && (
              <div className="mt-3">
                <div className="text-[11px] text-[var(--text-muted)] mb-1.5">{t('activate.products')}</div>
                <div className="flex flex-wrap gap-1.5">
                  {sub.products.map((p) => (
                    <span
                      key={p}
                      className="px-2 py-0.5 rounded-[6px] text-[11px] font-medium bg-[var(--primary-light)] text-[var(--primary)]"
                    >
                      {productLabel(p)}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-3 flex items-center justify-between text-[12px]">
              <span className="text-[var(--text-muted)]">{t('activate.expires')}</span>
              <span className="font-mono-data text-[var(--text-primary)]">
                {sub.expiresAt && sub.expiresAt !== 'null'
                  ? formatDate(sub.expiresAt)
                  : t('account.neverExpires')}
              </span>
            </div>
            <div className="mt-1.5 flex items-center justify-between text-[12px]">
              <span className="text-[var(--text-muted)]">{t('activate.deviceLimit')}</span>
              <span className="font-mono-data text-[var(--text-primary)]">
                {t('activate.deviceLimitValue', { n: sub.deviceLimit })}
              </span>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-2.5">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t('activate.placeholder')}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              className="font-mono-data"
            />
            {error && <p className="text-[12px] text-[var(--danger)]">{error}</p>}
          </form>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={() => handleOpenChange(false)}>{t('activate.close')}</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => handleOpenChange(false)} disabled={pending}>
                {t('activate.cancel')}
              </Button>
              <Button onClick={handleSubmit} disabled={pending || !code.trim()}>
                {pending ? t('activate.submitting') : t('activate.submit')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
