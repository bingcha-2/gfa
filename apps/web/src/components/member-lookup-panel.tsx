"use client";

import { useState } from "react";
import { apiRequest, getErrorMessage } from "../lib/client-api";
import { ConfirmButton } from "./confirm-button";
import { StatusBadge } from "./status-badge";
import { Spinner } from "./spinner";

type LookupResult = {
  found: boolean;
  error?: string;
  memberStatus?: string;
  member?: {
    id: string;
    displayName: string | null;
    joinedAt: string | null;
    expiresAt: string | null;
  };
  familyGroup?: {
    id: string;
    groupName: string;
    accountEmail: string | null;
    status: string;
    memberCount: number;
    maxMembers: number;
  };
  order?: {
    id: string;
    orderNo: string;
    status: string;
    code: string | null;
    codeType: string | null;
    expiresAt: string | null;
    createdAt: string;
  };
};

type TimelineEvent = {
  time: string;
  category: "task" | "order" | "swap" | "member";
  type: string;
  status: string;
  source: string;
  detail: string;
  groupName: string | null;
  extra?: Record<string, any>;
};

type TimelineData = {
  email: string;
  totalEvents: number;
  summary: { tasks: number; orders: number; swaps: number; memberRecords: number };
  timeline: TimelineEvent[];
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function isExpired(iso: string | null | undefined): boolean {
  if (!iso) return false;
  return new Date(iso) < new Date();
}

const RETRYABLE_ORDER_STATUSES = new Set(["MANUAL_REVIEW", "FAILED"]);

const CODE_TYPE_LABELS: Record<string, string> = {
  JOIN_GROUP: "加入家庭组",
  ACCOUNT_SWAP: "账号换绑",
};

const CATEGORY_ICON: Record<string, string> = {
  task: "⚙️",
  order: "📦",
  swap: "🔀",
  member: "👤",
};

const CATEGORY_LABEL: Record<string, string> = {
  task: "任务",
  order: "订单",
  swap: "换号",
  member: "成员",
};

const TYPE_ICON: Record<string, string> = {
  REPLACE_MEMBER: "🔄",
  INVITE_MEMBER: "📨",
  REMOVE_MEMBER: "⛔",
  ACCEPT_INVITE: "✉️",
  SYNC_FAMILY_GROUP: "🔃",
  SWAP: "🔀",
  MEMBER_RECORD: "📋",
  MEMBER_REMOVED: "❌",
  JOIN: "🎫",
  SUBSCRIPTION: "💳",
};

function getStatusColor(status: string): string {
  if (status.includes("SENT") || status === "REPLACED_AND_INVITE_SENT" || status === "SUCCESS" || status === "COMPLETED" || status === "ACTIVE") return "#4ade80";
  if (status.includes("FAIL") || status === "REMOVED") return "#f87171";
  if (status === "PENDING" || status === "CANCELLED") return "#fbbf24";
  return "#94a3b8";
}

function getSourceLabel(source: string): { text: string; color: string } {
  switch (source) {
    case "manual": return { text: "手动", color: "#fbbf24" };
    case "auto": return { text: "自动", color: "#60a5fa" };
    case "webhook": return { text: "Webhook", color: "#a78bfa" };
    case "scheduler": return { text: "定时", color: "#34d399" };
    case "system": return { text: "系统", color: "#94a3b8" };
    case "record": return { text: "记录", color: "#64748b" };
    default: return { text: source, color: "#94a3b8" };
  }
}

type MemberLookupPanelProps = {
  onRemoveMember?: (groupId: string, memberEmail: string) => Promise<{ taskId: string } | null>;
  onRetryOrder?: (orderId: string) => Promise<boolean | undefined>;
  onReplaceMember?: (payload: { orderId: string; targetMemberEmail: string; newUserEmail: string }) => Promise<boolean | undefined>;
  showToast?: (type: "success" | "error" | "info", msg: string) => void;
};

export function MemberLookupPanel({
  onRemoveMember,
  onRetryOrder,
  onReplaceMember,
  showToast,
}: MemberLookupPanelProps) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showReplaceInput, setShowReplaceInput] = useState(false);
  const [replaceEmail, setReplaceEmail] = useState("");

  // Timeline state
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineData, setTimelineData] = useState<TimelineData | null>(null);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [timelineFilter, setTimelineFilter] = useState<string>("all");

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = email.trim();
    if (!q) return;

    setLoading(true);
    setError(null);
    setResult(null);
    setTimelineOpen(false);
    setTimelineData(null);
    setTimelineError(null);

    try {
      const data = await apiRequest<LookupResult>(
        `family-groups/lookup-by-member?email=${encodeURIComponent(q)}`
      );
      setResult(data);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function fetchTimeline() {
    const q = email.trim();
    if (!q) return;

    setTimelineLoading(true);
    setTimelineError(null);

    try {
      const data = await apiRequest<TimelineData>(
        `family-groups/member-timeline?email=${encodeURIComponent(q)}`
      );
      setTimelineData(data);
    } catch (err) {
      setTimelineError(getErrorMessage(err));
    } finally {
      setTimelineLoading(false);
    }
  }

  function handleToggleTimeline() {
    if (!timelineOpen && !timelineData) {
      fetchTimeline();
    }
    setTimelineOpen(!timelineOpen);
  }

  async function handleRemoveMember() {
    if (!result?.familyGroup || !onRemoveMember) return;
    const q = email.trim();

    setActionLoading("remove");
    try {
      const ok = await onRemoveMember(result.familyGroup.id, q);
      if (ok) {
        showToast?.("success", `已提交移除任务: ${q}`);
        handleSearch({ preventDefault: () => {} } as React.FormEvent);
      }
    } catch (err) {
      showToast?.("error", getErrorMessage(err));
    } finally {
      setActionLoading(null);
    }
  }

  async function handleRetryOrder() {
    if (!result?.order || !onRetryOrder) return;

    setActionLoading("retry");
    try {
      const ok = await onRetryOrder(result.order.id);
      if (ok) {
        showToast?.("success", `已提交重试: ${result.order.orderNo}`);
        handleSearch({ preventDefault: () => {} } as React.FormEvent);
      }
    } catch (err) {
      showToast?.("error", getErrorMessage(err));
    } finally {
      setActionLoading(null);
    }
  }

  async function handleReplace() {
    if (!result?.order || !onReplaceMember) return;
    const newEmail = replaceEmail.trim().toLowerCase();
    if (!newEmail) return;
    const oldEmail = email.trim().toLowerCase();
    if (newEmail === oldEmail) {
      showToast?.("error", "新邮箱不能与原邮箱相同");
      return;
    }

    setActionLoading("replace");
    try {
      const ok = await onReplaceMember({
        orderId: result.order.id,
        targetMemberEmail: oldEmail,
        newUserEmail: newEmail
      });
      if (ok) {
        showToast?.("success", `替换任务已提交: ${oldEmail} → ${newEmail}`);
        setShowReplaceInput(false);
        setReplaceEmail("");
        handleSearch({ preventDefault: () => {} } as React.FormEvent);
      }
    } catch (err) {
      showToast?.("error", getErrorMessage(err));
    } finally {
      setActionLoading(null);
    }
  }

  const expired = result?.order ? isExpired(result.order.expiresAt) : false;

  const filteredTimeline = timelineData?.timeline.filter(ev =>
    timelineFilter === "all" || ev.category === timelineFilter
  ) ?? [];

  return (
    <div className="panel-stack">
      {/* Search form */}
      <form className="glass-panel" onSubmit={handleSearch} style={{ padding: "1.25rem 1.5rem" }}>
        <div className="section-copy" style={{ marginBottom: "1rem" }}>
          <p className="label">Member Management</p>
          <h2 className="panel-title">成员管理</h2>
          <p className="muted">输入客户邮箱，查看完整信息并执行管理操作。</p>
        </div>

        <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <label className="label" htmlFor="lookup-email" style={{ display: "block", marginBottom: "0.375rem" }}>
              邮箱地址
            </label>
            <input
              id="lookup-email"
              type="email"
              className="input"
              placeholder="customer@gmail.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              autoComplete="off"
              style={{ width: "100%" }}
            />
          </div>
          <button
            type="submit"
            className="button"
            disabled={loading || !email.trim()}
            style={{ minWidth: 110, gap: 8, display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            {loading ? <><Spinner size={14} color="currentColor" /> 查询中…</> : "查询"}
          </button>
        </div>
      </form>

      {/* Error state */}
      {error && (
        <div className="notice error">{error}</div>
      )}

      {/* Results */}
      {result && (
        <div className="glass-panel" style={{ padding: "1.25rem 1.5rem" }}>
          {!result.found ? (
            <div className="empty-state" style={{ textAlign: "center", padding: "2rem" }}>
              <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>🔍</div>
              <p className="strong">未找到该邮箱的记录</p>
              <p className="muted" style={{ marginTop: "0.25rem" }}>
                {email} 不在任何家庭组中，或尚未兑换卡密。
              </p>
            </div>
          ) : (
            <div className="panel-stack">
              {/* Header with status and actions */}
              <div className="split-head">
                <div>
                  <p className="label">查询结果</p>
                  <h3 className="panel-title" style={{ fontSize: "1rem" }}>{email}</h3>
                  {result.member?.displayName && (
                    <p className="muted" style={{ marginTop: "0.15rem" }}>
                      {result.member.displayName}
                    </p>
                  )}
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.25rem" }}>
                  <StatusBadge
                    value={
                      result.memberStatus === "NO_MEMBER_RECORD" ? "PENDING"
                      : result.memberStatus === "ACTIVE" ? "ACTIVE"
                      : result.memberStatus ?? "UNKNOWN"
                    }
                  />
                  {result.memberStatus === "NO_MEMBER_RECORD" && (
                    <span style={{ fontSize: "0.85rem", color: "var(--amber, #fbbf24)" }}>
                      ⚠ 有订单但尚未入组
                    </span>
                  )}
                  {result.member?.joinedAt && (
                    <span className="muted" style={{ fontSize: "0.85rem" }}>
                      加入时间：{formatDate(result.member.joinedAt)}
                    </span>
                  )}
                  {result.member?.expiresAt && (
                    <span
                      style={{
                        fontSize: "0.85rem",
                        fontWeight: 600,
                        color: isExpired(result.member.expiresAt) ? "var(--red, #f87171)" : "var(--green, #4ade80)"
                      }}
                    >
                      到期时间：{formatDate(result.member.expiresAt)}
                      {isExpired(result.member.expiresAt) && " ⚠ 已到期"}
                    </span>
                  )}
                </div>
              </div>

              {/* Action buttons bar */}
              <div style={{
                display: "flex",
                gap: "0.5rem",
                flexWrap: "wrap",
                padding: "0.5rem 0",
                borderTop: "1px solid rgba(255,255,255,0.06)",
                borderBottom: "1px solid rgba(255,255,255,0.06)"
              }}>
                {result.familyGroup && (result.memberStatus === "ACTIVE" || result.memberStatus === "PENDING") && onRemoveMember && (
                  <ConfirmButton
                    className="button"
                    onConfirm={handleRemoveMember}
                    confirmLabel="确定移除？"
                    loadingLabel={<><Spinner size={12} color="currentColor" /> 移除中…</>}
                    disabled={actionLoading !== null}
                    style={{
                      fontSize: "0.85rem",
                      padding: "0.4rem 0.75rem",
                      gap: 6,
                      display: "flex",
                      alignItems: "center",
                      background: "rgba(239,68,68,0.15)",
                      borderColor: "rgba(239,68,68,0.3)",
                      color: "#f87171"
                    }}
                  >
                    ⛔ 移除成员
                  </ConfirmButton>
                )}

                {result.order && RETRYABLE_ORDER_STATUSES.has(result.order.status) && onRetryOrder && (
                  <ConfirmButton
                    className="button"
                    onConfirm={handleRetryOrder}
                    confirmLabel="确定重试？"
                    loadingLabel={<><Spinner size={12} color="currentColor" /> 重试中…</>}
                    disabled={actionLoading !== null}
                    style={{
                      fontSize: "0.85rem",
                      padding: "0.4rem 0.75rem",
                      gap: 6,
                      display: "flex",
                      alignItems: "center",
                      background: "rgba(251,191,36,0.15)",
                      borderColor: "rgba(251,191,36,0.3)",
                      color: "#fbbf24"
                    }}
                  >
                    🔄 重试订单
                  </ConfirmButton>
                )}

                {result.order && onReplaceMember && (
                  <button
                    className="button"
                    onClick={() => { setShowReplaceInput(!showReplaceInput); setReplaceEmail(""); }}
                    disabled={actionLoading !== null}
                    style={{
                      fontSize: "0.85rem",
                      padding: "0.4rem 0.75rem",
                      gap: 6,
                      display: "flex",
                      alignItems: "center",
                      background: showReplaceInput ? "rgba(139,92,246,0.25)" : "rgba(139,92,246,0.15)",
                      borderColor: "rgba(139,92,246,0.3)",
                      color: "#a78bfa"
                    }}
                  >
                    {actionLoading === "replace" ? <Spinner size={12} color="currentColor" /> : "🔀"}
                    替换成员
                  </button>
                )}
              </div>

              {/* Replace member inline input */}
              {showReplaceInput && result.order && (
                <div style={{
                  display: "flex",
                  gap: "0.5rem",
                  alignItems: "flex-end",
                  padding: "0.75rem",
                  background: "rgba(139,92,246,0.06)",
                  borderRadius: "0.5rem",
                  border: "1px solid rgba(139,92,246,0.15)"
                }}>
                  <div style={{ flex: 1 }}>
                    <label className="label" htmlFor="replace-new-email" style={{ display: "block", marginBottom: "0.25rem", fontSize: "0.85rem" }}>
                      新成员邮箱
                    </label>
                    <input
                      id="replace-new-email"
                      type="email"
                      placeholder="new-member@gmail.com"
                      value={replaceEmail}
                      onChange={(e) => setReplaceEmail(e.target.value)}
                      disabled={actionLoading !== null}
                      autoComplete="off"
                      style={{ width: "100%" }}
                    />
                  </div>
                  <ConfirmButton
                    className="button"
                    onConfirm={handleReplace}
                    confirmLabel="确定替换？"
                    loadingLabel={<><Spinner size={12} color="currentColor" /> 提交中…</>}
                    disabled={actionLoading !== null || !replaceEmail.trim()}
                    style={{
                      minWidth: 90,
                      gap: 6,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "rgba(139,92,246,0.2)",
                      borderColor: "rgba(139,92,246,0.4)",
                      color: "#a78bfa",
                      fontSize: "0.85rem"
                    }}
                  >
                    确认替换
                  </ConfirmButton>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => { setShowReplaceInput(false); setReplaceEmail(""); }}
                    disabled={actionLoading !== null}
                    style={{ fontSize: "0.85rem", padding: "0.4rem 0.6rem" }}
                  >
                    取消
                  </button>
                </div>
              )}

              {/* Info cards grid */}
              <div className="surface-grid two-up" style={{ gap: "1rem" }}>

                {/* Family Group card */}
                <div className="list-card" style={{ padding: "1rem 1.25rem" }}>
                  <p className="label" style={{ marginBottom: "0.5rem" }}>家庭组</p>
                  {result.familyGroup ? (
                    <div className="panel-stack" style={{ gap: "0.375rem" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                        <span className="strong">{result.familyGroup.groupName}</span>
                        <StatusBadge value={result.familyGroup.status} />
                      </div>
                      {result.familyGroup.accountEmail && (
                        <div className="muted mono" style={{ fontSize: "0.85rem" }}>
                          母号：{result.familyGroup.accountEmail}
                        </div>
                      )}
                      <div className="muted" style={{ fontSize: "0.85rem" }}>
                        成员：{result.familyGroup.memberCount} / {result.familyGroup.maxMembers}
                      </div>
                    </div>
                  ) : (
                    <span className="muted">— 未关联家庭组</span>
                  )}
                </div>

                {/* Order / code card */}
                <div className="list-card" style={{ padding: "1rem 1.25rem" }}>
                  <p className="label" style={{ marginBottom: "0.5rem" }}>订单 / 卡密</p>
                  {result.order ? (
                    <div className="panel-stack" style={{ gap: "0.375rem" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                        <span className="strong mono">{result.order.orderNo}</span>
                        <StatusBadge value={result.order.status} />
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                        <span className="muted">卡密：</span>
                        {result.order.code ? (
                          <code
                            style={{
                              background: "rgba(255,255,255,0.07)",
                              padding: "0.15rem 0.5rem",
                              borderRadius: "0.3rem",
                              fontSize: "0.9rem",
                              fontFamily: "monospace",
                              letterSpacing: "0.05em"
                            }}
                          >
                            {result.order.code}
                          </code>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </div>
                      {result.order.codeType && (
                        <div style={{ fontSize: "0.85rem" }}>
                          <span className="muted">类型：</span>
                          <span>{CODE_TYPE_LABELS[result.order.codeType] ?? result.order.codeType}</span>
                        </div>
                      )}
                      <div style={{ fontSize: "0.85rem" }}>
                        <span className="muted">创建时间：</span>
                        <span>{formatDateTime(result.order.createdAt)}</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                        <span className="muted">到期时间：</span>
                        {result.order.expiresAt ? (
                          <span
                            style={{
                              fontWeight: 600,
                              color: expired ? "var(--red, #f87171)" : "var(--green, #4ade80)"
                            }}
                          >
                            {formatDate(result.order.expiresAt)}
                            {expired && " ⚠ 已到期"}
                          </span>
                        ) : (
                          <span className="muted">— 未设置</span>
                        )}
                      </div>
                    </div>
                  ) : (
                    <span className="muted">— 未找到关联订单</span>
                  )}
                </div>
              </div>

              {/* ===== Timeline Section ===== */}
              <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: "0.75rem" }}>
                <button
                  type="button"
                  onClick={handleToggleTimeline}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#60a5fa",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    fontSize: "0.9rem",
                    fontWeight: 600,
                    padding: "0.375rem 0",
                    width: "100%",
                  }}
                >
                  <span style={{
                    display: "inline-block",
                    transition: "transform 0.2s",
                    transform: timelineOpen ? "rotate(90deg)" : "rotate(0deg)"
                  }}>▶</span>
                  📜 操作时间线
                  {timelineData && (
                    <span style={{ fontWeight: 400, color: "#94a3b8", fontSize: "0.8rem" }}>
                      ({timelineData.totalEvents} 条记录)
                    </span>
                  )}
                  {timelineLoading && <Spinner size={12} color="#60a5fa" />}
                </button>

                {timelineOpen && (
                  <div style={{ marginTop: "0.75rem" }}>
                    {timelineError && (
                      <div className="notice error" style={{ fontSize: "0.85rem" }}>{timelineError}</div>
                    )}

                    {timelineData && (
                      <>
                        {/* Summary filter badges */}
                        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
                          {(["all", "task", "order", "swap", "member"] as const).map(cat => {
                            const count = cat === "all"
                              ? timelineData.totalEvents
                              : cat === "task" ? timelineData.summary.tasks
                              : cat === "order" ? timelineData.summary.orders
                              : cat === "swap" ? timelineData.summary.swaps
                              : timelineData.summary.memberRecords;
                            const isActive = timelineFilter === cat;
                            return (
                              <button
                                key={cat}
                                type="button"
                                onClick={() => setTimelineFilter(cat)}
                                style={{
                                  padding: "0.25rem 0.6rem",
                                  fontSize: "0.8rem",
                                  borderRadius: "999px",
                                  border: `1px solid ${isActive ? "rgba(96,165,250,0.5)" : "rgba(255,255,255,0.1)"}`,
                                  background: isActive ? "rgba(96,165,250,0.15)" : "rgba(255,255,255,0.04)",
                                  color: isActive ? "#60a5fa" : "#94a3b8",
                                  cursor: "pointer",
                                  fontWeight: isActive ? 600 : 400,
                                  transition: "all 0.15s",
                                }}
                              >
                                {cat === "all" ? "全部" : `${CATEGORY_ICON[cat] || ""} ${CATEGORY_LABEL[cat] || cat}`} {count}
                              </button>
                            );
                          })}
                        </div>

                        {/* Timeline events */}
                        <div style={{
                          position: "relative",
                          paddingLeft: "1.5rem",
                          borderLeft: "2px solid rgba(255,255,255,0.08)",
                        }}>
                          {filteredTimeline.length === 0 && (
                            <p className="muted" style={{ padding: "1rem 0", fontSize: "0.85rem" }}>没有匹配的记录</p>
                          )}
                          {filteredTimeline.map((ev, i) => {
                            const statusColor = getStatusColor(ev.status);
                            const sourceInfo = getSourceLabel(ev.source);
                            const icon = TYPE_ICON[ev.type] || CATEGORY_ICON[ev.category] || "•";
                            return (
                              <div
                                key={`${ev.time}-${ev.category}-${i}`}
                                style={{
                                  position: "relative",
                                  paddingBottom: "0.75rem",
                                  marginBottom: "0.5rem",
                                }}
                              >
                                {/* Dot on the timeline line */}
                                <div style={{
                                  position: "absolute",
                                  left: "-1.75rem",
                                  top: "0.2rem",
                                  width: "10px",
                                  height: "10px",
                                  borderRadius: "50%",
                                  background: statusColor,
                                  border: "2px solid rgba(0,0,0,0.4)",
                                }} />

                                {/* Event card */}
                                <div style={{
                                  background: "rgba(255,255,255,0.03)",
                                  borderRadius: "0.5rem",
                                  padding: "0.5rem 0.75rem",
                                  border: "1px solid rgba(255,255,255,0.06)",
                                }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                                    <span style={{ fontSize: "0.8rem", color: "#64748b", fontFamily: "monospace", minWidth: "9.5rem" }}>
                                      {formatDateTime(ev.time)}
                                    </span>
                                    <span>{icon}</span>
                                    <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>{ev.type}</span>
                                    <span style={{
                                      fontSize: "0.75rem",
                                      padding: "0.1rem 0.4rem",
                                      borderRadius: "4px",
                                      background: `${statusColor}20`,
                                      color: statusColor,
                                      fontWeight: 600,
                                    }}>
                                      {ev.status}
                                    </span>
                                    <span style={{
                                      fontSize: "0.7rem",
                                      padding: "0.1rem 0.35rem",
                                      borderRadius: "4px",
                                      background: `${sourceInfo.color}18`,
                                      color: sourceInfo.color,
                                    }}>
                                      {sourceInfo.text}
                                    </span>
                                  </div>
                                  <div style={{ fontSize: "0.85rem", marginTop: "0.25rem", color: "#cbd5e1" }}>
                                    {ev.detail}
                                    {ev.groupName && (
                                      <span className="muted" style={{ marginLeft: "0.5rem" }}>
                                        | 组: {ev.groupName}
                                      </span>
                                    )}
                                  </div>
                                  {ev.extra?.errorMessage && (
                                    <div style={{ fontSize: "0.8rem", color: "#f87171", marginTop: "0.2rem" }}>
                                      ⚠ {ev.extra.errorMessage}
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>

            </div>
          )}
        </div>
      )}
    </div>
  );
}
