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

type PublicPortalProps = {
  defaultTab?: "submit" | "track";
};

const submitChecklist = [
  {
    title: "填写卡密",
    detail: "输入可用卡密。每张卡密只对应一次邀请订单。"
  },
  {
    title: "填写 Gmail",
    detail: "输入接收邀请的邮箱，提交后系统会直接创建订单。"
  },
  {
    title: "查看进度",
    detail: "提交后自动进入处理队列。查询支持卡密，独立状态页支持订单号。"
  }
];

export function PublicPortal({ defaultTab = "submit" }: PublicPortalProps) {
  const [activeTab, setActiveTab] = useState<"submit" | "track">(defaultTab);
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

  return (
    <main className="page-shell compact public-shell">
      <section className="public-frame">
        <div className="public-topbar">
          <div className="public-brand">
            <div className="nav-mark">GO</div>
            <div className="public-brand-copy">
              <span className="public-kicker">Google One</span>
              <strong>公开提交入口</strong>
            </div>
          </div>

          <div className="nav-links">
            <Link className="pill-link" href="/status">
              查询页
            </Link>
            <Link className="button secondary" href="/console/login">
              运营登录
            </Link>
          </div>
        </div>

        <div className="public-summary">
          <p>提交卡密后自动处理。查询支持卡密，独立状态页支持订单号。</p>
        </div>

        <div className="portal-tabs" role="tablist" aria-label="公开端操作">
          <button
            aria-selected={activeTab === "submit"}
            className={`tab-chip${activeTab === "submit" ? " active" : ""}`}
            onClick={() => setActiveTab("submit")}
            role="tab"
            type="button"
          >
            提交邀请
          </button>
          <button
            aria-selected={activeTab === "track"}
            className={`tab-chip${activeTab === "track" ? " active" : ""}`}
            onClick={() => setActiveTab("track")}
            role="tab"
            type="button"
          >
            查询进度
          </button>
        </div>

        <section className="public-grid">
          <aside className="glass-panel public-side">
            <div className="panel-stack">
              <div>
                <p className="label">{activeTab === "submit" ? "提交说明" : "最近记录"}</p>
                <h2 className="public-panel-title">
                  {activeTab === "submit" ? "提交前确认这三项" : "最近查询过的订单"}
                </h2>
              </div>

              {activeTab === "submit" ? (
                <div className="plain-list">
                  {submitChecklist.map((item, index) => (
                    <div className="plain-item" key={item.title}>
                      <div className="plain-index">0{index + 1}</div>
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
                        <span className="status-pill">{item.status}</span>
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
                  当前浏览器还没有提交记录。先去提交卡密，成功后这里会自动出现最近进度。
                </div>
              )}

              <div className="notice subtle">
                {activeTab === "submit"
                  ? "提交成功后会自动切到“查询进度”，并开始刷新订单状态。"
                  : "最近记录会留在当前浏览器里，但按卡密查询本身已经支持跨设备。"}
              </div>
            </div>
          </aside>

          <div className="panel-stack">
            {activeTab === "submit" ? (
              <RedeemForm
                onSuccess={handleSubmitSuccess}
                secondaryHref="/status"
                secondaryLabel="切到查询"
              />
            ) : (
              <section className="form-card">
                <div className="panel-stack">
                  <div>
                    <p className="label">按卡密查询</p>
                    <h2 className="public-panel-title">输入卡密查看订单进度</h2>
                  </div>

                  <StatusLookupForm kind="code" onLookup={handleLookup} />

                  {activeRecord ? (
                    <div className="notice">
                      当前查询卡密: <span className="mono strong">{activeRecord.code}</span>
                      {" · "}
                      订单号: <span className="mono strong">{activeRecord.orderNo}</span>
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
                输入卡密后，这里会显示订单实时状态；也可以直接打开独立状态页输入订单号。
              </div>
            ) : null}
          </div>
        </section>
      </section>
    </main>
  );
}
