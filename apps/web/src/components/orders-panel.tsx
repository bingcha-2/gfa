"use client";

import Link from "next/link";
import { useDeferredValue, useState } from "react";

import { formatDateTime } from "../lib/format";
import { canReplaceMember } from "../lib/permissions";
import { OrderSummary } from "../lib/types";
import { StatusBadge } from "./status-badge";

type OrdersPanelProps = {
  orders: OrderSummary[];
  role?: string;
  onReplace: (payload: {
    orderId: string;
    targetMemberEmail: string;
    newUserEmail: string;
  }) => Promise<boolean>;
  onRetry?: (orderId: string) => Promise<boolean>;
};

export function OrdersPanel({ orders, onReplace, onRetry, role }: OrdersPanelProps) {
  const [filter, setFilter] = useState("");
  const [activeTab, setActiveTab] = useState<"all" | "active" | "manual">("all");
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 20;
  const deferredFilter = useDeferredValue(filter);

  async function handleReplace(orderId: string) {
    const targetMemberEmail = window.prompt("要移除的成员邮箱")?.trim().toLowerCase();
    const newUserEmail = window.prompt("新用户邮箱")?.trim().toLowerCase();

    if (!targetMemberEmail || !newUserEmail) {
      return;
    }

    await onReplace({
      orderId,
      targetMemberEmail,
      newUserEmail
    });
  }

  const filteredOrders = orders.filter((order) => {
    if (activeTab === "active" && ["INVITE_SENT", "COMPLETED", "FAILED"].includes(order.status)) {
      return false;
    }

    if (activeTab === "manual" && order.status !== "MANUAL_REVIEW") {
      return false;
    }

    const query = deferredFilter.trim().toLowerCase();

    if (!query) {
      return true;
    }

    return (
      order.orderNo.toLowerCase().includes(query) ||
      order.userEmail.toLowerCase().includes(query) ||
      order.status.toLowerCase().includes(query) ||
      order.familyGroup?.groupName?.toLowerCase().includes(query)
    );
  });
  const paginated = filteredOrders.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const totalPages = Math.ceil(filteredOrders.length / PAGE_SIZE);

  return (
    <section id="orders" className="glass-panel">
      <div className="panel-stack">
        <div className="section-head">
          <div className="section-copy">
            <p className="label">订单列表</p>
            <h2 className="panel-title">订单流水</h2>
            <p className="muted">按订单号、邮箱、状态和归属家庭组快速检索。</p>
          </div>

          <div className="filter-row">
            <input
              className="search-field"
              placeholder="筛选订单号 / 邮箱 / 状态"
              value={filter}
              onChange={(event) => { setFilter(event.target.value); setCurrentPage(1); }}
            />
          </div>
        </div>

        <div className="panel-tabs">
          <button
            className={`panel-tab${activeTab === "all" ? " active" : ""}`}
            onClick={() => { setActiveTab("all"); setCurrentPage(1); }}
            type="button"
          >
            全部订单
          </button>
          <button
            className={`panel-tab${activeTab === "active" ? " active" : ""}`}
            onClick={() => { setActiveTab("active"); setCurrentPage(1); }}
            type="button"
          >
            处理中
          </button>
          <button
            className={`panel-tab${activeTab === "manual" ? " active" : ""}`}
            onClick={() => { setActiveTab("manual"); setCurrentPage(1); }}
            type="button"
          >
            待人工
          </button>
        </div>

        <div className="table-wrap workspace-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>订单号</th>
                <th>类型</th>
                <th>用户邮箱</th>
                <th>状态</th>
                <th>家庭组</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {paginated.length ? (<>
                {paginated.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <div className="strong mono">{order.orderNo}</div>
                      <div className="muted">{order._count?.tasks ?? 0} 个关联任务</div>
                    </td>
                    <td>
                      <StatusBadge value={order.orderType === "SWAP" ? "换号" : order.orderType === "SUBSCRIPTION" ? "订阅" : "上车"} />
                    </td>
                    <td>{order.userEmail}</td>
                    <td>
                      <StatusBadge value={order.status} />
                    </td>
                    <td>{order.familyGroup?.groupName ?? "-"}</td>
                    <td>{formatDateTime(order.createdAt)}</td>
                    <td>
                      <div className="inline-actions">
                        <Link className="button secondary small" href={`/status/${order.orderNo}`}>
                          状态页
                        </Link>
                        {canReplaceMember(role) && order.familyGroup ? (
                          <button
                            className="button secondary small"
                            onClick={() => void handleReplace(order.id)}
                            type="button"
                          >
                            更换成员
                          </button>
                        ) : (
                          <span className="muted">只读</span>
                        )}
                        {onRetry && (order.status === "MANUAL_REVIEW" || order.status === "FAILED") && (
                          <button
                            className="button small"
                            style={{ background: "var(--accent)", color: "#fff" }}
                            onClick={() => void onRetry(order.id)}
                            type="button"
                          >
                            重试
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              {/* Pagination */}
              {totalPages > 1 && (
                <tr>
                  <td colSpan={7}>
                  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px', padding: '8px 0' }}>
                    <button className="button secondary small" disabled={currentPage <= 1} onClick={() => setCurrentPage(p => Math.max(1, p - 1))} type="button" style={{ minWidth: 60 }}>← 上页</button>
                    <span style={{ fontSize: '0.85rem' }}>{currentPage} / {totalPages}</span>
                    <button className="button secondary small" disabled={currentPage >= totalPages} onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} type="button" style={{ minWidth: 60 }}>下页 →</button>
                  </div>
                  </td>
                </tr>
              )}
              </>) : (
                <tr>
                  <td colSpan={7}>
                    <div className="empty-state">没有匹配的订单。</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
