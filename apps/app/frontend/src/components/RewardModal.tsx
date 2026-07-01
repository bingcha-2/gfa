import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import alipayQR from '@/assets/images/reward-alipay.jpg'

/** 赞赏作者:展示支付宝收款码整卡。纯本地展示,无金额、无后端。 */
export function RewardModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[320px]">
        <DialogHeader>
          <DialogTitle>赞赏作者</DialogTitle>
          <DialogDescription>开发不易,一杯咖啡加一份麦当劳薯条的鼓励。</DialogDescription>
        </DialogHeader>
        <img
          src={alipayQR}
          alt="支付宝收款码:托马斯小火车"
          className="w-full rounded-[12px] border border-[var(--border)]"
          draggable={false}
        />
      </DialogContent>
    </Dialog>
  )
}
