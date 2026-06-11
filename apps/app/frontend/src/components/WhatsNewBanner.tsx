import { useState } from 'react'
import { useAppStore } from '@/stores/useAppStore'
import { Button } from '@/components/ui/button'
import { PartyPopper } from 'lucide-react'
import { useT } from '@/i18n'
import { getChangelogRecord, markChangelogSeen } from '@/lib/changelog'
import { ChangelogBody } from '@/components/ChangelogBody'

/**
 * 「更新完成」横幅:上个版本里记下的新版更新内容,在重启进入对应版本后
 * 展示一次(点「知道了」后不再弹;设置 → 关于仍可随时回看)。
 */
export function WhatsNewBanner() {
  const t = useT()
  const appVersion = useAppStore((s) => s.appVersion)
  const [dismissed, setDismissed] = useState(false)

  if (dismissed) return null
  const rec = getChangelogRecord()
  // 只在「记录的版本 == 当前运行版本」时展示 —— 即刚完成这次更新。
  if (!rec || rec.seen || rec.version !== appVersion) return null

  return (
    <div className="px-4 py-2.5 mb-4 rounded-[12px] border border-[color-mix(in_srgb,var(--primary)_30%,var(--border))] bg-[color-mix(in_srgb,var(--primary)_6%,var(--bg-secondary))] shadow-[var(--shadow-sm)]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[13px]">
          <PartyPopper size={15} className="text-[var(--primary)]" />
          <span className="text-[var(--text-primary)] font-medium">{t('update.updatedTo', { version: rec.version })}</span>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => { markChangelogSeen(); setDismissed(true) }}
        >
          {t('update.dismiss')}
        </Button>
      </div>
      <div className="mt-2 pt-2 border-t border-[var(--border-light)]">
        <div className="text-[11px] font-semibold text-[var(--text-secondary)] mb-1">{t('update.changelogTitle')}</div>
        <ChangelogBody text={rec.changelog} className="text-[12px] leading-relaxed text-[var(--text-secondary)] max-h-[120px] overflow-y-auto" />
      </div>
    </div>
  )
}
