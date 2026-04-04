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

type PublicPortalProps = {
  defaultTab?: "submit" | "track" | "swap";
};

const submitChecklist = [
  {
    title: "填写卡密",
    detail: "输入以JZ开头的邀请卡密。每张卡密只对应一次邀请订单。"
  },
  {
    title: "填写 Gmail",
    detail: "输入接收邀请的邮箱，提交后系统会向你的账号发送家庭组邀请函。"
  },
  {
    title: "查看进度",
    detail: "提交后自动进入处理队列。查询支持卡密，独立状态页支持订单号。"
  }
];

const swapChecklist = [
  {
    title: "换号卡密",
    detail: "输入以HH或CX开头的换号卡密。注意CX卡密会绑定你上一次切换成功的账号。"
  },
  {
    title: "原账号邮箱",
    detail: "填写目前具有会员权益的账号，暂不支持在其它商家购买的会员。"
  },
  {
    title: "新邮箱",
    detail: "填写要切换到的新 Gmail 地址，系统会自动移除旧号并重新邀请，去接受邀请即可转移会员权益。"
  }
];

export function PublicPortal({ defaultTab = "submit" }: PublicPortalProps) {
  const [activeTab, setActiveTab] = useState<"submit" | "track" | "swap">(defaultTab);
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
    activeTab === "submit" ? "提交说明" : activeTab === "swap" ? "换号说明" : "最近记录";
  const sideTitle =
    activeTab === "submit"
      ? "提交前确认这三项"
      : activeTab === "swap"
      ? "换号前确认这三项"
      : "最近查询过的订单";
  const sideNotice =
    activeTab === "submit"
      ? "提交成功后会自动切到「查询进度」，并开始刷新订单状态。"
      : activeTab === "swap"
      ? "换号成功后会跳到「查询进度」，追踪换号任务执行情况。"
      : "最近记录会留在当前浏览器里，但按卡密查询本身已经支持跨设备。";

  return (
    <main className="page-shell compact public-shell animate-fade-in-up">
      <section className="public-frame premium-shadow">
        <div className="public-topbar">
          <div className="public-brand">
            <div className="cyber-glitch-text nav-mark" style={{ fontSize: '24px', width: '48px', height: '48px', border: 'none', background: 'transparent', color: 'var(--accent)', textShadow: '0 0 10px var(--accent)' }}>
              [SYS]
            </div>
            <div className="public-brand-copy">
              <span className="public-kicker" style={{ color: 'var(--accent)', letterSpacing: '0.2em' }}>NETWORK.UPLINK.ESTABLISHED</span>
              <strong style={{ fontSize: '1.25rem', color: 'var(--foreground)', textShadow: '0 0 8px rgba(0, 240, 255, 0.4)' }}>
                冰茶 AI 续航终端
              </strong>
            </div>
          </div>

          <div className="nav-links">
            <Link className="pill-link" href="/status" style={{ fontWeight: 800 }}>
              &gt; TRACK_ORDER
            </Link>
          </div>
        </div>

        <div className="public-summary" style={{ marginBottom: '8px' }}>
          <p style={{ fontSize: '1.05rem' }}>欢迎使用冰茶AI续航系统，此系统主要用于自助邀请加入家庭组、切换会员权益等。</p>
          <div style={{ marginTop: '16px', background: 'linear-gradient(135deg, rgba(203, 93, 22, 0.1), rgba(15, 118, 110, 0.1))', padding: '14px 20px', borderRadius: '14px', border: '1px solid rgba(15, 118, 110, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', boxShadow: '0 4px 12px rgba(15, 118, 110, 0.05)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '1.3rem' }}>🛍️</span>
              <span style={{ fontWeight: 600, color: 'var(--accent-strong)', fontSize: '0.95rem' }}>如果需要探索更多前沿 AI 产品，欢迎选购：</span>
            </div>
            <a href="https://www.bcai.store/" target="_blank" rel="noopener noreferrer" className="button premium-primary" style={{ minHeight: '38px', padding: '0 20px', fontSize: '14px', whiteSpace: 'nowrap' }}>
              进入冰茶 AI 商店 →
            </a>
          </div>
        </div>

        <div className="portal-tabs" role="tablist" aria-label="公开端操作" style={{ borderRadius: '4px', background: 'rgba(5, 10, 20, 0.6)', border: '1px solid var(--line-strong)', boxShadow: '0 0 10px rgba(0,240,255,0.1)' }}>
          <button
            aria-selected={activeTab === "submit"}
            className={`tab-chip${activeTab === "submit" ? " active" : ""}`}
            onClick={() => setActiveTab("submit")}
            role="tab"
            type="button"
          >
            [01] 邀请进组
          </button>
          <button
            aria-selected={activeTab === "swap"}
            className={`tab-chip${activeTab === "swap" ? " active" : ""}`}
            onClick={() => setActiveTab("swap")}
            role="tab"
            type="button"
          >
            [02] 切换账号
          </button>
          <button
            aria-selected={activeTab === "track"}
            className={`tab-chip${activeTab === "track" ? " active" : ""}`}
            onClick={() => setActiveTab("track")}
            role="tab"
            type="button"
          >
            [03] 查询进度
          </button>
        </div>

        <section className="public-grid">
          <aside className="glass-panel public-side premium-shadow">
            <div className="panel-stack animate-fade-in-up delay-100">
              <div>
                <p className="label" style={{ color: 'var(--accent)' }}>{sideLabel}</p>
                <h2 className="public-panel-title">{sideTitle}</h2>
              </div>

              {activeTab === "submit" ? (
                <div className="plain-list">
                  {submitChecklist.map((item, index) => (
                    <div className="plain-item" key={item.title}>
                      <div className="plain-index">&gt;0{index + 1}</div>
                      <div>
                        <h3 style={{ color: 'var(--accent)' }}>{item.title}</h3>
                        <p>{item.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : activeTab === "swap" ? (
                <div className="plain-list">
                  {swapChecklist.map((item, index) => (
                    <div className="plain-item" key={item.title}>
                      <div className="plain-index" style={{ color: 'var(--warm)', borderColor: 'var(--warm)', background: 'rgba(255,0,85,0.1)', boxShadow: '0 0 10px rgba(255,0,85,0.2) inset' }}>&gt;0{index + 1}</div>
                      <div>
                        <h3 style={{ color: 'var(--warm)' }}>{item.title}</h3>
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

              <div className="notice subtle" style={{ marginTop: 'auto', borderTop: '1px solid var(--line)', paddingTop: '16px' }}>{sideNotice}</div>
            </div>
          </aside>

          <div className="panel-stack cyber-viewport">
            <div key={activeTab} className="cyber-slide-enter">
              {activeTab === "submit" ? (
                <RedeemForm
                  onSuccess={handleSubmitSuccess}
                  secondaryHref="/status"
                  secondaryLabel="切到查询"
                />
              ) : activeTab === "swap" ? (
                <SwapAccountForm onSuccess={handleSwapSuccess} />
              ) : (
                <section className="form-card premium-shadow">
                  <div className="panel-stack">
                    <div>
                      <p className="label">按卡密查询</p>
                      <h2 className="public-panel-title">输入卡密查看订单进度</h2>
                    </div>

                    <StatusLookupForm kind="code" onLookup={handleLookup} />

                    {activeRecord ? (
                      <div className="notice" style={{ borderLeftColor: 'var(--accent)' }}>
                        当前查询卡密: <span className="mono strong">{activeRecord.code}</span>
                        {" · "}
                        订单号: <span className="mono strong">{activeRecord.orderNo}</span>
                      </div>
                    ) : null}
                  </div>
                </section>
              )}
            </div>

            {lookupError ? <div className="notice warn animate-fade-in-up">{lookupError}</div> : null}

            {trackedOrderNo ? (
              <div className="animate-fade-in-up delay-300">
                <OrderStatusPanel orderNo={trackedOrderNo} onOrderLoaded={handleOrderLoaded} />
              </div>
            ) : activeTab === "track" ? (
              <div className="empty-state animate-fade-in-up delay-300">
                输入卡密后，这里会显示订单实时状态；也可以直接打开独立状态页输入订单号。
              </div>
            ) : null}
          </div>
        </section>
      </section>
    </main>
  );
}
