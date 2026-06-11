"use client";

import { useEffect, useState, useTransition } from "react";

import { apiRequest, getErrorMessage } from "../lib/client-api";
import { formatDateTime } from "../lib/format";
import { PublicOrder } from "../lib/types";
import { StatusBadge } from "./status-badge";
import { Button } from "@/components/ui/button";
import { useDict } from "@/lib/i18n/client";

type OrderStatusPanelProps = {
  orderNo: string;
  onOrderLoaded?: (order: PublicOrder) => void;
  onRequestRetry?: () => void;
};

const terminalStatuses = new Set(["INVITE_SENT", "COMPLETED", "FAILED"]);

export function OrderStatusPanel({ orderNo, onOrderLoaded, onRequestRetry }: OrderStatusPanelProps) {
  const t = useDict();
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
            <p className="label">{t.orderPanel.liveStatus}</p>
            <h2 className="panel-title">{t.orderPanel.title}</h2>
          </div>
        </div>

        {error ? <div className="notice error">{error}</div> : null}

        {!error && !order ? <div className="empty-state">{t.orderPanel.loading}</div> : null}

        {order && (order.status === "MANUAL_REVIEW" || order.status === "FAILED") && (
          <div className="notice warning">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, marginBottom: '8px' }}>
              <span>{t.orderPanel.retryWarnTitle}</span>
            </div>
            <div style={{ fontSize: '0.875rem', lineHeight: 1.5 }}>
              {t.orderPanel.retryWarnBody}<br />
              {t.orderPanel.retryWarnBody2}
              {onRequestRetry && (
                <div style={{ marginTop: '12px' }}>
                  <Button variant="outline" size="sm" onClick={onRequestRetry}>
                    {t.orderPanel.retryButton}
                  </Button>
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
                <span className="muted">{t.orderPanel.orderNo}</span>
                <strong className="mono">{order.orderNo}</strong>
              </div>
              <div className="info-row">
                <span className="muted">{t.orderPanel.inviteEmail}</span>
                <strong>{order.userEmail}</strong>
              </div>
              <div className="info-row">
                <span className="muted">{t.orderPanel.updatedAt}</span>
                <strong>{formatDateTime(order.updatedAt)}</strong>
              </div>
            </div>

            <div className="divider" />

            <div className="panel-stack">
              <div>
                <p className="label">{t.orderPanel.resultLabel}</p>
                <p className="muted">
                  {order.resultMessage ?? t.orderPanel.resultFallback}
                </p>
              </div>

              <div>
                <p className="label">{t.orderPanel.createdLabel}</p>
                <p className="muted">{formatDateTime(order.createdAt)}</p>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
