"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowRightIcon,
  CreditCardIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  PackageCheckIcon,
  ReceiptTextIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SparklesIcon,
  XCircleIcon,
} from "lucide-react";

import { AccountButton, AccountPill, AccountSkeleton } from "./account-ui";
import { AccountStatusBadge } from "./account-status-badge";
import { BindCardForm } from "./bind-card-form";
import { DataPagination } from "./data-pagination";
import type {
  BillingOrderRecord,
  OrderStatus,
  Plan,
  Subscription,
} from "@/lib/account/user-types";
import { formatDateTime } from "@/lib/format";
import { formatPriceCents } from "@/lib/account/format-extensions";
import { isSubscriptionActive } from "@/lib/account/subscription-status";
import { fmt } from "@/lib/i18n";
import { useDict } from "@/lib/i18n/client";

const PAGE_SIZE = 10;

function orderStatusTone(status: OrderStatus) {
  switch (status) {
    case "PAID":
      return "success";
    case "PENDING":
      return "warning";
    case "FAILED":
      return "destructive";
    case "EXPIRED":
    case "REFUNDED":
    case "CANCELLED":
    default:
      return "muted";
  }
}

function bestSubscription(subscriptions: Subscription[] | null): Subscription | null {
  if (!subscriptions || subscriptions.length === 0) return null;
  return [...subscriptions].sort((a, z) => {
    const aActive = a.status.toUpperCase() === "ACTIVE" ? 1 : 0;
    const zActive = z.status.toUpperCase() === "ACTIVE" ? 1 : 0;
    if (aActive !== zActive) return zActive - aActive;
    const aExpiry = a.expiresAt ? new Date(a.expiresAt).getTime() : Number.MAX_SAFE_INTEGER;
    const zExpiry = z.expiresAt ? new Date(z.expiresAt).getTime() : Number.MAX_SAFE_INTEGER;
    return zExpiry - aExpiry;
  })[0];
}

function productList(products: string[], autoLabel: string) {
  return products.length > 0 ? products.join(" / ") : autoLabel;
}

function SyncOrderButton({
  outTradeNo,
  onSync,
  labels,
}: {
  outTradeNo: string;
  onSync: (outTradeNo: string) => Promise<void>;
  labels: { syncing: string; syncStatus: string };
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="account-order-sync"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try { await onSync(outTradeNo); } finally { setBusy(false); }
      }}
    >
      {busy
        ? <><LoaderCircleIcon className="account-order-sync__icon account-order-sync__icon--spin" />{labels.syncing}</>
        : <><RefreshCwIcon className="account-order-sync__icon" />{labels.syncStatus}</>}
    </button>
  );
}

function CancelOrderButton({
  outTradeNo,
  onCancel,
  labels,
}: {
  outTradeNo: string;
  onCancel: (outTradeNo: string) => Promise<void>;
  labels: { cancel: string; cancelling: string; confirm: string };
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="account-order-cancel"
      disabled={busy}
      onClick={async () => {
        if (!window.confirm(labels.confirm)) return;
        setBusy(true);
        try { await onCancel(outTradeNo); } finally { setBusy(false); }
      }}
    >
      {busy
        ? <><LoaderCircleIcon className="account-order-sync__icon account-order-sync__icon--spin" />{labels.cancelling}</>
        : <><XCircleIcon className="account-order-sync__icon" />{labels.cancel}</>}
    </button>
  );
}

function RefundOrderButton({
  outTradeNo,
  onRefund,
  labels,
}: {
  outTradeNo: string;
  onRefund: (outTradeNo: string) => Promise<void>;
  labels: { refund: string; refunding: string; confirm: string };
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="account-order-cancel"
      disabled={busy}
      onClick={async () => {
        if (!window.confirm(labels.confirm)) return;
        setBusy(true);
        try { await onRefund(outTradeNo); } finally { setBusy(false); }
      }}
    >
      {busy
        ? <><LoaderCircleIcon className="account-order-sync__icon account-order-sync__icon--spin" />{labels.refunding}</>
        : <><RotateCcwIcon className="account-order-sync__icon" />{labels.refund}</>}
    </button>
  );
}

export function AccountBillingCenter({
  subscriptions,
  plans,
  orders,
  page,
  totalPages,
  loadError,
  onBound,
  onPage,
  onPurchase,
  onSyncOrder,
  onCancelOrder,
  onRefundOrder,
}: {
  subscriptions: Subscription[] | null;
  /**
   * Legacy plan list. Omit entirely (catalog-only mode) to render just the
   * catalog entry link — the sole purchase path now that plan-based orders
   * are gone. Pass an array only for the legacy plan-card grid.
   */
  plans?: Plan[] | null;
  orders: { orders: BillingOrderRecord[]; total: number } | null;
  page: number;
  totalPages: number;
  loadError: boolean;
  onBound: () => void;
  onPage: (page: number) => void;
  onPurchase?: (plan: Plan) => void;
  onSyncOrder?: (outTradeNo: string) => Promise<void>;
  onCancelOrder?: (outTradeNo: string) => Promise<void>;
  onRefundOrder?: (outTradeNo: string) => Promise<void>;
}) {
  const dict = useDict();
  const b = dict.portalApp.billing;
  const subStatus = dict.portalApp.subscriptions;
  // 迁移卡密订阅 only for genuinely card-migrated subs; otherwise the plan's own
  // name. planName here is products.join("+"), so "null ⇒ migrated" would mislabel
  // a migrated sub that carries products as just its products.
  const planLabel = (s: Subscription) =>
    s.migratedFromCard ? b.migratedPlanName : s.planName ?? b.migratedPlanName;
  const current = bestSubscription(subscriptions);
  // In catalog-only mode (no `plans` prop) the plan grid is absent, so it never
  // gates the loading state — only subscriptions + orders do.
  const catalogOnly = plans === undefined;
  const isLoading =
    subscriptions === null ||
    (!catalogOnly && plans === null) ||
    orders === null;
  const orderCount = orders?.total ?? 0;

  return (
    <div className="account-billing" data-testid="account-billing-center">
      <section className="account-billing-hero">
        <div>
          <AccountPill tone={loadError ? "warning" : current ? "success" : "brand"}>
            {loadError
              ? b.loadFailed
              : isLoading
                ? b.heroSyncing
                : current
                  ? b.heroConnected
                  : b.heroWaiting}
          </AccountPill>
          <h2>{b.centerTitle}</h2>
          <p>{b.centerDesc}</p>
        </div>
        <div className="account-billing-hero__status account-summary-strip">
          <div>
            <span>{b.heroCurrentLabel}</span>
            <strong>{current ? planLabel(current) : b.heroNoPlan}</strong>
          </div>
          <div>
            <span>{b.heroOrdersLabel}</span>
            <strong>{fmt(b.heroOrdersValue, { n: orderCount })}</strong>
          </div>
        </div>
      </section>

      <div className="account-billing__grid account-workflow-grid">
        <section className="account-billing-panel account-billing-panel--wide">
          <div className="account-billing-panel__header">
            <div>
              <p>{b.currentSection}</p>
              <h3>{current ? planLabel(current) : b.currentEmpty}</h3>
            </div>
            <PackageCheckIcon />
          </div>

          {subscriptions === null ? (
            <AccountSkeleton className="account-skeleton--billing" />
          ) : subscriptions.length === 0 ? (
            <p className="account-billing-empty">{b.currentEmptyDesc}</p>
          ) : (
            <div className="account-subscription-stack">
              {subscriptions.map((sub) => (
                <article className="account-subscription-card" key={sub.id}>
                  <div>
                    <strong>{planLabel(sub)}</strong>
                    <span>{productList(sub.products, b.autoProvision)}</span>
                  </div>
                  <div>
                    <span>{b.expiresLabel}</span>
                    <strong>
                      {sub.expiresAt ? formatDateTime(sub.expiresAt) : b.neverExpires}
                    </strong>
                  </div>
                  <div>
                    <span>{b.deviceLimitLabel}</span>
                    <strong>{fmt(b.deviceLimitValue, { n: sub.deviceLimit })}</strong>
                  </div>
                  {(() => {
                    const active = isSubscriptionActive(sub, Date.now());
                    const cancelled = sub.status.toUpperCase() === "CANCELLED";
                    return (
                      <AccountStatusBadge tone={active ? "success" : "muted"}>
                        {cancelled
                          ? subStatus.statusCancelled
                          : active
                            ? subStatus.statusActive
                            : subStatus.statusExpired}
                      </AccountStatusBadge>
                    );
                  })()}
                  <AccountPill tone={sub.weight >= 8 ? "brand" : "info"}>
                    {sub.weight >= 8 ? b.weightDedicated : b.weightShared}
                  </AccountPill>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="account-billing-panel">
          <div className="account-billing-panel__header">
            <div>
              <p>{b.bindSection}</p>
              <h3>{b.bindHeading}</h3>
            </div>
            <KeyRoundIcon />
          </div>
          <p className="account-billing-panel__desc">{b.bindDesc}</p>
          <BindCardForm onBound={onBound} />
        </section>
      </div>

      <section className="account-billing-panel">
        <div className="account-billing-panel__header">
          <div>
            <p>{b.plansSection}</p>
            <h3>{b.plansHeading}</h3>
          </div>
          <CreditCardIcon />
        </div>

        <Link href="/account/billing/plans" className="account-catalog-entry">
          <span className="account-catalog-entry__icon">
            <SparklesIcon />
          </span>
          <span className="account-catalog-entry__text">
            <strong>{b.catalog.entryTitle}</strong>
            <span>{b.catalog.entryDesc}</span>
          </span>
          <span className="account-catalog-entry__cta">
            {b.catalog.entryCta}
            <ArrowRightIcon />
          </span>
        </Link>

        {catalogOnly ? null : plans === null ? (
          <div className="account-plan-grid">
            <AccountSkeleton className="account-skeleton--plan" />
            <AccountSkeleton className="account-skeleton--plan" />
            <AccountSkeleton className="account-skeleton--plan" />
          </div>
        ) : plans.length === 0 ? (
          <p className="account-billing-empty">{b.plansEmptyDesc}</p>
        ) : (
          <div className="account-plan-grid">
            {plans.map((plan) => (
              <article className="account-plan-card" key={plan.id}>
                <div className="account-plan-card__top">
                  <div>
                    <h4>{plan.name}</h4>
                    {plan.description && <p>{plan.description}</p>}
                  </div>
                  <AccountPill tone={plan.weight >= 8 ? "brand" : "info"}>
                    {plan.weight >= 8 ? b.weightDedicated : b.weightShared}
                  </AccountPill>
                </div>
                <div className="account-plan-card__price">
                  <strong>{formatPriceCents(plan.priceCents)}</strong>
                  <span>/ {fmt(b.durationDays, { n: plan.durationDays })}</span>
                </div>
                <div className="account-plan-card__meta">
                  <span>{productList(plan.products, b.autoProvision)}</span>
                  <span>
                    {b.deviceLimitLabel}: {fmt(b.deviceLimitValue, { n: plan.deviceLimit })}
                  </span>
                </div>
                <AccountButton type="button" onClick={() => onPurchase?.(plan)}>
                  {b.buyNow}
                </AccountButton>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="account-billing-panel">
        <div className="account-billing-panel__header">
          <div>
            <p>{b.ordersSection}</p>
            <h3>{b.ordersHeading}</h3>
          </div>
          <ReceiptTextIcon />
        </div>

        {orders === null ? (
          <AccountSkeleton className="account-skeleton--orders" />
        ) : orders.orders.length === 0 ? (
          <p className="account-billing-empty">{b.ordersEmptyDesc}</p>
        ) : (
          <div className="account-order-list">
            {orders.orders.map((order) => (
              <article className="account-order-row" key={order.outTradeNo}>
                <div>
                  <span>{b.colOrderNo}</span>
                  <strong>{order.outTradeNo}</strong>
                </div>
                <div>
                  <span>{b.colPlan}</span>
                  <strong>{order.planName}</strong>
                </div>
                <div>
                  <span>{b.colAmount}</span>
                  <strong>{formatPriceCents(order.amountCents)}</strong>
                </div>
                <div>
                  <span>{b.colChannel}</span>
                  <strong>
                    {order.payType
                      ? (b.payType as Record<string, string>)[order.payType] ?? order.payType
                      : "—"}
                  </strong>
                </div>
                <div>
                  <span>{b.colStatus}</span>
                  <AccountStatusBadge tone={orderStatusTone(order.status)}>
                    {b.orderStatus[order.status]}
                  </AccountStatusBadge>
                </div>
                <div>
                  <span>{b.colCreatedAt}</span>
                  <strong>{formatDateTime(order.createdAt)}</strong>
                </div>
                {order.status === "PENDING" && (onSyncOrder || onCancelOrder) && (
                  <div className="account-order-row__actions">
                    {onSyncOrder && (
                      <SyncOrderButton
                        outTradeNo={order.outTradeNo}
                        onSync={onSyncOrder}
                        labels={{ syncing: b.syncing, syncStatus: b.syncStatus }}
                      />
                    )}
                    {onCancelOrder && (
                      <CancelOrderButton
                        outTradeNo={order.outTradeNo}
                        onCancel={onCancelOrder}
                        labels={{ cancel: b.cancelOrder, cancelling: b.cancelling, confirm: b.cancelConfirm }}
                      />
                    )}
                  </div>
                )}
                {order.status === "PAID" && onRefundOrder && (
                  <div className="account-order-row__actions">
                    <RefundOrderButton
                      outTradeNo={order.outTradeNo}
                      onRefund={onRefundOrder}
                      labels={{ refund: b.refundOrder, refunding: b.refunding, confirm: b.refundConfirm }}
                    />
                  </div>
                )}
              </article>
            ))}
            {orders.total > PAGE_SIZE && (
              <DataPagination
                page={page}
                totalPages={totalPages}
                onPage={onPage}
                labels={{
                  prevPage: b.prevPage,
                  nextPage: b.nextPage,
                  pageInfo: b.pageInfo,
                }}
              />
            )}
          </div>
        )}
      </section>
    </div>
  );
}
