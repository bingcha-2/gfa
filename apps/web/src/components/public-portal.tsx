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

type PublicPortalProps = {
  defaultTab?: "submit" | "track" | "swap" | "migrate";
};

const submitChecklist = [
  {
    title: "填写卡密",
    detail: "输入以JZ为开头的邀请卡密，每张卡密对应一次邀请任务。"
  },
  {
    title: "填写 Gmail",
    detail: "输入接收邀请的邮箱，提交后系统会自动向你的账号发送家庭组邀请函。"
  },
  {
    title: "查看进度",
    detail: "提交后自动进入处理队列，支持卡密查询任务情况。"
  }
];

const swapChecklist = [
  {
    title: "换号卡密",
    detail: "使用以HH或CX为开头的换号卡密，邀请卡密无法用于此功能。"
  },
  {
    title: "原账号邮箱",
    detail: "填写目前具有会员权益的邮箱，目前暂不支持在其它商家购买的账号。"
  },
  {
    title: "新邮箱",
    detail: "填写要切换到的新Gmail邮箱，系统会自动移除旧号并邀请新号，成功后去点击确认即可。"
  }
];

const migrateChecklist = [
  {
    title: "输入邮箱",
    detail: "输入你之前开通会员时使用的 Gmail 邮箱。"
  },
  {
    title: "自动检测",
    detail: "系统会检测你所在家庭组的母号状态，如果母号异常会自动开放迁移入口。"
  },
  {
    title: "一键迁移",
    detail: "点击迁移后系统自动将你转移到正常的家庭组，到期时间不受影响。"
  }
];

export function PublicPortal({ defaultTab = "submit" }: PublicPortalProps) {
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
    activeTab === "submit" ? "提交说明" : activeTab === "swap" ? "换号说明" : activeTab === "migrate" ? "售后说明" : "最近记录";
  const sideTitle =
    activeTab === "submit"
      ? "提交前确认这三项"
      : activeTab === "swap"
        ? "换号前确认这三项"
        : activeTab === "migrate"
          ? "自助售后三步骤"
          : "最近查询过的订单";
  const sideNotice =
    activeTab === "submit"
      ? "提交成功后会自动切到「查询进度」，并开始刷新订单状态。"
      : activeTab === "swap"
        ? "换号成功后会跳到「查询进度」，追踪换号任务执行情况。"
        : activeTab === "migrate"
          ? "检测到异常后可一键迁移，迁移不会影响您的到期时间。"
          : "最近记录会留在当前浏览器里，但按卡密查询本身已经支持跨设备。";

  return (
    <main className="page-shell compact public-shell">
      <section className="public-frame">
        <div className="public-topbar">
          <div className="public-brand">
            <div className="nav-mark" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ea580c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"></path><path d="M12 22V12"></path><polyline points="3.29 7 12 12 20.71 7"></polyline><path d="m7.5 4.27 9 5.15"></path></svg>
            </div>
            <div className="public-brand-copy">
              <span className="public-kicker">Future is coming</span>
              <strong style={{ fontSize: '28px', background: 'linear-gradient(90deg, #f97316, #ea580c)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', color: 'transparent' }}>冰茶 AI 续航终端</strong>
            </div>
          </div>


        </div>

        <div style={{ marginBottom: '24px' }}>
          <p style={{ fontSize: '14px', color: 'var(--foreground-muted)' }}>欢迎使用冰茶AI续航系统，此系统主要用于自助邀请加入家庭组、切换会员权益等。</p>
          <div className="notice" style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '12px', background: 'rgba(234, 88, 12, 0.1)', border: '1px solid rgba(234, 88, 12, 0.3)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
              <span style={{ color: 'var(--foreground)', fontSize: '16px', fontWeight: 700 }}>探索更多前沿 AI 产品，各类AI会员充值，欢迎选购：</span>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <a href="https://www.bcai.store/" target="_blank" rel="noopener noreferrer" className="button secondary" style={{ fontSize: '13px', padding: '0 20px', minHeight: '38px', fontWeight: 600, background: '#ea580c', color: '#fff', borderColor: '#ea580c' }}>
                  进入冰茶商店 →
                </a>
                <a href="https://bcai.online/" target="_blank" rel="noopener noreferrer" className="button secondary" style={{ fontSize: '13px', padding: '0 20px', minHeight: '38px', fontWeight: 600, background: '#ea580c', color: '#fff', borderColor: '#ea580c' }}>
                  冰茶API →
                </a>
                <a href="/download" className="button secondary" style={{ fontSize: '13px', padding: '0 20px', minHeight: '38px', fontWeight: 600, background: '#1d4ed8', color: '#fff', borderColor: '#1d4ed8' }}>
                  ⬇ 下载客户端
                </a>
              </div>
            </div>
            <div style={{ borderTop: '1px solid rgba(234, 88, 12, 0.2)', paddingTop: '10px' }}>
              <Link href="/faq" className="button secondary" style={{ fontSize: '13px', padding: '0 20px', minHeight: '38px', fontWeight: 600 }}>
                常见问题解答 →
              </Link>
            </div>
          </div>
        </div>

        <div className="portal-tabs" role="tablist" aria-label="公开端操作">
          <button
            aria-selected={activeTab === "submit"}
            className={`tab-chip${activeTab === "submit" ? " active" : ""}`}
            onClick={() => setActiveTab("submit")}
            role="tab"
            type="button"
          >
            邀请进组
          </button>
          <button
            aria-selected={activeTab === "swap"}
            className={`tab-chip${activeTab === "swap" ? " active" : ""}`}
            onClick={() => setActiveTab("swap")}
            role="tab"
            type="button"
          >
            替换会员
          </button>
          <button
            aria-selected={activeTab === "migrate"}
            className={`tab-chip${activeTab === "migrate" ? " active" : ""}`}
            onClick={() => setActiveTab("migrate")}
            role="tab"
            type="button"
          >
            自助售后
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
                <p className="label">{sideLabel}</p>
                <h2 className="public-panel-title">{sideTitle}</h2>
              </div>

              {activeTab === "submit" ? (
                <div className="plain-list">
                  {submitChecklist.map((item, index) => (
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
                  {swapChecklist.map((item, index) => (
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
                  {migrateChecklist.map((item, index) => (
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

              <div className="notice subtle">{sideNotice}</div>
            </div>
          </aside>

          <div className="panel-stack">
            {activeTab === "submit" ? (
              <RedeemForm
                onSuccess={handleSubmitSuccess}
                secondaryHref="/status"
                secondaryLabel="切到查询"
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
