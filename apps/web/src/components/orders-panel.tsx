"use client";

import React from "react";

import Link from "next/link";
import { useState, useEffect, useCallback } from "react";

import { formatDateTime } from "../lib/format";
import { canReplaceMember } from "../lib/permissions";
import { OrderSummary } from "../lib/types";
import { apiRequest, getErrorMessage } from "../lib/client-api";
import { StatusBadge } from "./status-badge";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** Check if an order was cancelled by the scheduler (not a real failure) */
function isSchedulerCancelled(order: OrderSummary): boolean {
  if (order.status !== "FAILED" || !order.resultMessage) return false;
  return (
    order.resultMessage.startsWith("重复取消") ||
    order.resultMessage.startsWith("定时取消")
  );
}

/** Render the appropriate badge for an order */
function OrderStatusBadge({ order }: { order: OrderSummary }) {
  if (isSchedulerCancelled(order)) {
    const label = order.resultMessage!.startsWith("重复取消") ? "重复清理" : "定时清理";
    return (
      <Badge variant="secondary">{label}</Badge>
    );
  }
  return <StatusBadge value={order.status} />;
}

type OrdersPanelProps = {
  role?: string;
  showToast?: (type: "success" | "error" | "info", msg: string) => void;
};

const ORDER_TYPE_LABEL: Record<string, string> = {
  JOIN: "上车",
  SWAP: "换号",
  SUBSCRIPTION: "订阅",
};

const PAGE_SIZE = 50;

export function OrdersPanel({ role, showToast }: OrdersPanelProps) {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [filter, setFilter] = useState("");
  const [activeTab, setActiveTab] = useState<"all" | "active" | "manual">("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const getStatusParam = useCallback(() => {
    if (activeTab === "manual") return "MANUAL_REVIEW";
    // "active" tab filters client-side (excludes terminal statuses)
    return undefined;
  }, [activeTab]);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const status = getStatusParam();
      const params = new URLSearchParams();
      params.set("page", String(currentPage));
      params.set("pageSize", String(PAGE_SIZE));
      if (status) params.set("status", status);
      const res = await apiRequest<{ items: OrderSummary[]; total: number }>(`orders?${params.toString()}`);
      setOrders(res.items);
      setTotalItems(res.total);
    } catch (err) {
      console.error("Failed to load orders:", err);
    } finally {
      setIsLoading(false);
    }
  }, [currentPage, activeTab, getStatusParam]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const totalPages = Math.ceil(totalItems / PAGE_SIZE);

  async function handleReplace(orderId: string) {
    const targetMemberEmail = window.prompt("要移除的成员邮箱")?.trim().toLowerCase();
    const newUserEmail = window.prompt("新用户邮箱")?.trim().toLowerCase();
    if (!targetMemberEmail || !newUserEmail) return;
    try {
      await apiRequest(`orders/${orderId}/replace-member`, {
        method: "POST",
        body: { targetMemberEmail, newUserEmail },
      });
      showToast?.("success", "替换任务已提交");
      await loadData();
    } catch (err) {
      showToast?.("error", getErrorMessage(err));
    }
  }

  async function handleRetry(orderId: string) {
    try {
      await apiRequest(`orders/${orderId}/retry`, { method: "POST" });
      showToast?.("success", "订单重试已提交");
      await loadData();
    } catch (err) {
      showToast?.("error", getErrorMessage(err));
    }
  }

  // Client-side filtering for search and "active" tab
  const displayOrders = orders.filter((order) => {
    if (activeTab === "active" && ["INVITE_SENT", "COMPLETED", "FAILED"].includes(order.status)) return false;
    const query = filter.trim().toLowerCase();
    if (!query) return true;
    return (
      order.orderNo.toLowerCase().includes(query) ||
      order.userEmail.toLowerCase().includes(query) ||
      order.status.toLowerCase().includes(query) ||
      order.familyGroup?.groupName?.toLowerCase().includes(query)
    );
  });

  function renderDetailRow(order: OrderSummary) {
    const swaps = order.swapRecords ?? [];
    const hasSwaps = swaps.length > 0;
    const isSwapType = order.orderType === "SWAP" || order.orderType === "SUBSCRIPTION";

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

            {/* Swap History */}
            {isSwapType && (
              <div className="swap-history-section">
                <div className="swap-history-header">
                  <span className="label">换号记录</span>
                  <span className="muted" style={{ fontSize: 12 }}>
                    共 {swaps.length} 次
                  </span>
                </div>
                {hasSwaps ? (
                  <div className="swap-history-list">
                    {swaps.map((swap, idx) => (
                      <div className="swap-history-item" key={swap.id}>
                        <div className="swap-history-index">#{swaps.length - idx}</div>
                        <div className="swap-history-body">
                          <div className="swap-history-emails">
                            <span className="mono" style={{ fontSize: 12 }}>{swap.oldEmail}</span>
                            <span className="swap-arrow">→</span>
                            <span className="mono" style={{ fontSize: 12 }}>{swap.newEmail}</span>
                          </div>
                          <div className="swap-history-meta">
                            <StatusBadge value={swap.status} />
                            <span className="muted" style={{ fontSize: 11 }}>
                              {formatDateTime(swap.createdAt)}
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="muted" style={{ fontSize: 13, padding: "8px 0" }}>暂无换号记录</div>
                )}
              </div>
            )}
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
          <div className="filter-row" style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <Input
              className="search-field"
              placeholder="筛选订单号 / 邮箱 / 状态"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={loadData}
              disabled={isLoading}
              type="button"
            >
              {isLoading ? "刷新中..." : "刷新"}
            </Button>
          </div>
        </div>

        <div style={{ fontSize: '0.875rem', color: 'var(--foreground-muted, #737373)', marginBottom: '2px' }}>
          共 {totalItems} 条
          {totalPages > 0 && ` · 第 ${currentPage}/${totalPages} 页`}
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

        <div className="table-wrap workspace-table-wrap" style={{ minHeight: '200px', position: 'relative' }}>
          {isLoading && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)', zIndex: 10 }}>
              <Spinner />
            </div>
          )}
          <Table className="data-table data-table-orders">
            <TableHeader>
              <TableRow>
                <TableHead>订单号</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>用户邮箱</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>家庭组</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead style={{ minWidth: 160 }}>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayOrders.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7}>
                    <div className="empty-state">没有匹配的订单。</div>
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {displayOrders.map((order) => {
                    const isExpanded = expandedId === order.id;
                    return (
                      <React.Fragment key={order.id}>
                        <TableRow className={isExpanded ? "row-expanded" : undefined}>
                          <TableCell>
                            <div className="strong mono" style={{ fontSize: 13 }}>{order.orderNo}</div>
                            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{order._count?.tasks ?? 0} 个任务</div>
                          </TableCell>
                          <TableCell>
                            <span className="order-type-tag">
                              {(order.orderType && ORDER_TYPE_LABEL[order.orderType]) ?? order.orderType ?? "–"}
                            </span>
                          </TableCell>
                          <TableCell><span style={{ fontSize: 13, wordBreak: "break-all" }}>{order.userEmail}</span></TableCell>
                          <TableCell><OrderStatusBadge order={order} /></TableCell>
                          <TableCell>{order.familyGroup?.groupName ?? "–"}</TableCell>
                          <TableCell style={{ whiteSpace: "nowrap", fontSize: 13 }}>{formatDateTime(order.createdAt)}</TableCell>
                          <TableCell>
                            <div className="inline-actions" style={{ flexWrap: "nowrap", gap: 6 }}>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setExpandedId(isExpanded ? null : order.id)}
                                type="button"
                              >
                                {isExpanded ? "收起" : "查看"}
                              </Button>
                              <Link
                                className="button secondary small"
                                href={`/status/${order.orderNo}`}
                                style={{ whiteSpace: "nowrap", padding: "0 10px", minHeight: 32, fontSize: 13 }}
                              >
                                状态页
                              </Link>
                              {canReplaceMember(role) && order.familyGroup ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => void handleReplace(order.id)}
                                  type="button"
                                >
                                  换成员
                                </Button>
                              ) : null}
                              {(order.status === "MANUAL_REVIEW" || order.status === "FAILED") && (
                                <Button
                                  size="sm"
                                  onClick={() => void handleRetry(order.id)}
                                  type="button"
                                >
                                  重试
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                        {isExpanded && renderDetailRow(order)}
                      </React.Fragment>
                    );
                  })}

                  {/* Pagination */}
                  {totalPages > 1 && (
                    <TableRow>
                      <TableCell colSpan={7}>
                        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 4, padding: "8px 0", flexWrap: "wrap" }}>
                          <Button variant="outline" size="sm" disabled={currentPage <= 1 || isLoading} onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} type="button">
                            ← 上页
                          </Button>
                          {(() => {
                            const pages: (number | string)[] = [];
                            const delta = 2;
                            for (let i = 1; i <= totalPages; i++) {
                              if (i === 1 || i === totalPages || (i >= currentPage - delta && i <= currentPage + delta)) {
                                pages.push(i);
                              } else if (pages.length > 0 && pages[pages.length - 1] !== '...') {
                                pages.push('...');
                              }
                            }
                            return pages.map((p, idx) =>
                              p === '...' ? (
                                <span key={`ellipsis-${idx}`} style={{ padding: '0 4px', color: 'var(--foreground-muted, #a3a3a3)', fontSize: '0.85rem' }}>…</span>
                              ) : (
                                <Button
                                  key={p}
                                  variant={p === currentPage ? "default" : "outline"}
                                  size="sm"
                                  disabled={isLoading}
                                  onClick={() => setCurrentPage(p as number)}
                                  type="button"
                                  style={{ minWidth: 32 }}
                                >
                                  {p}
                                </Button>
                              )
                            );
                          })()}
                          <Button variant="outline" size="sm" disabled={currentPage >= totalPages || isLoading} onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} type="button">
                            下页 →
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </section>
  );
}
