"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2Icon, XCircleIcon, RotateCcwIcon, XIcon, MailWarningIcon } from "lucide-react";

import { AccountButton, AccountSkeleton } from "./account-ui";
import { useAccount } from "./account-provider";
import { useOrderStatus } from "@/lib/account/use-order-status";
import { cancelBillingOrder, createCatalogOrder, UserApiError } from "@/lib/account/user-api";
import type { BillingOrderCreated } from "@/lib/account/user-types";
import type { Selection } from "@/lib/account/catalog-pricing";
import { formatCountdown, formatPriceCents } from "@/lib/account/format-extensions";
import { useDialogA11y } from "@/lib/account/use-dialog-a11y";
import { useDict } from "@/lib/i18n/client";

/**
 * Catalog-order QR flow — the §8 selection twin of OrderQrFlow.
 *
 * Identical state machine (create → QR → PAID/FAILED/EXPIRED) but POSTs a
 * `selection` to /billing/catalog-orders instead of a `planId`. Exported
 * separately so the machine is testable without dialog plumbing. 统一收银台:
 * 一个二维码,渠道(alipay/wxpay/bank)由用户在网关侧自选,前端不再预选。
 *
 * `onActiveChange` reports whether a still-payable order is on screen, so the
 * dialog can stop a stray backdrop click from throwing the QR away.
 */
export function CatalogOrderFlow({
  selection,
  onPaid,
  onRequestClose,
  onActiveChange,
}: {
  selection: Selection;
  onPaid?: () => void;
  onRequestClose?: () => void;
  onActiveChange?: (active: boolean) => void;
}) {
  const dict = useDict();
  const t = dict.portalApp.billing;

  // 余额池(挂载时快照):抵扣在后端下单时即扣减,再建单(切换开关)会作废旧单并回补,
  // 故任意时刻最多一笔有效单,可用余额恒等于此快照。下单成功后由 onPaid → refresh 更新。
  const { customer } = useAccount();
  const availableCredit = customer.creditCents;

  const [order, setOrder] = useState<BillingOrderCreated | null>(null);
  const [creditOn, setCreditOn] = useState(false);
  const [creating, setCreating] = useState(true);
  const [createError, setCreateError] = useState<string | null>(null);
  // 邮箱未验证(后端 EMAIL_NOT_VERIFIED)→ 专门引导,而非笼统「创建失败」。
  const [needsVerify, setNeedsVerify] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const paidHandled = useRef(false);

  const status = useOrderStatus(order?.outTradeNo ?? null);

  // selection 的内容签名 —— effect 用它去重,避免「对象引用每次渲染都变 → 反复下单」。
  const selectionKey = useMemo(() => JSON.stringify(selection), [selection]);
  // 已自动发起下单的 selectionKey:同 selection 只下一单,重复渲染不重发。
  const requestedRef = useRef<string | null>(null);
  // in-flight 闸:防并发重叠下单(StrictMode 双调 / 快速切换 / effect 抖动)。
  const creatingRef = useRef(false);

  const createOrder = useCallback(
    async (useCreditCents = 0) => {
      if (creatingRef.current) return; // 正在下单 → 忽略重复触发
      creatingRef.current = true;
      requestedRef.current = selectionKey;
      setCreating(true);
      setCreateError(null);
      setNeedsVerify(false);
      setOrder(null); // abandon previous order → polling stops
      try {
        const created = await createCatalogOrder(selection, undefined, useCreditCents);
        setOrder(created);
        setNow(Date.now());
      } catch (err) {
        if (err instanceof UserApiError && err.code === "EMAIL_NOT_VERIFIED") {
          setNeedsVerify(true);
        } else {
          setCreateError(
            err instanceof Error && err.message
              ? err.message
              : t.dialogCreateFailed
          );
        }
      } finally {
        setCreating(false);
        creatingRef.current = false;
      }
    },
    [selection, selectionKey, t.dialogCreateFailed]
  );

  // 用户主动取消当前未支付订单:调用后端置为 CANCELLED,成功即关闭弹窗(卸载停轮询)。
  const cancelOrder = useCallback(async () => {
    if (!order || cancelling) return;
    setCancelling(true);
    try {
      await cancelBillingOrder(order.outTradeNo);
      toast.success(t.cancelledToast);
      onRequestClose?.(); // 关闭弹窗即卸载组件 → 停轮询/倒计时
    } catch (err) {
      toast.error(
        err instanceof Error && err.message ? err.message : t.cancelFailed
      );
      setCancelling(false);
    }
  }, [order, cancelling, t.cancelledToast, t.cancelFailed, onRequestClose]);

  // 首次挂载时下单一次;同 selection 不重复下单 —— countdown ticker 每秒重渲染、或 selection
  // 引用抖动导致 effect 重跑,都被 requestedRef 拦掉。统一收银台:渠道由用户在网关侧自选,
  // 前端不再预选。手动「重试 / 重新生成」直接调 createOrder(不过 requestedRef),故仍可重新出码。
  useEffect(() => {
    if (requestedRef.current === selectionKey) return;
    void createOrder();
  }, [selectionKey, createOrder]);

  // 1s countdown ticker while an order is showing.
  useEffect(() => {
    if (!order) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [order]);

  // 全额余额抵扣单即时 PAID(无需轮询);普通单等轮询到 PAID。
  const isPaid = status?.status === "PAID" || order?.paid === true;

  // PAID → toast + refresh + auto-close (~2s). Fires exactly once.
  useEffect(() => {
    if (!isPaid || paidHandled.current) return;
    paidHandled.current = true;
    toast.success(t.paidToast);
    onPaid?.();
    const id = setTimeout(() => onRequestClose?.(), 2000);
    return () => clearTimeout(id);
  }, [isPaid, onPaid, onRequestClose, t.paidToast]);

  // 切换「使用余额抵扣」:重新下单(后端作废旧单并回补余额,故可来回切换)。
  const toggleCredit = useCallback(
    (next: boolean) => {
      setCreditOn(next);
      if (!order) return;
      const fullPrice = order.baseCents + order.creditAppliedCents;
      const apply = next ? Math.min(availableCredit, fullPrice) : 0;
      void createOrder(apply);
    },
    [order, availableCredit, createOrder],
  );

  const remainingMs = order ? new Date(order.expiresAt).getTime() - now : 0;

  // 有「进行中且仍可支付」的订单时,遮罩点击不应丢码;已支付/失败/过期都不算。
  const orderLive =
    !!order &&
    status?.status !== "PAID" &&
    status?.status !== "FAILED" &&
    status?.status !== "REFUNDED" &&
    status?.status !== "EXPIRED" &&
    remainingMs > 0;
  useEffect(() => {
    onActiveChange?.(orderLive);
  }, [orderLive, onActiveChange]);
  useEffect(() => () => onActiveChange?.(false), [onActiveChange]);

  // ── Terminal / transient views ──────────────────────────────────────────────

  if (isPaid) {
    // 全额余额抵扣单:文案点明「余额开通」,与扫码支付区分。
    const creditCovered = order?.paid === true && status?.status !== "PAID";
    return (
      <div className="account-order-flow account-order-flow--terminal">
        <CheckCircle2Icon />
        <div>{creditCovered ? t.creditPaidTitle : t.paidTitle}</div>
        <p>{creditCovered ? t.creditPaidDesc : t.paidDesc}</p>
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
        <AccountButton onClick={() => void createOrder()} disabled={creating}>
          {t.regenerate}
        </AccountButton>
      </div>
    );
  }

  // ── Active purchase view ────────────────────────────────────────────────────

  return (
    <div className="account-order-flow">
      {creating && (
        <div className="account-order-flow__loading">
          <AccountSkeleton className="account-skeleton--qr" />
          <p>{t.dialogCreating}</p>
        </div>
      )}

      {!creating && needsVerify && (
        <div className="account-order-flow account-order-flow--terminal">
          <MailWarningIcon />
          <div>{t.emailVerifyRequiredTitle}</div>
          <p>{t.emailVerifyRequiredDesc}</p>
          <a href="/account/me?tab=security" className="account-btn account-btn--primary">
            {t.goVerifyEmail}
          </a>
        </div>
      )}

      {!creating && !needsVerify && createError && (
        <div className="account-order-flow account-order-flow--terminal">
          <XCircleIcon />
          <div>{t.dialogCreateFailed}</div>
          <p>{createError}</p>
          <AccountButton variant="secondary" onClick={() => void createOrder()}>
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

          <p>{t.scanHint}</p>

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
          {order.creditAppliedCents > 0 && (
            <div className="account-order-flow__amount">
              <span>{t.creditAppliedLabel}</span>
              <strong>-{formatPriceCents(order.creditAppliedCents)}</strong>
            </div>
          )}
          <div className="account-order-flow__amount">
            <span>{t.amountLabel}</span>
            <strong>{formatPriceCents(order.amountCents)}</strong>
          </div>

          {availableCredit > 0 && (
            <label className="account-order-flow__credit">
              <input
                type="checkbox"
                checked={creditOn}
                disabled={creating}
                onChange={(e) => toggleCredit(e.target.checked)}
              />
              <span>
                {t.creditUseToggle}
                <em>
                  {" "}
                  ({t.creditBalanceLabel} {formatPriceCents(availableCredit)})
                </em>
              </span>
            </label>
          )}

          <p className="account-order-flow__safenote">{t.channelFeeNote}</p>

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

          <p className="account-order-flow__safenote">{t.securePayNote}</p>

          <button
            type="button"
            className="account-order-flow__cancel"
            onClick={() => void cancelOrder()}
            disabled={cancelling}
          >
            {cancelling ? t.cancelling : t.cancelOrder}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Scan-to-pay dialog for a catalog selection. Unmounts on close, which stops
 * all polling/countdown timers via effect cleanup. While an order is still
 * payable, a stray backdrop click is ignored (the ✕ button and Escape still
 * close) so the QR is never thrown away by accident.
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

  const panelRef = useRef<HTMLElement>(null);
  const [hasLiveOrder, setHasLiveOrder] = useState(false);
  const handleClose = useCallback(() => onOpenChange(false), [onOpenChange]);
  useDialogA11y(panelRef, open && !!selection, handleClose);

  if (!open || !selection) return null;

  return (
    <div className="account-dialog" role="presentation">
      <button
        type="button"
        className="account-dialog__backdrop"
        aria-label={t.closeDialog}
        onClick={() => {
          if (!hasLiveOrder) handleClose();
        }}
      />
      <section
        ref={panelRef}
        tabIndex={-1}
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
            aria-label={t.closeDialog}
            onClick={handleClose}
          >
            <XIcon size={16} />
          </button>
        </header>
        <CatalogOrderFlow
          selection={selection}
          onPaid={onPaid}
          onRequestClose={handleClose}
          onActiveChange={setHasLiveOrder}
        />
      </section>
    </div>
  );
}
