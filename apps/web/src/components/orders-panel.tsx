"use client";

import React from "react";

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

const ORDER_TYPE_LABEL: Record<string, string> = {
  JOIN: "上车",
  SWAP: "换号",
  SUBSCRIPTION: "订阅",
};

export function OrdersPanel({ orders, onReplace, onRetry, role }: OrdersPanelProps) {
  const [filter, setFilter] = useState("");
  const [activeTab, setActiveTab] = useState<"all" | "active" | "manual">("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const PAGE_SIZE = 20;
  const deferredFilter = useDeferredValue(filter);

  async function handleReplace(orderId: string) {
    const targetMemberEmail = window.prompt("要移除的成员邮箱")?.trim().toLowerCase();
    const newUserEmail = window.prompt("新用户邮箱")?.trim().toLowerCase();
    if (!targetMemberEmail || !newUserEmail) return;
    await onReplace({ orderId, targetMemberEmail, newUserEmail });
  }

  const filteredOrders = orders.filter((order) => {
    if (activeTab === "active" && ["INVITE_SENT", "COMPLETED", "FAILED"].includes(order.status)) return false;
    if (activeTab === "manual" && order.status !== "MANUAL_REVIEW") return false;
    const query = deferredFilter.trim().toLowerCase();
    if (!query) return true;
    return (
      order.orderNo.toLowerCase().includes(query) ||
      order.userEmail.toLowerCase().includes(query) ||
      order.status.toLowerCase().includes(query) ||
      order.familyGroup?.groupName?.toLowerCase().includes(query)
    );
  });

  const paginated = filteredOrders.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const totalPages = Math.ceil(filteredOrders.length / PAGE_SIZE);

  function renderDetailRow(order: OrderSummary) {
    return (
      <tr className="detail-expand-row" key={`${order.id}-detail`}>
        <td colSpan={7} style={{ padding: 0 }}>
          <div className="order-detail-card">
            <div className="order-detail-grid">
              <div className="order-detail-item">
                <span className="label">订单ID</span>
                <span className="mono" style={{ fontSize: 12 }}>{order.id}</span>
              </div>
              <div className="order-detail-item">
                <span className="label">订单号</span>
                <span className="strong">{order.orderNo}</span>
              </div>
              <div className="order-detail-item">
                <span className="label">类型</span>
                <span>{(order.orderType && ORDER_TYPE_LABEL[order.orderType]) ?? order.orderType ?? "–"}</span>
              </div>
              <div className="order-detail-item">
                <span className="label">用户邮箱</span>
                <span>{order.userEmail}</span>
              </div>
              <div className="order-detail-item">
                <span className="label">状态</span>
                <StatusBadge value={order.status} />
              </div>
              <div className="order-detail-item">
                <span className="label">家庭组</span>
                <span>{order.familyGroup?.groupName ?? "–"}</span>
              </div>
              <div className="order-detail-item">
                <span className="label">关联任务</span>
                <span>{order._count?.tasks ?? 0} 个</span>
              </div>
              <div className="order-detail-item">
                <span className="label">卡密</span>
                <span className="mono" style={{ fontSize: 12 }}>{order.redeemCode?.code ?? "–"}</span>
              </div>
              {order.resultMessage && (
                <div className="order-detail-item" style={{ gridColumn: "1 / -1" }}>
                  <span className="label">结果消息</span>
                  <span className="muted">{order.resultMessage}</span>
                </div>
              )}
            </div>
          </div>
        </td>
      </tr>
    );
  }

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
              onChange={(e) => { setFilter(e.target.value); setCurrentPage(1); }}
            />
          </div>
        </div>

        <div className="panel-tabs">
          {(["all", "active", "manual"] as const).map((tab) => (
            <button
              key={tab}
              className={`panel-tab${activeTab === tab ? " active" : ""}`}
              onClick={() => { setActiveTab(tab); setCurrentPage(1); }}
              type="button"
            >
              {tab === "all" ? "全部订单" : tab === "active" ? "处理中" : "待人工"}
            </button>
          ))}
        </div>

        <div className="table-wrap workspace-table-wrap">
          <table className="data-table data-table-orders">
            <thead>
              <tr>
                <th>订单号</th>
                <th>类型</th>
                <th>用户邮箱</th>
                <th>状态</th>
                <th>家庭组</th>
                <th>创建时间</th>
                <th style={{ minWidth: 160 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {paginated.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <div className="empty-state">没有匹配的订单。</div>
                  </td>
                </tr>
              ) : (
                <>
                  {paginated.map((order) => {
                    const isExpanded = expandedId === order.id;
                    return (
                      <React.Fragment key={order.id}>
                        <tr className={isExpanded ? "row-expanded" : undefined}>
                          <td>
                            <div className="strong mono" style={{ fontSize: 13 }}>{order.orderNo}</div>
                            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{order._count?.tasks ?? 0} 个任务</div>
                          </td>
                          <td>
                            <span className="order-type-tag">
                              {(order.orderType && ORDER_TYPE_LABEL[order.orderType]) ?? order.orderType ?? "–"}
                            </span>
                          </td>
                          <td><span style={{ fontSize: 13, wordBreak: "break-all" }}>{order.userEmail}</span></td>
                          <td><StatusBadge value={order.status} /></td>
                          <td>{order.familyGroup?.groupName ?? "–"}</td>
                          <td style={{ whiteSpace: "nowrap", fontSize: 13 }}>{formatDateTime(order.createdAt)}</td>
                          <td>
                            <div className="inline-actions" style={{ flexWrap: "nowrap", gap: 6 }}>
                              <button
                                className="button secondary small"
                                onClick={() => setExpandedId(isExpanded ? null : order.id)}
                                type="button"
                                style={{ whiteSpace: "nowrap", padding: "0 10px", minHeight: 32, fontSize: 13 }}
                              >
                                {isExpanded ? "收起" : "查看"}
                              </button>
                              <Link
                                className="button secondary small"
                                href={`/status/${order.orderNo}`}
                                style={{ whiteSpace: "nowrap", padding: "0 10px", minHeight: 32, fontSize: 13 }}
                              >
                                状态页
                              </Link>
                              {canReplaceMember(role) && order.familyGroup ? (
                                <button
                                  className="button secondary small"
                                  onClick={() => void handleReplace(order.id)}
                                  type="button"
                                  style={{ whiteSpace: "nowrap", padding: "0 10px", minHeight: 32, fontSize: 13 }}
                                >
                                  换成员
                                </button>
                              ) : null}
                              {onRetry && (order.status === "MANUAL_REVIEW" || order.status === "FAILED") && (
                                <button
                                  className="button small"
                                  style={{ background: "var(--accent)", color: "#fff", whiteSpace: "nowrap", padding: "0 10px", minHeight: 32, fontSize: 13 }}
                                  onClick={() => void onRetry(order.id)}
                                  type="button"
                                >
                                  重试
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                        {isExpanded && renderDetailRow(order)}
                      </React.Fragment>
                    );
                  })}

                  {/* Pagination */}
                  {totalPages > 1 && (
                    <tr>
                      <td colSpan={7}>
                        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 8, padding: "8px 0" }}>
                          <button className="button secondary small" disabled={currentPage <= 1} onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} type="button" style={{ minWidth: 60, minHeight: 32, fontSize: 13 }}>
                            ← 上页
                          </button>
                          <span style={{ fontSize: "0.85rem" }}>{currentPage} / {totalPages}</span>
                          <button className="button secondary small" disabled={currentPage >= totalPages} onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} type="button" style={{ minWidth: 60, minHeight: 32, fontSize: 13 }}>
                            下页 →
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
