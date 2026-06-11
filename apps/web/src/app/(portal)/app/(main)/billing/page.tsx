"use client";

import { useCallback, useEffect, useState } from "react";
import { CreditCardIcon } from "lucide-react";

import { PageHeader } from "@/components/portal/page-header";
import { BindCardForm } from "@/components/portal/bind-card-form";
import { OrderQrDialog } from "@/components/portal/order-qr-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  getPlans,
  getSubscriptions,
  listBillingOrders,
} from "@/lib/user-api";
import type {
  BillingOrderRecord,
  OrderStatus,
  Plan,
  Subscription,
} from "@/lib/user-types";
import { formatDateTime } from "@/lib/format";
import { formatPriceCents } from "@/lib/format-extensions";
import { fmt } from "@/lib/i18n";
import { useDict } from "@/lib/i18n/client";

const PAGE_SIZE = 10;

function orderStatusVariant(
  status: OrderStatus
): "default" | "secondary" | "destructive" | "outline" | "ghost" {
  switch (status) {
    case "PAID":
      return "secondary";
    case "PENDING":
      return "outline";
    case "FAILED":
      return "destructive";
    case "EXPIRED":
    case "REFUNDED":
    default:
      return "ghost";
  }
}

export default function BillingPage() {
  const dict = useDict();
  const t = dict.portalApp;
  const b = t.billing;

  const [subscriptions, setSubscriptions] = useState<Subscription[] | null>(null);
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [orders, setOrders] = useState<{
    orders: BillingOrderRecord[];
    total: number;
  } | null>(null);
  const [page, setPage] = useState(1);
  const [loadError, setLoadError] = useState(false);
  const [activePlan, setActivePlan] = useState<Plan | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const loadSubscriptions = useCallback(async () => {
    try {
      const data = await getSubscriptions();
      setSubscriptions(data.subscriptions);
    } catch {
      setSubscriptions([]);
      setLoadError(true);
    }
  }, []);

  const loadOrders = useCallback(async (p: number) => {
    try {
      const data = await listBillingOrders(p, PAGE_SIZE);
      setOrders(data);
    } catch {
      setOrders({ orders: [], total: 0 });
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void loadSubscriptions();
    getPlans()
      .then((data) =>
        setPlans([...data.plans].sort((a, z) => a.sortOrder - z.sortOrder))
      )
      .catch(() => {
        setPlans([]);
        setLoadError(true);
      });
  }, [loadSubscriptions]);

  useEffect(() => {
    void loadOrders(page);
  }, [page, loadOrders]);

  const refreshAfterPurchase = useCallback(() => {
    void loadSubscriptions();
    void loadOrders(page);
  }, [loadSubscriptions, loadOrders, page]);

  function openPurchase(plan: Plan) {
    setActivePlan(plan);
    setDialogOpen(true);
  }

  const totalPages = orders
    ? Math.max(1, Math.ceil(orders.total / PAGE_SIZE))
    : 1;

  return (
    <div className="space-y-8">
      <PageHeader title={t.pages.billingTitle} />

      {loadError && (
        <p className="text-sm text-destructive">{b.loadFailed}</p>
      )}

      {/* ── 当前订阅 + 绑定卡密 ─────────────────────────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-3">
        <section className="space-y-4 lg:col-span-2">
          <h3 className="text-sm font-medium">{b.currentSection}</h3>

          {subscriptions === null ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Skeleton className="h-36 rounded-xl" />
              <Skeleton className="h-36 rounded-xl" />
            </div>
          ) : subscriptions.length === 0 ? (
            <Empty className="border min-h-[144px]">
              <EmptyHeader>
                <EmptyTitle>{b.currentEmpty}</EmptyTitle>
                <EmptyDescription>{b.currentEmptyDesc}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {subscriptions.map((sub) => (
                <div
                  key={sub.id}
                  className="rounded-xl border bg-card p-5 space-y-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-medium">
                      {sub.planName ?? b.migratedPlanName}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {sub.migratedFromCard && (
                        <Badge variant="outline">{b.migratedBadge}</Badge>
                      )}
                      <Badge variant="secondary">
                        {sub.weight >= 8 ? b.weightDedicated : b.weightShared}
                      </Badge>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {sub.products.map((p) => (
                      <Badge key={p} variant="outline">
                        {p}
                      </Badge>
                    ))}
                  </div>

                  <div className="grid gap-1 text-sm text-muted-foreground">
                    <span>
                      {b.expiresLabel}:{" "}
                      <span className="tabular-nums text-foreground">
                        {sub.expiresAt
                          ? formatDateTime(sub.expiresAt)
                          : b.neverExpires}
                      </span>
                    </span>
                    <span>
                      {b.deviceLimitLabel}:{" "}
                      <span className="tabular-nums text-foreground">
                        {fmt(b.deviceLimitValue, { n: sub.deviceLimit })}
                      </span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-4">
          <h3 className="text-sm font-medium">{b.bindSection}</h3>
          <div className="rounded-xl border bg-card p-5 space-y-3">
            <p className="text-sm text-muted-foreground">{b.bindDesc}</p>
            <BindCardForm onBound={refreshAfterPurchase} />
          </div>
        </section>
      </div>

      {/* ── 套餐目录 ────────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <h3 className="text-sm font-medium">{b.plansSection}</h3>

        {plans === null ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Skeleton className="h-52 rounded-xl" />
            <Skeleton className="h-52 rounded-xl" />
            <Skeleton className="h-52 rounded-xl" />
          </div>
        ) : plans.length === 0 ? (
          <Empty className="border min-h-[144px]">
            <EmptyHeader>
              <EmptyTitle>{b.plansEmpty}</EmptyTitle>
              <EmptyDescription>{b.plansEmptyDesc}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {plans.map((plan) => (
              <div
                key={plan.id}
                className="rounded-xl border bg-card p-5 flex flex-col gap-3 transition-colors duration-200 hover:border-foreground/20"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="font-medium">{plan.name}</div>
                  <Badge variant="secondary">
                    {plan.weight >= 8 ? b.weightDedicated : b.weightShared}
                  </Badge>
                </div>

                {plan.description && (
                  <p className="text-sm text-muted-foreground">
                    {plan.description}
                  </p>
                )}

                <div className="flex items-baseline gap-1.5">
                  <span className="text-2xl font-semibold tabular-nums tracking-tight">
                    {formatPriceCents(plan.priceCents)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    / {fmt(b.durationDays, { n: plan.durationDays })}
                  </span>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {plan.products.map((p) => (
                    <Badge key={p} variant="outline">
                      {p}
                    </Badge>
                  ))}
                </div>

                <div className="text-xs text-muted-foreground">
                  {b.deviceLimitLabel}:{" "}
                  <span className="tabular-nums">
                    {fmt(b.deviceLimitValue, { n: plan.deviceLimit })}
                  </span>
                </div>

                <Button className="mt-auto" onClick={() => openPurchase(plan)}>
                  <CreditCardIcon data-icon="inline-start" />
                  {b.buyNow}
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── 订单记录 ────────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <h3 className="text-sm font-medium">{b.ordersSection}</h3>

        {orders === null ? (
          <Skeleton className="h-48 rounded-xl" />
        ) : orders.orders.length === 0 ? (
          <Empty className="border min-h-[144px]">
            <EmptyHeader>
              <EmptyTitle>{b.ordersEmpty}</EmptyTitle>
              <EmptyDescription>{b.ordersEmptyDesc}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="space-y-3">
            <div className="rounded-xl border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{b.colOrderNo}</TableHead>
                    <TableHead>{b.colPlan}</TableHead>
                    <TableHead className="text-right">{b.colAmount}</TableHead>
                    <TableHead>{b.colChannel}</TableHead>
                    <TableHead>{b.colStatus}</TableHead>
                    <TableHead>{b.colCreatedAt}</TableHead>
                    <TableHead>{b.colPaidAt}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orders.orders.map((order) => (
                    <TableRow key={order.outTradeNo}>
                      <TableCell className="font-mono text-xs">
                        {order.outTradeNo}
                      </TableCell>
                      <TableCell>{order.planName}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatPriceCents(order.amountCents)}
                      </TableCell>
                      <TableCell>
                        {order.payChannel === "ALIPAY"
                          ? b.channelAlipay
                          : b.channelWxpay}
                      </TableCell>
                      <TableCell>
                        <Badge variant={orderStatusVariant(order.status)}>
                          {b.orderStatus[order.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">
                        {formatDateTime(order.createdAt)}
                      </TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">
                        {order.paidAt ? formatDateTime(order.paidAt) : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between gap-4">
                <span className="text-xs text-muted-foreground tabular-nums">
                  {fmt(b.pageInfo, { page, pages: totalPages })}
                </span>
                <Pagination className="mx-0 w-auto justify-end">
                  <PaginationContent>
                    <PaginationItem>
                      <PaginationPrevious
                        href="#"
                        text={b.prevPage}
                        aria-disabled={page <= 1}
                        className={
                          page <= 1 ? "pointer-events-none opacity-50" : ""
                        }
                        onClick={(e) => {
                          e.preventDefault();
                          if (page > 1) setPage(page - 1);
                        }}
                      />
                    </PaginationItem>
                    <PaginationItem>
                      <PaginationNext
                        href="#"
                        text={b.nextPage}
                        aria-disabled={page >= totalPages}
                        className={
                          page >= totalPages
                            ? "pointer-events-none opacity-50"
                            : ""
                        }
                        onClick={(e) => {
                          e.preventDefault();
                          if (page < totalPages) setPage(page + 1);
                        }}
                      />
                    </PaginationItem>
                  </PaginationContent>
                </Pagination>
              </div>
            )}
          </div>
        )}
      </section>

      <OrderQrDialog
        plan={activePlan}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onPaid={refreshAfterPurchase}
      />
    </div>
  );
}
