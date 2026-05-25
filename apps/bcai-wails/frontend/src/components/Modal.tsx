import { useState, useCallback } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface ModalProps {
  open: boolean
  title: string
  message: string
  type?: 'alert' | 'confirm'
  onClose: (confirmed: boolean) => void
}

export function Modal({ open, title, message, type = 'alert', onClose }: ModalProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {type === 'confirm' && (
            <Button variant="secondary" onClick={() => onClose(false)}>取消</Button>
          )}
          <Button onClick={() => onClose(true)}>{type === 'confirm' ? '确认' : '我知道了'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function useModal() {
  const [state, setState] = useState<{ open: boolean; title: string; message: string; type: 'alert' | 'confirm'; resolve?: (v: boolean) => void }>({
    open: false, title: '', message: '', type: 'alert',
  })

  const showAlert = useCallback((title: string, message: string): Promise<boolean> => {
    return new Promise((resolve) => setState({ open: true, title, message, type: 'alert', resolve }))
  }, [])

  const showConfirm = useCallback((title: string, message: string): Promise<boolean> => {
    return new Promise((resolve) => setState({ open: true, title, message, type: 'confirm', resolve }))
  }, [])

  const handleClose = useCallback((confirmed: boolean) => {
    state.resolve?.(confirmed)
    setState((s) => ({ ...s, open: false }))
  }, [state.resolve])

  return {
    modalProps: { open: state.open, title: state.title, message: state.message, type: state.type, onClose: handleClose },
    showAlert,
    showConfirm,
  }
}
