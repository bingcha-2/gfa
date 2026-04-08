"use client";

import { useState, useEffect, useTransition } from "react";

import { apiRequest, getErrorMessage } from "../lib/client-api";
import { OrderSummary } from "../lib/types";
import { Spinner } from "./spinner";

type ScanStatus = {
  pendingCount: number;
  lastRunAt: string | null;
  lastRunCount: number;
};

type ProcessedOrder = {
  orderId: string;
  orderNo: string;
  userEmail: string;
  familyGroupId: string | null;
};

type RunResult = {
  triggered: boolean;
  processedCount: number;
  orders: ProcessedOrder[];
};

export function ExpireScanPanel() {
  const [expiredOrders, setExpiredOrders] = useState<OrderSummary[]>([]);
  const [isLoadingOrders, setIsLoadingOrders] = useState(true);
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, startTransition] = useTransition();

  async function loadExpiredOrders() {
    setIsLoadingOrders(true);
    try {
      const res = await apiRequest<{ items: OrderSummary[]; total: number }>("orders?status=EXPIRED&pageSize=100");
      setExpiredOrders(res.items);
    } catch (err) {
      console.error("Failed to load expired orders:", err);
    } finally {
      setIsLoadingOrders(false);
    }
  }

  useEffect(() => {
    loadExpiredOrders();
  }, []);

  async function loadStatus() {
    try {
      const data = await apiRequest<ScanStatus>("admin/expire-scan/status");
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function triggerScan() {
    startTransition(async () => {
      try {
        const result = await apiRequest<RunResult>("admin/expire-scan/run", {
          method: "POST"
        });
        setRunResult(result);
        // Also refresh status after manual run
        const statusData = await apiRequest<ScanStatus>("admin/expire-scan/status");
        setStatus(statusData);
        setError(null);
      } catch (err) {
        setError(getErrorMessage(err));
      }
    });
  }

  function formatDate(iso: string | null | undefined) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("zh-CN", {
      dateStyle: "short",
      timeStyle: "medium"
    });
  }

  return (
    <div className="panel-stack">
      {error ? <div className="notice error">{error}</div> : null}

      {/* Cron schedule info */}
      <div className="surface-grid two-up">
        <article className="glass-panel">
          <div className="panel-stack">
            <div className="section-copy">
              <p className="label">Cron Schedule</p>
              <h3 className="panel-title">自动扫描配置</h3>
              <p className="muted">每小时整点（0 * * * *）自动扫描到期订单并推送移除任务。</p>
            </div>
            <div className="list-stack">
              <div className="list-card">
                <div className="split-head">
                  <span className="muted">执行频率</span>
                  <span className="strong mono">每小时</span>
                </div>
              </div>
              <div className="list-card">
                <div className="split-head">
                  <span className="muted">有效期规则</span>
                  <span className="strong mono">assignedAt + 30 天</span>
                </div>
              </div>
              <div className="list-card">
                <div className="split-head">
                  <span className="muted">幂等保障</span>
                  <span className="strong mono">jobId = expire-{"{orderId}"}</span>
                </div>
              </div>
            </div>
          </div>
        </article>

        <article className="glass-panel">
          <div className="panel-stack">
            <div className="section-copy">
              <p className="label">Scan Status</p>
              <h3 className="panel-title">扫描状态</h3>
              <p className="muted">查看当前待到期订单数量和上次运行记录。</p>
            </div>
            <div className="action-row">
              <button
                className="button secondary"
                onClick={loadStatus}
                type="button"
              >
                查询状态
              </button>
              <button
                className="button"
                disabled={isLoading}
                onClick={triggerScan}
                type="button"
              >
                {isLoading ? "扫描中..." : "立即触发扫描"}
              </button>
            </div>
            {status ? (
              <div className="list-stack">
                <div className="list-card">
                  <div className="split-head">
                    <span className="muted">待到期订单数</span>
                    <span className="strong">{status.pendingCount}</span>
                  </div>
                </div>
                <div className="list-card">
                  <div className="split-head">
                    <span className="muted">上次运行时间</span>
                    <span className="mono">{formatDate(status.lastRunAt)}</span>
                  </div>
                </div>
                <div className="list-card">
                  <div className="split-head">
                    <span className="muted">上次处理数量</span>
                    <span className="strong">{status.lastRunCount}</span>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </article>
      </div>

      {/* Manual run result */}
      {runResult ? (
        <article className="glass-panel">
          <div className="panel-stack">
            <div className="section-copy">
              <p className="label">Run Result</p>
              <h3 className="panel-title">本次扫描结果</h3>
              <p className="muted">
                共处理 <strong>{runResult.processedCount}</strong> 条到期订单。
              </p>
            </div>
            {runResult.orders.length > 0 ? (
              <div className="list-stack">
                {runResult.orders.map((o) => (
                  <div className="list-card" key={o.orderId}>
                    <div className="split-head">
                      <div>
                        <div className="strong mono">{o.orderNo}</div>
                        <div className="muted">{o.userEmail}</div>
                      </div>
                      <span className="status-badge expired">EXPIRED</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">没有需要处理的到期订单。</div>
            )}
          </div>
        </article>
      ) : null}

      {/* Historical expired orders list */}
      <article className="glass-panel">
        <div className="panel-stack">
          <div className="section-copy">
            <p className="label">Expired Orders</p>
            <h3 className="panel-title">历史到期记录</h3>
            <p className="muted">所有已被自动或手动标记为 EXPIRED 的订单。</p>
          </div>
          {expiredOrders.length > 0 ? (
            <div className="list-stack">
              {expiredOrders.map((o) => (
                <div className="list-card" key={o.id}>
                  <div className="split-head">
                    <div>
                      <div className="strong mono">{o.orderNo}</div>
                      <div className="muted">{o.userEmail}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <span className="status-badge expired">EXPIRED</span>
                      <div className="muted" style={{ fontSize: "0.875rem", marginTop: 2 }}>
                        {formatDate(o.updatedAt)}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">还没有到期记录。</div>
          )}
        </div>
      </article>
    </div>
  );
}
