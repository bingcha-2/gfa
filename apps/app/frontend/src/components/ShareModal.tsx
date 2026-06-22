import { useEffect, useState } from 'react'
import { Gift, Copy, Check } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import * as api from '@/services/wails'
import type { ReferralInfo } from '@/services/wails'
import { useT } from '@/i18n'

/**
 * ShareModal — 分享/邀请弹窗:打开时拉 GetReferralInfo(POST /api/app/referral),
 * 展示我的邀请链接(可复制)+ 返佣余额 + 已邀请人数。与「激活码激活」同为账户下拉里的入口。
 */
export function ShareModal({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const t = useT()
  const [info, setInfo] = useState<ReferralInfo | null>(null)
  const [error, setError] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!open) return
    setInfo(null)
    setError(false)
    setCopied(false)
    api.getReferralInfo().then(setInfo).catch(() => setError(true))
  }, [open])

  async function copy() {
    if (!info) return
    try {
      await navigator.clipboard.writeText(info.referralLink)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard 不可用时静默 */
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Gift size={16} className="text-[var(--primary)]" />
            {t('share.title')}
          </DialogTitle>
          <DialogDescription>{t('share.desc')}</DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="text-[12px] text-[var(--danger)]">{t('share.loadFailed')}</p>
        ) : !info ? (
          <p className="text-[12px] text-[var(--text-muted)]">{t('share.loading')}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <div className="text-[11px] text-[var(--text-muted)]">{t('share.linkLabel')}</div>
              <div className="flex items-center gap-1.5">
                <Input readOnly value={info.referralLink} className="font-mono-data text-[12px]" />
                <Button variant="secondary" onClick={copy} className="shrink-0 gap-1">
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? t('share.copied') : t('share.copy')}
                </Button>
              </div>
            </div>
            <div className="flex items-center justify-between text-[12px] rounded-[10px] border border-[var(--border-light)] bg-[var(--bg-card)] px-3 py-2">
              <span className="text-[var(--text-muted)]">{t('share.credit')}</span>
              <span className="font-mono-data text-[var(--text-primary)]">¥{(info.creditCents / 100).toFixed(2)}</span>
            </div>
            <div className="flex items-center justify-between text-[12px] rounded-[10px] border border-[var(--border-light)] bg-[var(--bg-card)] px-3 py-2">
              <span className="text-[var(--text-muted)]">{t('share.invited')}</span>
              <span className="font-mono-data text-[var(--text-primary)]">{info.invitees.length}</span>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button onClick={onClose}>{t('share.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
