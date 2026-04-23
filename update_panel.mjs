import fs from 'fs';

const content = `"use client";

import { useEffect, useState, useTransition } from "react";

import { apiRequest, getErrorMessage } from "../lib/client-api";
import { formatDateTime } from "../lib/format";
import { PublicOrder } from "../lib/types";
import { StatusBadge } from "./status-badge";
import { ProcessingAnimation } from "./processing-animation";

type OrderStatusPanelProps = {
  orderNo: string;
  onOrderLoaded?: (order: PublicOrder) => void;
};

const terminalStatuses = new Set(["INVITE_SENT", "COMPLETED", "FAILED"]);

export function OrderStatusPanel({ orderNo, onOrderLoaded }: OrderStatusPanelProps) {
  const [order, setOrder] = useState<PublicOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function loadOrder() {
    try {
      const data = await apiRequest<PublicOrder>(\`public/orders/\${orderNo}\`);
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
    <section className="form-card">
      <div className="panel-stack">
        <div>
          <p className="label">Live Status</p>
          <h2 className="public-panel-title">订单进度</h2>
        </div>

        {error ? <div className="notice error">{error}</div> : null}

        {!error && !order ? <div className="notice subtle">正在读取订单状态...</div> : null}

        {order ? (
          <div className="panel-stack animate-fade-in-up">
            {!terminalStatuses.has(order.status) ? (
              <ProcessingAnimation status={order.status} />
            ) : (
              <div className="panel-stack">
                <div style={{ marginBottom: '8px' }}>
                  <StatusBadge value={order.status} />
                </div>

                <div style={{ display: 'grid', gap: '12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className="muted">订单号</span>
                    <strong className="mono" style={{ fontSize: '13px' }}>{order.orderNo}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className="muted">邀请邮箱</span>
                    <strong>{order.userEmail}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className="muted">最新更新</span>
                    <strong>{formatDateTime(order.updatedAt)}</strong>
                  </div>
                </div>

                <div style={{ height: '1px', background: 'var(--border-muted)', margin: '8px 0' }} />

                <div className="panel-stack">
                  <div>
                    <p className="label">Result Message</p>
                    <p className="muted" style={{ marginTop: '4px' }}>
                      {order.resultMessage ?? 
                        (order.status === "COMPLETED" ? "任务已成功完成" : "发生异常，任务中断")}
                    </p>
                  </div>

                  <div>
                    <p className="label">Created At</p>
                    <p className="muted" style={{ marginTop: '4px' }}>{formatDateTime(order.createdAt)}</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
`;

fs.writeFileSync('apps/web/src/components/order-status-panel.tsx', content);
console.log('Updated order-status-panel.tsx');
