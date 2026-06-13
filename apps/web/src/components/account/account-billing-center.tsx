"use client";

import Link from "next/link";
import {
  ArrowRightIcon,
  CreditCardIcon,
  KeyRoundIcon,
  PackageCheckIcon,
  ReceiptTextIcon,
  SparklesIcon,
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

function productList(products: string[]) {
  return products.length > 0 ? products.join(" / ") : "购买后自动开通";
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
}) {
  const dict = useDict();
  const b = dict.portalApp.billing;
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
                ? "正在同步订阅与订单"
                : current
                  ? "订阅已连接"
                  : "等待购买套餐"}
          </AccountPill>
          <h2>支付中心</h2>
          <p>
            套餐购买、扫码支付、卡密绑定和订单记录集中在这里。支付完成后,
            客户端授权会自动更新。
          </p>
        </div>
        <div className="account-billing-hero__status">
          <div>
            <span>当前订阅</span>
            <strong>{current?.planName ?? (current ? b.migratedPlanName : "暂无套餐")}</strong>
          </div>
          <div>
            <span>订单记录</span>
            <strong>{orderCount} 笔</strong>
          </div>
        </div>
      </section>

      <div className="account-billing__grid">
        <section className="account-billing-panel account-billing-panel--wide">
          <div className="account-billing-panel__header">
            <div>
              <p>{b.currentSection}</p>
              <h3>{current?.planName ?? (current ? b.migratedPlanName : b.currentEmpty)}</h3>
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
                    <strong>{sub.planName ?? b.migratedPlanName}</strong>
                    <span>{productList(sub.products)}</span>
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
              <h3>卡密接入</h3>
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
            <h3>选择套餐</h3>
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
                  <span>{productList(plan.products)}</span>
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
            <h3>支付记录</h3>
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
                    {order.payChannel === "ALIPAY" ? b.channelAlipay : b.channelWxpay}
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
