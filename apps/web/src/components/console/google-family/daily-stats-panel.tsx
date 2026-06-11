"use client";

import { useState, useEffect } from "react";

import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "./status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type DailyStatsData = {
  date: string;
  importedAccounts: number;
  suspendedAccounts: number;
  verificationAccounts: number;
  transferredMembers: number;
  redeemInvites: number;
  consoleInvites: number;
};

type ConsoleInviteDetail = {
  taskId: string;
  status: string;
  userEmail: string;
  groupName: string;
  account: string;
  createdAt: string;
  finishedAt: string | null;
  source: string | null;
  operator: string;
  operatorEmail: string | null;
};

type TransferDetail = {
  id: string;
  phase: string;
  totalMembers: number;
  memberEmails: string[];
  removedCount: number;
  invitedCount: number;
  createdAt: string;
  sourceGroup: { groupName: string } | null;
  targetGroup: { groupName: string } | null;
};

type RedeemOrderDetail = {
  id: string;
  orderNo: string;
  userEmail: string;
  status: string;
  createdAt: string;
  familyGroup: { groupName: string } | null;
};

type AuditLogDetail = {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  detail: any;
  createdAt: string;
  operatorName: string;
  operatorEmail: string | null;
  operatorRole: string | null;
};

type DailyDetailData = {
  date: string;
  consoleInvites: ConsoleInviteDetail[];
  transfers: TransferDetail[];
  redeemOrders: RedeemOrderDetail[];
  auditLogs: AuditLogDetail[];
};

function todayDateStr(): string {
  const now = new Date();
  const offset = now.getTime() + 8 * 60 * 60 * 1000;
  const local = new Date(offset);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")}`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

type DailyStatsPanelProps = {
  role?: string;
};

export function DailyStatsPanel({ role }: DailyStatsPanelProps = {}) {
  const [date, setDate] = useState(todayDateStr());
  const [stats, setStats] = useState<DailyStatsData | null>(null);
  const [detail, setDetail] = useState<DailyDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [activeDetailTab, setActiveDetailTab] = useState<"consoleInvites" | "transfers" | "redeemOrders" | "auditLogs" | null>(null);

  const isSuperAdmin = role === "SUPER_ADMIN";

  async function loadStats(targetDate: string) {
    setIsLoading(true);
    setError(null);
    try {
      const data = await apiRequest<DailyStatsData>("stats/daily", {
        search: { date: targetDate },
      });
      setStats(data);
    } catch (err) {
      setError(getErrorMessage(err));
      setStats(null);
    } finally {
      setIsLoading(false);
    }
  }

  async function loadDetail(targetDate: string) {
    setIsDetailLoading(true);
    try {
      const data = await apiRequest<DailyDetailData>("stats/daily-detail", {
        search: { date: targetDate },
      });
      setDetail(data);
    } catch (err) {
      // Non-SUPER_ADMIN or other error — silently fail
      setDetail(null);
    } finally {
      setIsDetailLoading(false);
    }
  }

  useEffect(() => {
    loadStats(date);
    if (isSuperAdmin) loadDetail(date);
  }, []);

  function handleDateChange(newDate: string) {
    setDate(newDate);
    setActiveDetailTab(null);
    loadStats(newDate);
    if (isSuperAdmin) loadDetail(newDate);
  }

  function shiftDate(days: number) {
    const current = new Date(date + "T00:00:00");
    current.setDate(current.getDate() + days);
    const shifted = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}-${String(current.getDate()).padStart(2, "0")}`;
    handleDateChange(shifted);
  }

  function handleRefresh() {
    loadStats(date);
    if (isSuperAdmin) loadDetail(date);
  }

  const metrics: { label: string; value: number; description: string; detailTab?: "consoleInvites" | "transfers" | "redeemOrders" }[] = stats
    ? [
        { label: "导入母号", value: stats.importedAccounts, description: "当日新导入的母号数量。" },
        { label: "订阅暂停", value: stats.suspendedAccounts, description: "当日被暂停订阅的母号数量。" },
        { label: "需验证", value: stats.verificationAccounts, description: "当日触发验证（手机/CAPTCHA）的母号数量。" },
        { label: "迁移成员", value: stats.transferredMembers, description: "当日被迁移的家庭组成员总数。", detailTab: "transfers" },
        { label: "卡密邀请", value: stats.redeemInvites, description: "通过卡密兑换产生的邀请订单数量。", detailTab: "redeemOrders" },
        { label: "控制台邀请", value: stats.consoleInvites, description: "通过控制台手动发起的邀请数量。", detailTab: "consoleInvites" },
      ]
    : [];

  function renderDetailSection() {
    if (!isSuperAdmin || !detail) return null;

    if (activeDetailTab === "consoleInvites") {
      const items = detail.consoleInvites;
      return (
        <article className="glass-panel">
          <div className="panel-stack">
            <div className="section-copy">
              <p className="label">明细</p>
              <h2 className="panel-title">控制台邀请明细</h2>
              <p className="muted">当日通过控制台手动发起的邀请记录，共 {items.length} 条。</p>
            </div>
            {items.length > 0 ? (
              <div className="list-stack">
                {items.map((item) => (
                  <div className="list-card" key={item.taskId}>
                    <div className="split-head">
                      <div>
                        <div className="strong">{item.userEmail || "—"}</div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          家庭组: {item.groupName || "—"} · 母号: {item.account || "—"}
                        </div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          操作人: {item.operator}{item.operatorEmail ? ` (${item.operatorEmail})` : ""} · 来源: {item.source || "—"}
                        </div>
                        <div className="muted" style={{ fontSize: 11 }}>
                          {formatTime(item.createdAt)}{item.finishedAt ? ` → ${formatTime(item.finishedAt)}` : ""}
                        </div>
                      </div>
                      <StatusBadge value={item.status} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">当日没有控制台邀请记录。</div>
            )}
          </div>
        </article>
      );
    }

    if (activeDetailTab === "transfers") {
      const items = detail.transfers;
      return (
        <article className="glass-panel">
          <div className="panel-stack">
            <div className="section-copy">
              <p className="label">明细</p>
              <h2 className="panel-title">迁移记录明细</h2>
              <p className="muted">当日的家庭组成员迁移批次，共 {items.length} 批。</p>
            </div>
            {items.length > 0 ? (
              <div className="list-stack">
                {items.map((item) => (
                  <div className="list-card" key={item.id}>
                    <div className="split-head">
                      <div>
                        <div className="strong">
                          {item.sourceGroup?.groupName ?? "—"} → {item.targetGroup?.groupName ?? "—"}
                        </div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          成员: {item.totalMembers} 人 · 已移除: {item.removedCount} · 已邀请: {item.invitedCount}
                        </div>
                        {item.memberEmails.length > 0 && (
                          <div className="muted mono" style={{ fontSize: 11, marginTop: 4 }}>
                            {item.memberEmails.join(", ")}
                          </div>
                        )}
                        <div className="muted" style={{ fontSize: 11 }}>{formatTime(item.createdAt)}</div>
                      </div>
                      <StatusBadge value={item.phase} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">当日没有迁移记录。</div>
            )}
          </div>
        </article>
      );
    }

    if (activeDetailTab === "redeemOrders") {
      const items = detail.redeemOrders;
      return (
        <article className="glass-panel">
          <div className="panel-stack">
            <div className="section-copy">
              <p className="label">明细</p>
              <h2 className="panel-title">卡密邀请明细</h2>
              <p className="muted">当日通过卡密兑换产生的邀请订单，共 {items.length} 条。</p>
            </div>
            {items.length > 0 ? (
              <div className="list-stack">
                {items.map((item) => (
                  <div className="list-card" key={item.id}>
                    <div className="split-head">
                      <div>
                        <div className="strong mono">{item.orderNo}</div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {item.userEmail} · 家庭组: {item.familyGroup?.groupName ?? "—"}
                        </div>
                        <div className="muted" style={{ fontSize: 11 }}>{formatTime(item.createdAt)}</div>
                      </div>
                      <StatusBadge value={item.status} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">当日没有卡密邀请记录。</div>
            )}
          </div>
        </article>
      );
    }

    if (activeDetailTab === "auditLogs") {
      const items = detail.auditLogs;
      return (
        <article className="glass-panel">
          <div className="panel-stack">
            <div className="section-copy">
              <p className="label">明细</p>
              <h2 className="panel-title">操作日志</h2>
              <p className="muted">当日所有操作审计记录，共 {items.length} 条。</p>
            </div>
            {items.length > 0 ? (
              <div className="list-stack">
                {items.map((item) => (
                  <div className="list-card" key={item.id}>
                    <div className="split-head">
                      <div>
                        <div className="strong">{item.action}</div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {item.targetType}: {item.targetId}
                        </div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          操作人: {item.operatorName}{item.operatorEmail ? ` (${item.operatorEmail})` : ""}{item.operatorRole ? ` [${item.operatorRole}]` : ""}
                        </div>
                        {item.detail && typeof item.detail === "object" && (
                          <div className="muted mono" style={{ fontSize: 11, marginTop: 2, wordBreak: "break-all" }}>
                            {(() => {
                              const d = item.detail;
                              const parts: string[] = [];
                              if (d.memberEmail) parts.push(`邮箱: ${d.memberEmail}`);
                              if (d.taskId) parts.push(`任务: ${d.taskId.slice(0, 12)}…`);
                              if (d.groupName) parts.push(`组: ${d.groupName}`);
                              if (d.count !== undefined) parts.push(`数量: ${d.count}`);
                              return parts.length > 0 ? parts.join(" · ") : JSON.stringify(d).slice(0, 120);
                            })()}
                          </div>
                        )}
                        <div className="muted" style={{ fontSize: 11 }}>{formatTime(item.createdAt)}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">当日没有操作日志。</div>
            )}
          </div>
        </article>
      );
    }

    return null;
  }

  return (
    <div className="panel-stack">
      {/* Date selector */}
      <article className="glass-panel">
        <div className="panel-stack">
          <div className="section-copy">
            <p className="label">Daily Summary</p>
            <h2 className="panel-title">每日数据汇总</h2>
            <p className="muted">查看指定日期的运营核心指标，默认展示今日数据。{isSuperAdmin ? " 点击指标卡片可查看明细。" : ""}</p>
          </div>

          <div className="action-row" style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <Button
              variant="outline"
              onClick={() => shiftDate(-1)}
              type="button"
              style={{ minWidth: "36px" }}
            >
              ←
            </Button>
            <Input
              type="date"
              className="mono w-auto"
              value={date}
              max={todayDateStr()}
              onChange={(e) => handleDateChange(e.target.value)}
            />
            <Button
              variant="outline"
              onClick={() => shiftDate(1)}
              type="button"
              disabled={date >= todayDateStr()}
              style={{ minWidth: "36px" }}
            >
              →
            </Button>
            <Button
              variant="outline"
              onClick={() => handleDateChange(todayDateStr())}
              type="button"
              disabled={date === todayDateStr()}
            >
              今日
            </Button>
            <Button
              variant="outline"
              onClick={handleRefresh}
              type="button"
              disabled={isLoading}
            >
              {isLoading ? (
                <><Spinner size={14} color="currentColor" /> 加载中...</>
              ) : "刷新"}
            </Button>
          </div>
        </div>
      </article>

      {error ? <div className="notice error">{error}</div> : null}

      {/* Metrics grid */}
      {stats ? (
        <section className="surface-grid three-up">
          {metrics.map((m) => (
            <article
              className="glass-panel"
              key={m.label}
              style={isSuperAdmin && m.detailTab ? { cursor: "pointer", transition: "border-color 0.15s" } : undefined}
              onClick={isSuperAdmin && m.detailTab ? () => setActiveDetailTab(activeDetailTab === m.detailTab ? null : m.detailTab!) : undefined}
            >
              <div className="panel-stack" style={{ gap: "4px" }}>
                <p className="label" style={isSuperAdmin && m.detailTab ? { display: "flex", justifyContent: "space-between", alignItems: "center" } : undefined}>
                  {m.label}
                  {isSuperAdmin && m.detailTab && (
                    <span style={{ fontSize: 10, opacity: 0.6 }}>
                      {activeDetailTab === m.detailTab ? "▲ 收起" : "▼ 明细"}
                    </span>
                  )}
                </p>
                <div className="strong" style={{ fontSize: "28px", fontVariantNumeric: "tabular-nums" }}>
                  {m.value}
                </div>
                <p className="muted" style={{ fontSize: "12px" }}>{m.description}</p>
              </div>
            </article>
          ))}
        </section>
      ) : !isLoading && !error ? (
        <div className="empty-state">暂无数据</div>
      ) : null}

      {isLoading && !stats ? (
        <div className="empty-state" style={{ display: "flex", alignItems: "center", gap: "8px", justifyContent: "center" }}>
          <Spinner size={16} color="currentColor" /> 正在加载 {date} 的数据...
        </div>
      ) : null}

      {/* Detail tabs for SUPER_ADMIN */}
      {isSuperAdmin && stats && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button
            variant={activeDetailTab === "auditLogs" ? "default" : "outline"}
            onClick={() => setActiveDetailTab(activeDetailTab === "auditLogs" ? null : "auditLogs")}
            type="button"
          >
            📋 操作日志
          </Button>
        </div>
      )}

      {/* Detail loading */}
      {isDetailLoading && activeDetailTab && (
        <div className="empty-state" style={{ display: "flex", alignItems: "center", gap: "8px", justifyContent: "center" }}>
          <Spinner size={16} color="currentColor" /> 加载明细...
        </div>
      )}

      {/* Detail content */}
      {renderDetailSection()}
    </div>
  );
}
