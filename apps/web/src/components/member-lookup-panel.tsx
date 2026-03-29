"use client";

import { useState } from "react";
import { apiRequest, getErrorMessage } from "../lib/client-api";
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

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = email.trim();
    if (!q) return;

    setLoading(true);
    setError(null);
    setResult(null);

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

  async function handleRemoveMember() {
    if (!result?.familyGroup || !onRemoveMember) return;
    const q = email.trim();
    if (!confirm(`确认从 ${result.familyGroup.groupName} 中移除 ${q}？`)) return;

    setActionLoading("remove");
    try {
      const ok = await onRemoveMember(result.familyGroup.id, q);
      if (ok) {
        showToast?.("success", `已提交移除任务: ${q}`);
        // Re-query to refresh state
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
    if (!confirm(`确认重试订单 ${result.order.orderNo}？`)) return;

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
    if (!confirm(`确认将 ${oldEmail} 替换为 ${newEmail}？\n将自动移除旧成员并邀请新成员。`)) return;

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
        // Re-query to refresh
        handleSearch({ preventDefault: () => {} } as React.FormEvent);
      }
    } catch (err) {
      showToast?.("error", getErrorMessage(err));
    } finally {
      setActionLoading(null);
    }
  }

  const expired = result?.order ? isExpired(result.order.expiresAt) : false;

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
                  <button
                    className="button"
                    onClick={handleRemoveMember}
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
                    {actionLoading === "remove" ? <Spinner size={12} color="currentColor" /> : "⛔"}
                    移除成员
                  </button>
                )}

                {result.order && RETRYABLE_ORDER_STATUSES.has(result.order.status) && onRetryOrder && (
                  <button
                    className="button"
                    onClick={handleRetryOrder}
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
                    {actionLoading === "retry" ? <Spinner size={12} color="currentColor" /> : "🔄"}
                    重试订单
                  </button>
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
                  <button
                    className="button"
                    type="button"
                    onClick={handleReplace}
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
                    {actionLoading === "replace" ? <><Spinner size={12} color="currentColor" /> 提交中…</> : "确认替换"}
                  </button>
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
            </div>
          )}
        </div>
      )}
    </div>
  );
}
