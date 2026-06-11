"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2Icon, XCircleIcon, RotateCcwIcon } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrderStatus } from "@/hooks/use-order-status";
import { createBillingOrder } from "@/lib/user-api";
import type { BillingOrderCreated, PayChannel, Plan } from "@/lib/user-types";
import { formatCountdown, formatPriceCents } from "@/lib/format-extensions";
import { fmt } from "@/lib/i18n";
import { useDict } from "@/lib/i18n/client";

/**
 * Purchase flow content — exported separately so the state machine is
 * testable without dialog portal plumbing. Channel is chosen up front;
 * switching channel mid-flow creates a NEW order and abandons the old one.
 */
export function OrderQrFlow({
  plan,
  onPaid,
  onRequestClose,
}: {
  plan: Plan;
  onPaid?: () => void;
  onRequestClose?: () => void;
}) {
  const dict = useDict();
  const t = dict.portalApp.billing;

  const [channel, setChannel] = useState<PayChannel>("ALIPAY");
  const [order, setOrder] = useState<BillingOrderCreated | null>(null);
  const [creating, setCreating] = useState(true);
  const [createError, setCreateError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const paidHandled = useRef(false);

  const status = useOrderStatus(order?.outTradeNo ?? null);

  const createOrder = useCallback(
    async (ch: PayChannel) => {
      setCreating(true);
      setCreateError(null);
      setOrder(null); // abandon previous order → polling stops
      try {
        const created = await createBillingOrder(plan.id, ch);
        setOrder(created);
        setNow(Date.now());
      } catch (err) {
        setCreateError(
          err instanceof Error && err.message
            ? err.message
            : t.dialogCreateFailed
        );
      } finally {
        setCreating(false);
      }
    },
    [plan.id, t.dialogCreateFailed]
  );

  // Create on mount + whenever the channel changes.
  useEffect(() => {
    void createOrder(channel);
  }, [channel, createOrder]);

  // 1s countdown ticker while an order is showing.
  useEffect(() => {
    if (!order) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [order]);

  // PAID → toast + refresh + auto-close (~2s). Fires exactly once.
  useEffect(() => {
    if (status?.status !== "PAID" || paidHandled.current) return;
    paidHandled.current = true;
    toast.success(t.paidToast);
    onPaid?.();
    const id = setTimeout(() => onRequestClose?.(), 2000);
    return () => clearTimeout(id);
  }, [status?.status, onPaid, onRequestClose, t.paidToast]);

  const remainingMs = order
    ? new Date(order.expiresAt).getTime() - now
    : 0;

  const channelLabel =
    channel === "ALIPAY" ? t.channelAlipay : t.channelWxpay;

  // ── Terminal / transient views ──────────────────────────────────────────────

  if (status?.status === "PAID") {
    return (
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <CheckCircle2Icon className="size-10 text-emerald-600 dark:text-emerald-400" />
        <div className="text-base font-semibold">{t.paidTitle}</div>
        <p className="text-sm text-muted-foreground">{t.paidDesc}</p>
      </div>
    );
  }

  if (status?.status === "FAILED" || status?.status === "REFUNDED") {
    const failed = status.status === "FAILED";
    return (
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <XCircleIcon className="size-10 text-destructive" />
        <div className="text-base font-semibold">
          {failed ? t.failedTitle : t.refundedTitle}
        </div>
        <p className="text-sm text-muted-foreground">
          {failed ? t.failedDesc : t.refundedDesc}
        </p>
      </div>
    );
  }

  const expired =
    status?.status === "EXPIRED" || (!!order && remainingMs <= 0);

  if (expired) {
    return (
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <RotateCcwIcon className="size-10 text-muted-foreground" />
        <div className="text-base font-semibold">{t.expiredTitle}</div>
        <p className="text-sm text-muted-foreground">{t.expiredDesc}</p>
        <Button onClick={() => void createOrder(channel)} disabled={creating}>
          {t.regenerate}
        </Button>
      </div>
    );
  }

  // ── Active purchase view ────────────────────────────────────────────────────

  return (
    <div className="flex flex-col items-center gap-4">
      <ToggleGroup
        multiple={false}
        value={[channel]}
        onValueChange={(value) => {
          const next = value[0] as PayChannel | undefined;
          if (next && next !== channel) setChannel(next);
        }}
        variant="outline"
        disabled={creating}
      >
        <ToggleGroupItem value="ALIPAY">{t.channelAlipay}</ToggleGroupItem>
        <ToggleGroupItem value="WXPAY">{t.channelWxpay}</ToggleGroupItem>
      </ToggleGroup>

      {creating && (
        <div className="flex flex-col items-center gap-3 py-2">
          <Skeleton className="size-44 rounded-lg" />
          <p className="text-sm text-muted-foreground">{t.dialogCreating}</p>
        </div>
      )}

      {!creating && createError && (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <XCircleIcon className="size-8 text-destructive" />
          <div className="text-sm font-medium">{t.dialogCreateFailed}</div>
          <p className="text-xs text-muted-foreground break-all">
            {createError}
          </p>
          <Button
            variant="outline"
            onClick={() => void createOrder(channel)}
          >
            {t.retryCreate}
          </Button>
        </div>
      )}

      {!creating && order && (
        <>
          {/* qrDataUri is a backend-issued data:image/png — render directly */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={order.qrDataUri}
            alt={t.qrAlt}
            className="size-44 rounded-lg border bg-white p-1.5"
          />

          <p className="text-xs text-muted-foreground">
            {fmt(t.scanHint, { channel: channelLabel })}
          </p>

          <div className="flex items-baseline gap-2">
            <span className="text-xs text-muted-foreground">
              {t.amountLabel}
            </span>
            <span className="text-xl font-semibold tabular-nums">
              {formatPriceCents(order.amountCents)}
            </span>
          </div>

          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t.countdownLabel}</span>
            <span className="font-mono tabular-nums font-medium">
              {formatCountdown(remainingMs)}
            </span>
          </div>

          {/* 移动端无法扫码自己 — 提供直达支付链接;桌面端同样可用 */}
          <a
            href={order.payUrl}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-accent underline-offset-4 transition-colors duration-200 hover:underline"
          >
            {t.openPayUrl}
          </a>
        </>
      )}
    </div>
  );
}

/**
 * Scan-to-pay dialog. The flow unmounts whenever the dialog closes,
 * which stops all polling/countdown timers via effect cleanup.
 */
export function OrderQrDialog({
  plan,
  open,
  onOpenChange,
  onPaid,
}: {
  plan: Plan | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPaid?: () => void;
}) {
  const dict = useDict();
  const t = dict.portalApp.billing;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.dialogTitle}</DialogTitle>
          {plan && <DialogDescription>{plan.name}</DialogDescription>}
        </DialogHeader>
        {open && plan && (
          <OrderQrFlow
            plan={plan}
            onPaid={onPaid}
            onRequestClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
