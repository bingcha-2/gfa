"use client";

import { useState } from "react";
import { apiRequest, getErrorMessage } from "../lib/client-api";
import { Spinner } from "./spinner";

// ─── Types ──────────────────────────────────────────────────────────────

export type TimelineEvent = {
  time: string;
  category: "task" | "order" | "swap" | "member";
  type: string;
  status: string;
  source: string;
  detail: string;
  groupName: string | null;
  extra?: Record<string, any>;
};

export type TimelineData = {
  email: string;
  totalEvents: number;
  summary: { tasks: number; orders: number; swaps: number; memberRecords: number };
  timeline: TimelineEvent[];
};

// ─── Constants ──────────────────────────────────────────────────────────

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

// ─── Helpers ────────────────────────────────────────────────────────────

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getStatusColor(status: string): string {
  if (
    status.includes("SENT") ||
    status === "REPLACED_AND_INVITE_SENT" ||
    status === "SUCCESS" ||
    status === "COMPLETED" ||
    status === "ACTIVE"
  )
    return "#4ade80";
  if (status.includes("FAIL") || status === "REMOVED") return "#f87171";
  if (status === "PENDING" || status === "CANCELLED") return "#fbbf24";
  return "#94a3b8";
}

function getSourceLabel(source: string): { text: string; color: string } {
  switch (source) {
    case "manual":
      return { text: "手动", color: "#fbbf24" };
    case "auto":
      return { text: "自动", color: "#60a5fa" };
    case "webhook":
      return { text: "Webhook", color: "#a78bfa" };
    case "scheduler":
      return { text: "定时", color: "#34d399" };
    case "system":
      return { text: "系统", color: "#94a3b8" };
    case "record":
      return { text: "记录", color: "#64748b" };
    default:
      return { text: source, color: "#94a3b8" };
  }
}

// ─── Component ──────────────────────────────────────────────────────────

type MemberTimelineProps = {
  /** The member email to fetch timeline for */
  email: string;
  /** If true, load and show timeline immediately instead of requiring a click */
  autoLoad?: boolean;
  /** If true, render expanded without the toggle button (inline mode) */
  inline?: boolean;
};

export function MemberTimeline({ email, autoLoad = false, inline = false }: MemberTimelineProps) {
  const [open, setOpen] = useState(autoLoad);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<TimelineData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");

  async function fetchTimeline() {
    const q = email.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    try {
      const result = await apiRequest<TimelineData>(
        `family-groups/member-timeline?email=${encodeURIComponent(q)}`
      );
      setData(result);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  function handleToggle() {
    if (!open && !data) {
      fetchTimeline();
    }
    setOpen(!open);
  }

  // Auto-load on mount if requested
  useState(() => {
    if (autoLoad && !data) {
      fetchTimeline();
    }
  });

  const filteredTimeline =
    data?.timeline.filter((ev) => filter === "all" || ev.category === filter) ?? [];

  // Inline mode: always show content
  const showContent = inline || open;

  return (
    <div
      style={{
        borderTop: inline ? undefined : "1px solid rgba(255,255,255,0.06)",
        paddingTop: inline ? undefined : "0.75rem",
      }}
    >
      {/* Toggle button (hidden in inline mode) */}
      {!inline && (
        <button
          type="button"
          onClick={handleToggle}
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
          <span
            style={{
              display: "inline-block",
              transition: "transform 0.2s",
              transform: open ? "rotate(90deg)" : "rotate(0deg)",
            }}
          >
            ▶
          </span>
          📜 操作时间线
          {data && (
            <span style={{ fontWeight: 400, color: "#94a3b8", fontSize: "0.8rem" }}>
              ({data.totalEvents} 条记录)
            </span>
          )}
          {loading && <Spinner size={12} color="#60a5fa" />}
        </button>
      )}

      {showContent && (
        <div style={{ marginTop: inline ? 0 : "0.75rem" }}>
          {/* Inline mode: show loading/header */}
          {inline && loading && (
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.5rem 0", fontSize: "0.85rem", color: "#94a3b8" }}>
              <Spinner size={14} color="#60a5fa" /> 加载操作时间线…
            </div>
          )}

          {error && (
            <div className="notice error" style={{ fontSize: "0.85rem" }}>
              {error}
            </div>
          )}

          {data && (
            <>
              {/* Summary filter badges */}
              <div
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  flexWrap: "wrap",
                  marginBottom: "0.75rem",
                }}
              >
                {(["all", "task", "order", "swap", "member"] as const).map((cat) => {
                  const count =
                    cat === "all"
                      ? data.totalEvents
                      : cat === "task"
                        ? data.summary.tasks
                        : cat === "order"
                          ? data.summary.orders
                          : cat === "swap"
                            ? data.summary.swaps
                            : data.summary.memberRecords;
                  const isActive = filter === cat;
                  return (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setFilter(cat)}
                      style={{
                        padding: "0.25rem 0.6rem",
                        fontSize: "0.8rem",
                        borderRadius: "999px",
                        border: `1px solid ${isActive ? "rgba(96,165,250,0.5)" : "rgba(255,255,255,0.1)"}`,
                        background: isActive
                          ? "rgba(96,165,250,0.15)"
                          : "rgba(255,255,255,0.04)",
                        color: isActive ? "#60a5fa" : "#94a3b8",
                        cursor: "pointer",
                        fontWeight: isActive ? 600 : 400,
                        transition: "all 0.15s",
                      }}
                    >
                      {cat === "all"
                        ? "全部"
                        : `${CATEGORY_ICON[cat] || ""} ${CATEGORY_LABEL[cat] || cat}`}{" "}
                      {count}
                    </button>
                  );
                })}
              </div>

              {/* Timeline events */}
              <div
                style={{
                  position: "relative",
                  paddingLeft: "1.5rem",
                  borderLeft: "2px solid rgba(255,255,255,0.08)",
                }}
              >
                {filteredTimeline.length === 0 && (
                  <p className="muted" style={{ padding: "1rem 0", fontSize: "0.85rem" }}>
                    没有匹配的记录
                  </p>
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
                      <div
                        style={{
                          position: "absolute",
                          left: "-1.75rem",
                          top: "0.2rem",
                          width: "10px",
                          height: "10px",
                          borderRadius: "50%",
                          background: statusColor,
                          border: "2px solid rgba(0,0,0,0.4)",
                        }}
                      />

                      {/* Event card */}
                      <div
                        style={{
                          background: "rgba(255,255,255,0.03)",
                          borderRadius: "0.5rem",
                          padding: "0.5rem 0.75rem",
                          border: "1px solid rgba(255,255,255,0.06)",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "0.5rem",
                            flexWrap: "wrap",
                          }}
                        >
                          <span
                            style={{
                              fontSize: "0.8rem",
                              color: "#64748b",
                              fontFamily: "monospace",
                              minWidth: "9.5rem",
                            }}
                          >
                            {formatDateTime(ev.time)}
                          </span>
                          <span>{icon}</span>
                          <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>{ev.type}</span>
                          <span
                            style={{
                              fontSize: "0.75rem",
                              padding: "0.1rem 0.4rem",
                              borderRadius: "4px",
                              background: `${statusColor}20`,
                              color: statusColor,
                              fontWeight: 600,
                            }}
                          >
                            {ev.status}
                          </span>
                          <span
                            style={{
                              fontSize: "0.7rem",
                              padding: "0.1rem 0.35rem",
                              borderRadius: "4px",
                              background: `${sourceInfo.color}18`,
                              color: sourceInfo.color,
                            }}
                          >
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
                          <div
                            style={{ fontSize: "0.8rem", color: "#f87171", marginTop: "0.2rem" }}
                          >
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
  );
}
