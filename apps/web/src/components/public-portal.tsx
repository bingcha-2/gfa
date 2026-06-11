"use client";

import Link from "next/link";
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
import { LocaleSwitcher } from "@/app/_marketing/locale-switcher";

type PublicPortalProps = {
  defaultTab?: "submit" | "track" | "swap" | "migrate";
};

export function PublicPortal({ defaultTab = "submit" }: PublicPortalProps) {
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

  function openRecent(record: PublicOrderRecord) {
    setActiveTab("track");
    setTrackedOrderNo(record.orderNo);
    setLookupError(null);
  }

  const activeRecord =
    recentOrders.find((item) => item.orderNo === trackedOrderNo) ?? null;

  const sideLabel =
    activeTab === "submit" ? t.portal.sideLabelSubmit : activeTab === "swap" ? t.portal.sideLabelSwap : activeTab === "migrate" ? t.portal.sideLabelMigrate : t.portal.sideLabelTrack;
  const sideTitle =
    activeTab === "submit"
      ? t.portal.sideTitleSubmit
      : activeTab === "swap"
        ? t.portal.sideTitleSwap
        : activeTab === "migrate"
          ? t.portal.sideTitleMigrate
          : t.portal.sideTitleTrack;
  const sideNotice =
    activeTab === "submit"
      ? t.portal.sideNoticeSubmit
      : activeTab === "swap"
        ? t.portal.sideNoticeSwap
        : activeTab === "migrate"
          ? t.portal.sideNoticeMigrate
          : t.portal.sideNoticeTrack;

  return (
    <main className="page-shell compact public-shell">
      <section className="public-frame">
        <div className="public-topbar">
          <div className="public-brand">
            <div className="nav-mark" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ea580c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"></path><path d="M12 22V12"></path><polyline points="3.29 7 12 12 20.71 7"></polyline><path d="m7.5 4.27 9 5.15"></path></svg>
            </div>
            <div className="public-brand-copy">
              <span className="public-kicker">{t.portal.kicker}</span>
              <strong style={{ fontSize: '28px', background: 'linear-gradient(90deg, #f97316, #ea580c)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', color: 'transparent' }}>{t.portal.brandTitle}</strong>
            </div>
          </div>

          <LocaleSwitcher />
        </div>

        <div style={{ marginBottom: '24px' }}>
          <p style={{ fontSize: '14px', color: 'var(--foreground-muted)' }}>{t.portal.welcome}</p>
          <div className="notice" style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '12px', background: 'rgba(234, 88, 12, 0.1)', border: '1px solid rgba(234, 88, 12, 0.3)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
              <span style={{ color: 'var(--foreground)', fontSize: '16px', fontWeight: 700 }}>{t.portal.promoTitle}</span>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <a href="https://www.bcai.store/" target="_blank" rel="noopener noreferrer" className="button secondary" style={{ fontSize: '13px', padding: '0 20px', minHeight: '38px', fontWeight: 600, background: '#ea580c', color: '#fff', borderColor: '#ea580c' }}>
                  {t.portal.promoStore}
                </a>
                <a href="https://bcai.online/" target="_blank" rel="noopener noreferrer" className="button secondary" style={{ fontSize: '13px', padding: '0 20px', minHeight: '38px', fontWeight: 600, background: '#ea580c', color: '#fff', borderColor: '#ea580c' }}>
                  {t.portal.promoApi}
                </a>
                <a href="/download" className="button secondary" style={{ fontSize: '13px', padding: '0 20px', minHeight: '38px', fontWeight: 600, background: '#1d4ed8', color: '#fff', borderColor: '#1d4ed8' }}>
                  {t.portal.promoDownload}
                </a>
              </div>
            </div>
            <div style={{ borderTop: '1px solid rgba(234, 88, 12, 0.2)', paddingTop: '10px' }}>
              <Link href="/faq" className="button secondary" style={{ fontSize: '13px', padding: '0 20px', minHeight: '38px', fontWeight: 600 }}>
                {t.portal.promoFaq}
              </Link>
            </div>
          </div>
        </div>

        <div className="portal-tabs" role="tablist" aria-label={t.portal.tabsAria}>
          <button
            aria-selected={activeTab === "submit"}
            className={`tab-chip${activeTab === "submit" ? " active" : ""}`}
            onClick={() => setActiveTab("submit")}
            role="tab"
            type="button"
          >
            {t.portal.tabSubmit}
          </button>
          <button
            aria-selected={activeTab === "swap"}
            className={`tab-chip${activeTab === "swap" ? " active" : ""}`}
            onClick={() => setActiveTab("swap")}
            role="tab"
            type="button"
          >
            {t.portal.tabSwap}
          </button>
          <button
            aria-selected={activeTab === "migrate"}
            className={`tab-chip${activeTab === "migrate" ? " active" : ""}`}
            onClick={() => setActiveTab("migrate")}
            role="tab"
            type="button"
          >
            {t.portal.tabMigrate}
          </button>
          <button
            aria-selected={activeTab === "track"}
            className={`tab-chip${activeTab === "track" ? " active" : ""}`}
            onClick={() => setActiveTab("track")}
            role="tab"
            type="button"
          >
            {t.portal.tabTrack}
          </button>
        </div>

        <section className="public-grid">
          <aside className="glass-panel public-side">
            <div className="panel-stack">
              <div>
                <p className="label">{sideLabel}</p>
                <h2 className="public-panel-title">{sideTitle}</h2>
              </div>

              {activeTab === "submit" ? (
                <div className="plain-list">
                  {t.portal.submitChecklist.map((item, index) => (
                    <div className="plain-item" key={item.title}>
                      <div className="plain-index" style={{ color: '#000' }}>0{index + 1}</div>
                      <div>
                        <h3>{item.title}</h3>
                        <p>{item.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : activeTab === "swap" ? (
                <div className="plain-list">
                  {t.portal.swapChecklist.map((item, index) => (
                    <div className="plain-item" key={item.title}>
                      <div className="plain-index" style={{ color: '#000' }}>0{index + 1}</div>
                      <div>
                        <h3>{item.title}</h3>
                        <p>{item.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : activeTab === "migrate" ? (
                <div className="plain-list">
                  {t.portal.migrateChecklist.map((item, index) => (
                    <div className="plain-item" key={item.title}>
                      <div className="plain-index" style={{ color: '#000' }}>0{index + 1}</div>
                      <div>
                        <h3>{item.title}</h3>
                        <p>{item.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : recentOrders.length > 0 ? (
                <div className="recent-list">
                  {recentOrders.map((item) => (
                    <button
                      className={`recent-card${item.orderNo === trackedOrderNo ? " active" : ""}`}
                      key={item.orderNo}
                      onClick={() => openRecent(item)}
                      type="button"
                    >
                      <div className="recent-head">
                        <strong className="mono">{item.code}</strong>
                        <span className="status-pill">{t.statusLabels[item.status] ?? item.status}</span>
                      </div>
                      <div className="recent-meta">
                        <span className="mono">{item.orderNo}</span>
                        <span>{item.email}</span>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  {t.portal.emptyRecent}
                </div>
              )}

              <div className="notice subtle">{sideNotice}</div>
            </div>
          </aside>

          <div className="panel-stack">
            {activeTab === "submit" ? (
              <RedeemForm onSuccess={handleSubmitSuccess} secondaryHref="/status" secondaryLabel={t.portal.simpleSwitchToTrack} />
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
                {t.portal.trackEmpty}
              </div>
            ) : null}
          </div>
        </section>
      </section>
    </main>
  );
}
