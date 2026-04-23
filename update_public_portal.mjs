import fs from 'fs';

const content = `"use client";

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
      const order = await apiRequest<PublicOrder>(\`public/orders/by-code/\${code}\`);
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

  // Generate some deterministic particles
  const particles = Array.from({ length: 15 }).map((_, i) => (
    <div 
      key={i} 
      className="particle" 
      style={{
        left: \`\${(i * 17) % 100}%\`,
        width: \`\${(i % 3) + 2}px\`,
        height: \`\${(i % 3) + 2}px\`,
        animationDuration: \`\${5 + (i % 7)}s\`,
        animationDelay: \`\${(i % 5)}s\`
      }} 
    />
  ));

  return (
    <>
      <div className="particles-bg">
        {particles}
      </div>
      <main className="page-shell animate-fade-in-up">
        <section className="public-frame">
          <div className="public-topbar">
            <div className="public-brand">
              <div className="nav-mark" style={{ fontWeight: 600, color: 'var(--foreground)' }}>
                <svg height="28" viewBox="0 0 16 16" width="28" fill="currentColor">
                  <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"></path>
                </svg>
              </div>
              <div className="public-brand-copy">
                <span style={{ fontSize: '12px', color: 'var(--foreground-muted)' }}>NETWORK.UPLINK</span>
                <strong style={{ fontSize: '16px', color: 'var(--foreground)' }}>
                  冰茶 AI 续航终端
                </strong>
              </div>
            </div>

            <div className="nav-links">
              <Link className="button" href="/status">
                Track Order
              </Link>
            </div>
          </div>

          <div style={{ marginBottom: '24px' }}>
            <p style={{ fontSize: '14px', color: 'var(--foreground-muted)' }}>欢迎使用冰茶AI续航系统，此系统主要用于自助邀请加入家庭组、切换会员权益等。</p>
            <div className="notice" style={{ marginTop: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '1.2rem' }}>💡</span>
                <span style={{ color: 'var(--foreground-muted)', fontSize: '14px' }}>如果需要探索更多前沿 AI 产品，欢迎选购：</span>
              </div>
              <a href="https://www.bcai.store/" target="_blank" rel="noopener noreferrer" className="button" style={{ fontSize: '13px' }}>
                进入冰茶 AI 商店 →
              </a>
            </div>
          </div>

          <div className="portal-tabs" role="tablist" aria-label="公开端操作">
            <button
              aria-selected={activeTab === "submit"}
              className={\`tab-chip\${activeTab === "submit" ? " active" : ""}\`}
              onClick={() => setActiveTab("submit")}
              role="tab"
              type="button"
            >
              邀请进组
            </button>
            <button
              aria-selected={activeTab === "swap"}
              className={\`tab-chip\${activeTab === "swap" ? " active" : ""}\`}
              onClick={() => setActiveTab("swap")}
              role="tab"
              type="button"
            >
              切换账号
            </button>
            <button
              aria-selected={activeTab === "track"}
              className={\`tab-chip\${activeTab === "track" ? " active" : ""}\`}
              onClick={() => setActiveTab("track")}
              role="tab"
              type="button"
            >
              查询进度
            </button>
          </div>

          <section className="public-grid">
            <aside className="glass-panel public-side">
              <div className="panel-stack animate-fade-in-up delay-100">
                <div>
                  <p className="label">{sideLabel}</p>
                  <h2 className="public-panel-title">{sideTitle}</h2>
                </div>

                {activeTab === "submit" ? (
                  <div className="plain-list">
                    {submitChecklist.map((item, index) => (
                      <div className="plain-item" key={item.title}>
                        <div className="plain-index">{index + 1}</div>
                        <div>
                          <label style={{ fontSize: '14px', fontWeight: 600, color: 'var(--foreground)' }}>{item.title}</label>
                          <p className="muted" style={{ margin: '4px 0 0' }}>{item.detail}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : activeTab === "swap" ? (
                  <div className="plain-list">
                    {swapChecklist.map((item, index) => (
                      <div className="plain-item" key={item.title}>
                        <div className="plain-index">{index + 1}</div>
                        <div>
                          <label style={{ fontSize: '14px', fontWeight: 600, color: 'var(--foreground)' }}>{item.title}</label>
                          <p className="muted" style={{ margin: '4px 0 0' }}>{item.detail}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : recentOrders.length > 0 ? (
                  <div className="plain-list">
                    {recentOrders.map((item) => (
                      <button
                        className={\`recent-card\${item.orderNo === trackedOrderNo ? " active" : ""}\`}
                        key={item.orderNo}
                        onClick={() => openRecent(item)}
                        type="button"
                      >
                        <div className="recent-head">
                          <strong className="mono" style={{ fontSize: '14px' }}>{item.code}</strong>
                          <span className="status-pill">{item.status}</span>
                        </div>
                        <div className="recent-meta" style={{ marginTop: '6px' }}>
                          <span className="mono">{item.orderNo}</span>
                          <span>{item.email}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="notice subtle" style={{ marginTop: '16px' }}>
                    当前浏览器还没有提交记录。先去提交卡密，成功后这里会自动出现最近进度。
                  </div>
                )}

                <div className="notice subtle" style={{ marginTop: '24px', borderTop: '1px solid var(--border-muted)', paddingTop: '16px' }}>{sideNotice}</div>
              </div>
            </aside>

            <div className="panel-stack">
              <div key={activeTab}>
                {activeTab === "submit" ? (
                  <RedeemForm
                    onSuccess={handleSubmitSuccess}
                    secondaryHref="/status"
                    secondaryLabel="切到查询"
                  />
                ) : activeTab === "swap" ? (
                  <SwapAccountForm onSuccess={handleSwapSuccess} />
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
                          当前查询卡密: <span className="mono" style={{ color: 'var(--accent)', fontWeight: 600 }}>{activeRecord.code}</span>
                          {" · "}
                          订单号: <span className="mono" style={{ color: 'var(--accent)', fontWeight: 600 }}>{activeRecord.orderNo}</span>
                        </div>
                      ) : null}
                    </div>
                  </section>
                )}
              </div>

              {lookupError ? <div className="notice error animate-fade-in-up">{lookupError}</div> : null}

              {trackedOrderNo ? (
                <div className="animate-fade-in-up delay-300">
                  <OrderStatusPanel orderNo={trackedOrderNo} onOrderLoaded={handleOrderLoaded} />
                </div>
              ) : activeTab === "track" ? (
                <div className="notice subtle animate-fade-in-up delay-300">
                  输入卡密后，这里会显示订单实时状态；也可以直接打开独立状态页输入订单号。
                </div>
              ) : null}
            </div>
          </section>
        </section>
      </main>
    </>
  );
}
`;

fs.writeFileSync('apps/web/src/components/public-portal.tsx', content);
console.log('Updated public-portal.tsx');
