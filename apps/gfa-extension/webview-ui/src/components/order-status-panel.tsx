import React, { useEffect, useState, useTransition } from "react";
import { apiRequest, getErrorMessage } from "../lib/vscode-api";
import { formatDateTime } from "../lib/format";
import { PublicOrder } from "../lib/types";
import { StatusBadge } from "./status-badge";

type OrderStatusPanelProps = { orderNo: string; onOrderLoaded?: (order: PublicOrder) => void };
const terminalStatuses = new Set(["INVITE_SENT", "COMPLETED", "FAILED"]);

export function OrderStatusPanel({ orderNo, onOrderLoaded }: OrderStatusPanelProps) {
  const [order, setOrder] = useState<PublicOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function loadOrder() {
    try {
      const data = await apiRequest<PublicOrder>(`public/orders/${orderNo}`);
      setOrder(data);
      setError(null);
      onOrderLoaded?.(data);
    } catch (err) {
      setOrder(null);
      setError(getErrorMessage(err));
    }
  }

  useEffect(() => { startTransition(() => { void loadOrder(); }); }, [orderNo]);

  useEffect(() => {
    if (!order || terminalStatuses.has(order.status)) return;
    const timer = window.setInterval(() => { void loadOrder(); }, 15000);
    return () => window.clearInterval(timer);
  }, [order?.status, orderNo]);

  return (
    <section className={`glass-panel ${order && !terminalStatuses.has(order.status) ? "success-scanner" : ""}`}>
      <div className="panel-stack">
        <div className="split-head"><div><p className="label">Live Status</p><h2 className="panel-title">订单进度</h2></div></div>
        {error ? <div className="notice error">{error}</div> : null}
        {!error && !order ? <div className="empty-state">正在读取订单状态...</div> : null}
        {order ? (
          <div className="panel-stack">
            <StatusBadge value={order.status} />
            <div className="info-grid">
              <div className="info-row"><span className="muted">订单号</span><strong className="mono">{order.orderNo}</strong></div>
              <div className="info-row"><span className="muted">邀请邮箱</span><strong>{order.userEmail}</strong></div>
              <div className="info-row"><span className="muted">最新更新时间</span><strong>{formatDateTime(order.updatedAt)}</strong></div>
            </div>
            <div className="divider" />
            <div className="panel-stack">
              <div><p className="label">Result Message</p><p className="muted">{order.resultMessage ?? "如果这里暂时没有说明，代表任务还在排队或等待自动化执行。"}</p></div>
              <div><p className="label">Created At</p><p className="muted">{formatDateTime(order.createdAt)}</p></div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
