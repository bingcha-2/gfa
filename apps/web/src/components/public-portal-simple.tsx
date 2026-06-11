"use client";

import { useEffect, useState } from "react";

import { apiRequest, getErrorMessage } from "../lib/client-api";
import {
  getStoredPublicOrders,
  type PublicOrderRecord,
  updateStoredPublicOrder,
  upsertStoredPublicOrder
} from "../lib/public-orders";
import { PublicOrder } from "../lib/types";
import { OrderStatusPanel } from "./order-status-panel";
import { RedeemForm, type RedeemSuccessPayload } from "./redeem-form";
import { StatusLookupForm } from "./status-lookup-form";
import { SwapAccountForm, type SwapSuccessPayload } from "./swap-account-form";
import { MigrationCheckForm } from "./migration-check-form";
import { useDict } from "@/lib/i18n/client";

type SimplePortalProps = {
  defaultTab?: "submit" | "track" | "swap" | "migrate";
};

export function PublicPortalSimple({ defaultTab = "submit" }: SimplePortalProps) {
  const t = useDict();
  const [activeTab, setActiveTab] = useState<"submit" | "track" | "swap" | "migrate">(defaultTab);
  const [recentOrders, setRecentOrders] = useState<PublicOrderRecord[]>([]);
  const [trackedOrderNo, setTrackedOrderNo] = useState<string | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  function syncRecentOrders() {
    const records = getStoredPublicOrders();
    setRecentOrders(records);
    return records;
  }

  useEffect(() => {
    setActiveTab(defaultTab);
    const records = syncRecentOrders();
    if (defaultTab === "track" && records.length > 0) {
      setTrackedOrderNo(records[0].orderNo);
      setLookupError(null);
    }
  }, [defaultTab]);

  function handleSubmitSuccess(payload: RedeemSuccessPayload) {
    const now = new Date().toISOString();
    upsertStoredPublicOrder({
      code: payload.code,
      email: payload.email,
      orderNo: payload.orderNo,
      status: payload.status,
      createdAt: now,
      updatedAt: now
    });
    syncRecentOrders();
    setTrackedOrderNo(payload.orderNo);
    setLookupError(null);
    setActiveTab("track");
  }

  function handleSwapSuccess(payload: SwapSuccessPayload) {
    const now = new Date().toISOString();
    upsertStoredPublicOrder({
      code: payload.swapCode,
      email: payload.newEmail,
      orderNo: payload.orderNo,
      status: payload.status,
      createdAt: now,
      updatedAt: now
    });
    syncRecentOrders();
    setTrackedOrderNo(payload.orderNo);
    setLookupError(null);
    setActiveTab("track");
  }

  async function handleLookup(code: string) {
    setActiveTab("track");
    setLookupError(null);

    try {
      const order = await apiRequest<PublicOrder>(`public/orders/by-code/${code}`);
      const existing = recentOrders.find((item) => item.orderNo === order.orderNo);

      upsertStoredPublicOrder({
        code,
        email: existing?.email ?? order.userEmail,
        orderNo: order.orderNo,
        status: order.status,
        createdAt: existing?.createdAt ?? order.createdAt,
        updatedAt: order.updatedAt
      });

      syncRecentOrders();
      setTrackedOrderNo(order.orderNo);
    } catch (lookupRequestError) {
      setTrackedOrderNo(null);
      setLookupError(getErrorMessage(lookupRequestError));
    }
  }

  function handleOrderLoaded(order: PublicOrder) {
    updateStoredPublicOrder(order.orderNo, {
      status: order.status,
      updatedAt: order.updatedAt
    });
    syncRecentOrders();
  }

  const activeRecord =
    recentOrders.find((item) => item.orderNo === trackedOrderNo) ?? null;

  return (
    <div className="simple-portal">
      {/* Compact tab bar */}
      <div className="simple-tabs" role="tablist">
        <button
          aria-selected={activeTab === "submit"}
          className={`simple-tab${activeTab === "submit" ? " active" : ""}`}
          onClick={() => setActiveTab("submit")}
          role="tab"
          type="button"
        >
          {t.portal.tabSubmit}
        </button>
        <button
          aria-selected={activeTab === "swap"}
          className={`simple-tab${activeTab === "swap" ? " active" : ""}`}
          onClick={() => setActiveTab("swap")}
          role="tab"
          type="button"
        >
          {t.portal.tabSwapUnlimited}
        </button>
        <button
          aria-selected={activeTab === "migrate"}
          className={`simple-tab${activeTab === "migrate" ? " active" : ""}`}
          onClick={() => setActiveTab("migrate")}
          role="tab"
          type="button"
        >
          {t.portal.tabMigrate}
        </button>
        <button
          aria-selected={activeTab === "track"}
          className={`simple-tab${activeTab === "track" ? " active" : ""}`}
          onClick={() => setActiveTab("track")}
          role="tab"
          type="button"
        >
          {t.portal.tabTrack}
        </button>
      </div>

      {/* Single-column content area */}
      <div className="simple-content">
        {activeTab === "submit" ? (
          <RedeemForm
            onSuccess={handleSubmitSuccess}
            secondaryHref="/status"
            secondaryLabel={t.portal.simpleSwitchToTrack}
          />
        ) : activeTab === "swap" ? (
          <SwapAccountForm onSuccess={handleSwapSuccess} />
        ) : activeTab === "migrate" ? (
          <MigrationCheckForm />
        ) : (
          <section className="form-card">
            <div className="panel-stack">
              <StatusLookupForm kind="code" onLookup={handleLookup} />

              {activeRecord ? (
                <div className="notice" style={{ background: 'rgba(234, 88, 12, 0.1)', border: '1px solid rgba(234, 88, 12, 0.3)' }}>
                  {t.portal.simpleCurrentCode} <span className="mono strong">{activeRecord.code}</span>
                  {" · "}
                  {t.portal.simpleOrderNo} <span className="mono strong">{activeRecord.orderNo}</span>
                </div>
              ) : null}
            </div>
          </section>
        )}

        {lookupError ? <div className="notice warn">{lookupError}</div> : null}

        {trackedOrderNo ? (
          <OrderStatusPanel orderNo={trackedOrderNo} onOrderLoaded={handleOrderLoaded} />
        ) : activeTab === "track" ? (
          <div className="empty-state">
            {t.portal.simpleTrackEmpty}
          </div>
        ) : null}

        {/* Compact recent orders (only on track tab) */}
        {activeTab === "track" && recentOrders.length > 0 ? (
          <div className="simple-recent">
            <p className="label" style={{ marginBottom: '8px' }}>{t.portal.simpleRecent}</p>
            {recentOrders.slice(0, 5).map((item) => (
              <button
                className={`simple-recent-item${item.orderNo === trackedOrderNo ? " active" : ""}`}
                key={item.orderNo}
                onClick={() => {
                  setTrackedOrderNo(item.orderNo);
                  setLookupError(null);
                }}
                type="button"
              >
                <span className="mono" style={{ fontSize: '12px' }}>{item.code}</span>
                <span className="status-pill" style={{ fontSize: '11px' }}>{t.statusLabels[item.status] ?? item.status}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
