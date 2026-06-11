import { useState, useCallback } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'

interface ModalProps {
  open: boolean
  title: string
  message: string
  type?: 'alert' | 'confirm'
  confirmLabel?: string
  cancelLabel?: string
  onClose: (confirmed: boolean) => void
}

export function Modal({ open, title, message, type = 'alert', confirmLabel, cancelLabel, onClose }: ModalProps) {
  const t = useT()
  const okLabel = confirmLabel ?? (type === 'confirm' ? t('modal.confirm') : t('modal.gotIt'))
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="whitespace-pre-line">{message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {type === 'confirm' && (
            <Button variant="secondary" onClick={() => onClose(false)}>{cancelLabel ?? t('modal.cancel')}</Button>
          )}
          <Button onClick={() => onClose(true)}>{okLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface ConfirmOpts {
  confirmLabel?: string
  cancelLabel?: string
}

export function useModal() {
  const [state, setState] = useState<{ open: boolean; title: string; message: string; type: 'alert' | 'confirm'; confirmLabel?: string; cancelLabel?: string; resolve?: (v: boolean) => void }>({
    open: false, title: '', message: '', type: 'alert',
  })

  const showAlert = useCallback((title: string, message: string): Promise<boolean> => {
    return new Promise((resolve) => setState({ open: true, title, message, type: 'alert', resolve }))
  }, [])

  const showConfirm = useCallback((title: string, message: string, opts?: ConfirmOpts): Promise<boolean> => {
    return new Promise((resolve) => setState({ open: true, title, message, type: 'confirm', confirmLabel: opts?.confirmLabel, cancelLabel: opts?.cancelLabel, resolve }))
  }, [])

  const handleClose = useCallback((confirmed: boolean) => {
    state.resolve?.(confirmed)
    setState((s) => ({ ...s, open: false }))
  }, [state.resolve])

  return {
    modalProps: { open: state.open, title: state.title, message: state.message, type: state.type, confirmLabel: state.confirmLabel, cancelLabel: state.cancelLabel, onClose: handleClose },
    showAlert,
    showConfirm,
  }
}
