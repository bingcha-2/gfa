"use client";

import { useEffect, useState, useTransition } from "react";

import { apiRequest, getErrorMessage } from "../lib/client-api";
import { formatDateTime } from "../lib/format";
import { PublicOrder } from "../lib/types";
import { StatusBadge } from "./status-badge";

type OrderStatusPanelProps = {
  orderNo: string;
  onOrderLoaded?: (order: PublicOrder) => void;
  onRequestRetry?: () => void;
};

const terminalStatuses = new Set(["INVITE_SENT", "COMPLETED", "FAILED"]);

export function OrderStatusPanel({ orderNo, onOrderLoaded, onRequestRetry }: OrderStatusPanelProps) {
  const [order, setOrder] = useState<PublicOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function loadOrder() {
    try {
      const data = await apiRequest<PublicOrder>(`public/orders/${orderNo}`);
      setOrder(data);
      setError(null);
      onOrderLoaded?.(data);
    } catch (requestError) {
      setOrder(null);
      setError(getErrorMessage(requestError));
    }
  }

  useEffect(() => {
    startTransition(() => {
      void loadOrder();
    });
  }, [orderNo]);

  useEffect(() => {
    if (!order || terminalStatuses.has(order.status)) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadOrder();
    }, 15000);

    return () => window.clearInterval(timer);
  }, [order?.status, orderNo]);

  return (
    <section className={`glass-panel ${order && !terminalStatuses.has(order.status) ? "success-scanner" : ""}`}>
      <div className="panel-stack">
        <div className="split-head">
          <div>
            <p className="label">Live Status</p>
            <h2 className="panel-title">订单进度</h2>
          </div>
        </div>

        {error ? <div className="notice error">{error}</div> : null}

        {!error && !order ? <div className="empty-state">正在读取订单状态...</div> : null}

        {order && (order.status === "MANUAL_REVIEW" || order.status === "FAILED") && (
          <div className="notice warning">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, marginBottom: '8px' }}>
              <span>⚠️ 任务正在排队等待重试 / 需要干预</span>
            </div>
            <div style={{ fontSize: '0.875rem', lineHeight: 1.5 }}>
              执行该任务的底层节点目前遇到网络或风控限制。系统在此期间会进入保护状态（冷却约30分钟）。<br />
              冷却期结束后，系统会自动重试您的换绑/加入请求，您不需要做任何额外操作。
              {onRequestRetry && (
                <div style={{ marginTop: '12px' }}>
                  <button className="button secondary small" onClick={onRequestRetry}>
                    或者，点此换个邮箱重新提交
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {order ? (
          <div className="panel-stack">
            <StatusBadge value={order.status} />

            <div className="info-grid">
              <div className="info-row">
                <span className="muted">订单号</span>
                <strong className="mono">{order.orderNo}</strong>
              </div>
              <div className="info-row">
                <span className="muted">邀请邮箱</span>
                <strong>{order.userEmail}</strong>
              </div>
              <div className="info-row">
                <span className="muted">最新更新时间</span>
                <strong>{formatDateTime(order.updatedAt)}</strong>
              </div>
            </div>

            <div className="divider" />

            <div className="panel-stack">
              <div>
                <p className="label">Result Message</p>
                <p className="muted">
                  {order.resultMessage ??
                    "如果这里暂时没有说明，代表任务还在排队或等待自动化执行。"}
                </p>
              </div>

              <div>
                <p className="label">Created At</p>
                <p className="muted">{formatDateTime(order.createdAt)}</p>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
