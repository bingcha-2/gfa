"use client";

import { useCallback, useEffect, useState } from "react";

import { AccountBillingCenter } from "@/components/account/account-billing-center";
import { getSubscriptions, listBillingOrders } from "@/lib/account/user-api";
import type { BillingOrderRecord, Subscription } from "@/lib/account/user-types";

const PAGE_SIZE = 10;

export default function BillingPage() {
  const [subscriptions, setSubscriptions] = useState<Subscription[] | null>(null);
  const [orders, setOrders] = useState<{
    orders: BillingOrderRecord[];
    total: number;
  } | null>(null);
  const [page, setPage] = useState(1);
  const [loadError, setLoadError] = useState(false);

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
  }, [loadSubscriptions]);

  useEffect(() => {
    void loadOrders(page);
  }, [page, loadOrders]);

  const refreshAfterPurchase = useCallback(() => {
    void loadSubscriptions();
    void loadOrders(page);
  }, [loadSubscriptions, loadOrders, page]);

  const totalPages = orders
    ? Math.max(1, Math.ceil(orders.total / PAGE_SIZE))
    : 1;

  return (
    <AccountBillingCenter
      subscriptions={subscriptions}
      orders={orders}
      page={page}
      totalPages={totalPages}
      loadError={loadError}
      onBound={refreshAfterPurchase}
      onPage={setPage}
    />
  );
}
