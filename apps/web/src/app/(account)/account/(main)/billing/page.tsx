"use client";

import { useCallback, useEffect, useState } from "react";

import { AccountBillingCenter } from "@/components/account/account-billing-center";
import { OrderQrDialog } from "@/components/account/order-qr-dialog";
import {
  getPlans,
  getSubscriptions,
  listBillingOrders,
} from "@/lib/account/user-api";
import type { BillingOrderRecord, Plan, Subscription } from "@/lib/account/user-types";

const PAGE_SIZE = 10;

export default function BillingPage() {
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
    <>
      <AccountBillingCenter
        subscriptions={subscriptions}
        plans={plans}
        orders={orders}
        page={page}
        totalPages={totalPages}
        loadError={loadError}
        onBound={refreshAfterPurchase}
        onPage={setPage}
        onPurchase={openPurchase}
      />
      <OrderQrDialog
        plan={activePlan}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onPaid={refreshAfterPurchase}
      />
    </>
  );
}
