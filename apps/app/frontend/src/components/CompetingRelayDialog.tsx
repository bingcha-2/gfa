import { useState, useCallback } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import type { ClaudeConfigConflict } from '@/services/wails'

/**
 * 接管前的「第三方中转封号免责」弹窗。检测到 cc-switch / 别家中转地址等非 GFA 的中转配置时弹出。
 * 规则（方案 §5.1）：cc-switch 置顶点名；「我已知晓」不勾选则「清理」按钮禁用。
 * 三种结果：clean（已知晓→清理并接管）/ skip（仍要接管，不清理）/ cancel（取消，什么都不做）。
 */

export type RelayDecision = 'clean' | 'skip' | 'cancel'

// useCompetingRelayGate 以 Promise 形式驱动弹窗：confirmSanitize(conflicts) 打开弹窗，用户点选后 resolve。
export function useCompetingRelayGate() {
  const [state, setState] = useState<{
    open: boolean
    conflicts: ClaudeConfigConflict[]
    resolve?: (d: RelayDecision) => void
  }>({ open: false, conflicts: [] })

  const confirmSanitize = useCallback((conflicts: ClaudeConfigConflict[]): Promise<RelayDecision> => {
    return new Promise((resolve) => setState({ open: true, conflicts, resolve }))
  }, [])

  const onDecide = useCallback((d: RelayDecision) => {
    state.resolve?.(d)
    setState((s) => ({ ...s, open: false }))
  }, [state.resolve])

  return { confirmSanitize, dialogProps: { open: state.open, conflicts: state.conflicts, onDecide } }
}

export function CompetingRelayDialog({
  open,
  conflicts,
  onDecide,
}: {
  open: boolean
  conflicts: ClaudeConfigConflict[]
  onDecide: (d: RelayDecision) => void
}) {
  const t = useT()
  const [ack, setAck] = useState(false)

  const hasCcSwitch = conflicts.some((c) => c.kind === 'cc-switch')
  const others = conflicts.filter((c) => c.kind !== 'cc-switch')

  // 关闭前重置勾选，避免下次打开残留已勾状态。
  const close = (d: RelayDecision) => {
    setAck(false)
    onDecide(d)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close('cancel')}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('takeover.sanitize.title')}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-[13px] text-[var(--text-secondary)]">
          {hasCcSwitch && (
            <div className="rounded-[8px] border border-[var(--danger)] bg-[var(--danger-bg,rgba(220,38,38,0.06))] px-3 py-2 text-[12px]">
              <span className="font-semibold text-[var(--danger)]">{t('takeover.sanitize.ccSwitchLead')}</span>
            </div>
          )}

          <div>{t('takeover.sanitize.intro')}</div>

          {others.length > 0 && (
            <ul className="flex flex-col gap-1 text-[12px] text-[var(--text-muted)]">
              {others.map((c) => (
                <li key={c.id} className="font-mono-data break-all">
                  · {c.detail}
                </li>
              ))}
            </ul>
          )}

          <div className="font-medium text-[var(--danger)]">{t('takeover.sanitize.disclaimer')}</div>

          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-[var(--text-primary)]">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            {t('takeover.sanitize.ack')}
          </label>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => close('skip')}>
            {t('takeover.sanitize.skipBtn')}
          </Button>
          <Button disabled={!ack} onClick={() => close('clean')} className="disabled:opacity-40">
            {t('takeover.sanitize.cleanBtn')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
