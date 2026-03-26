"use client";

import { useState } from "react";
import { apiRequest, getErrorMessage } from "../lib/client-api";
import { StatusBadge } from "./status-badge";
import { Spinner } from "./spinner";

type LookupResult = {
  found: boolean;
  error?: string;
  memberStatus?: string;
  familyGroup?: {
    id: string;
    groupName: string;
    accountEmail: string | null;
  };
  order?: {
    orderNo: string;
    status: string;
    code: string | null;
    expiresAt: string | null;
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

function isExpired(iso: string | null | undefined): boolean {
  if (!iso) return false;
  return new Date(iso) < new Date();
}

export function MemberLookupPanel() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const expired = result?.order ? isExpired(result.order.expiresAt) : false;

  return (
    <div className="panel-stack">
      {/* Search form */}
      <form className="glass-panel" onSubmit={handleSearch} style={{ padding: "1.25rem 1.5rem" }}>
        <div className="section-copy" style={{ marginBottom: "1rem" }}>
          <p className="label">Member Lookup</p>
          <h2 className="panel-title">组员邮箱查询</h2>
          <p className="muted">输入客户邮箱，快速定位所在家庭组、卡密和订阅到期时间。</p>
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
              <div className="split-head">
                <div>
                  <p className="label">查询结果</p>
                  <h3 className="panel-title" style={{ fontSize: "1rem" }}>{email}</h3>
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
                    <span style={{ fontSize: "0.78rem", color: "var(--amber, #fbbf24)" }}>
                      ⚠ 有订单但尚未入组
                    </span>
                  )}
                </div>
              </div>

              <div className="surface-grid two-up" style={{ gap: "1rem" }}>

                {/* Family Group card */}
                <div className="list-card" style={{ padding: "1rem 1.25rem" }}>
                  <p className="label" style={{ marginBottom: "0.5rem" }}>家庭组</p>
                  {result.familyGroup ? (
                    <div className="panel-stack" style={{ gap: "0.375rem" }}>
                      <div className="strong">{result.familyGroup.groupName}</div>
                      {result.familyGroup.accountEmail && (
                        <div className="muted mono" style={{ fontSize: "0.85rem" }}>
                          母号：{result.familyGroup.accountEmail}
                        </div>
                      )}
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
