"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2Icon, XCircleIcon, RotateCcwIcon } from "lucide-react";

import { AccountButton, AccountSkeleton } from "./account-ui";
import { useOrderStatus } from "@/lib/account/use-order-status";
import { createCatalogOrder } from "@/lib/account/user-api";
import type { BillingOrderCreated, PayChannel } from "@/lib/account/user-types";
import type { Selection } from "@/lib/account/catalog-pricing";
import { formatCountdown, formatPriceCents } from "@/lib/account/format-extensions";
import { fmt } from "@/lib/i18n";
import { useDict } from "@/lib/i18n/client";

/**
 * Catalog-order QR flow — the §8 selection twin of OrderQrFlow.
 *
 * Identical state machine (create → QR → PAID/FAILED/EXPIRED) but POSTs a
 * `selection` to /billing/catalog-orders instead of a `planId`. Exported
 * separately so the machine is testable without dialog plumbing. Switching
 * channel mid-flow abandons the old order and creates a new one.
 */
export function CatalogOrderFlow({
  selection,
  onPaid,
  onRequestClose,
}: {
  selection: Selection;
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
        const created = await createCatalogOrder(selection, ch);
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
    [selection, t.dialogCreateFailed]
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

  const remainingMs = order ? new Date(order.expiresAt).getTime() - now : 0;
  const channelLabel = channel === "ALIPAY" ? t.channelAlipay : t.channelWxpay;

  // ── Terminal / transient views ──────────────────────────────────────────────

  if (status?.status === "PAID") {
    return (
      <div className="account-order-flow account-order-flow--terminal">
        <CheckCircle2Icon />
        <div>{t.paidTitle}</div>
        <p>{t.paidDesc}</p>
      </div>
    );
  }

  if (status?.status === "FAILED" || status?.status === "REFUNDED") {
    const failed = status.status === "FAILED";
    return (
      <div className="account-order-flow account-order-flow--terminal">
        <XCircleIcon />
        <div>{failed ? t.failedTitle : t.refundedTitle}</div>
        <p>{failed ? t.failedDesc : t.refundedDesc}</p>
      </div>
    );
  }

  const expired = status?.status === "EXPIRED" || (!!order && remainingMs <= 0);

  if (expired) {
    return (
      <div className="account-order-flow account-order-flow--terminal">
        <RotateCcwIcon />
        <div>{t.expiredTitle}</div>
        <p>{t.expiredDesc}</p>
        <AccountButton onClick={() => void createOrder(channel)} disabled={creating}>
          {t.regenerate}
        </AccountButton>
      </div>
    );
  }

  // ── Active purchase view ────────────────────────────────────────────────────

  return (
    <div className="account-order-flow">
      <div className="account-pay-channel" role="group" aria-label="支付方式">
        {(["ALIPAY", "WXPAY"] as const).map((ch) => (
          <button
            key={ch}
            type="button"
            aria-pressed={channel === ch}
            disabled={creating}
            onClick={() => {
              if (ch !== channel) setChannel(ch);
            }}
          >
            {ch === "ALIPAY" ? t.channelAlipay : t.channelWxpay}
          </button>
        ))}
      </div>

      {creating && (
        <div className="account-order-flow__loading">
          <AccountSkeleton className="account-skeleton--qr" />
          <p>{t.dialogCreating}</p>
        </div>
      )}

      {!creating && createError && (
        <div className="account-order-flow account-order-flow--terminal">
          <XCircleIcon />
          <div>{t.dialogCreateFailed}</div>
          <p>{createError}</p>
          <AccountButton variant="secondary" onClick={() => void createOrder(channel)}>
            {t.retryCreate}
          </AccountButton>
        </div>
      )}

      {!creating && order && (
        <div className="account-order-flow__active">
          {/* qrDataUri is a backend-issued data:image/png — render directly */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={order.qrDataUri}
            alt={t.qrAlt}
            className="account-order-flow__qr"
          />

          <p>{fmt(t.scanHint, { channel: channelLabel })}</p>

          {order.feeCents > 0 && (
            <div className="account-order-flow__amount">
              <span>{t.baseLabel}</span>
              <strong>{formatPriceCents(order.baseCents)}</strong>
            </div>
          )}
          {order.feeCents > 0 && (
            <div className="account-order-flow__amount">
              <span>{t.feeLabel}</span>
              <strong>{formatPriceCents(order.feeCents)}</strong>
            </div>
          )}
          <div className="account-order-flow__amount">
            <span>{t.amountLabel}</span>
            <strong>{formatPriceCents(order.amountCents)}</strong>
          </div>

          <div className="account-order-flow__countdown">
            <span>{t.countdownLabel}</span>
            <strong>{formatCountdown(remainingMs)}</strong>
          </div>

          {/* 移动端无法扫码自己 — 提供直达支付链接;桌面端同样可用 */}
          <a
            href={order.payUrl}
            target="_blank"
            rel="noreferrer"
            className="account-link"
          >
            {t.openPayUrl}
          </a>
        </div>
      )}
    </div>
  );
}

/**
 * Scan-to-pay dialog for a catalog selection. Unmounts on close, which stops
 * all polling/countdown timers via effect cleanup.
 */
export function CatalogOrderDialog({
  selection,
  title,
  open,
  onOpenChange,
  onPaid,
}: {
  selection: Selection | null;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPaid?: () => void;
}) {
  const dict = useDict();
  const t = dict.portalApp.billing;

  if (!open || !selection) return null;

  return (
    <div className="account-dialog" role="presentation">
      <button
        type="button"
        className="account-dialog__backdrop"
        aria-label="关闭支付弹窗"
        onClick={() => onOpenChange(false)}
      />
      <section
        className="account-dialog__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-catalog-dialog-title"
      >
        <header className="account-dialog__header">
          <div>
            <h2 id="account-catalog-dialog-title">{t.dialogTitle}</h2>
            <p>{title}</p>
          </div>
          <button
            type="button"
            className="account-dialog__close"
            aria-label="关闭支付弹窗"
            onClick={() => onOpenChange(false)}
          >
            ✕
          </button>
        </header>
        <CatalogOrderFlow
          selection={selection}
          onPaid={onPaid}
          onRequestClose={() => onOpenChange(false)}
        />
      </section>
    </div>
  );
}
