"use client";

import { useState, useEffect, useRef, useCallback } from "react";

import {
  canCancelTask,
  canManualCompleteTask,
  canManualFailTask,
  canRetryTask
} from "../lib/permissions";
import { TaskSummary } from "../lib/types";
import { apiRequest, getErrorMessage } from "../lib/client-api";
import { Spinner } from "./spinner";

/** 格式化绝对时间为本地可读字符串 */
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** 格式化毫秒耗时为人类可读（< 60s 显示秒，否则分秒） */
function fmtDuration(ms: number): string {
  if (ms < 0) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

type TaskTimeMetaProps = {
  task: TaskSummary;
};

/** 展示任务创建时间与执行耗时，对 RUNNING 状态实时计时 */
function TaskTimeMeta({ task }: TaskTimeMetaProps) {
  const isRunning = task.status === "RUNNING";
  const [elapsed, setElapsed] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isRunning || !task.startedAt) {
      setElapsed(null);
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }
    const start = new Date(task.startedAt).getTime();
    const tick = () => setElapsed(Date.now() - start);
    tick();
    timerRef.current = setInterval(tick, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isRunning, task.startedAt]);

  // 计算静态耗时（已完成任务）
  let durationLabel: string | null = null;
  if (!isRunning && task.startedAt && task.finishedAt) {
    const ms = new Date(task.finishedAt).getTime() - new Date(task.startedAt).getTime();
    durationLabel = fmtDuration(ms);
  } else if (!isRunning && task.startedAt && task.updatedAt) {
    // fallback: updatedAt as end time
    const ms = new Date(task.updatedAt).getTime() - new Date(task.startedAt).getTime();
    if (ms > 0) durationLabel = fmtDuration(ms);
  }

  return (
    <div style={{ fontSize: '0.72rem', color: 'var(--clr-muted, #94a3b8)', marginTop: 2, lineHeight: 1.6 }}>
      <span title="创建时间">🕐 {fmtTime(task.createdAt)}</span>
      {isRunning && task.startedAt && elapsed !== null && (
        <span style={{ marginLeft: 6, color: 'var(--accent, #0d9488)' }}>
          ⏱ {fmtDuration(elapsed)}
        </span>
      )}
      {!isRunning && durationLabel && (
        <span style={{ marginLeft: 6 }}>⏱ {durationLabel}</span>
      )}
    </div>
  );
}

const PAGE_SIZE = 50;

type TasksPanelProps = {
  role?: string;
  showToast?: (type: "success" | "error" | "info", msg: string) => void;
};

type ActioningState = {
  taskId: string;
  action: "retry" | "complete" | "fail" | "cancel";
} | null;

/** Map raw task status to simplified 3-state display */
function getSimplifiedStatus(status: string): { label: string; color: string; bg: string } {
  const running = new Set(["PENDING", "RUNNING", "MANUAL_REVIEW"]);
  const success = new Set(["SUCCESS", "COMPLETED", "INVITE_SENT", "REPLACED_AND_INVITE_SENT"]);
  if (running.has(status)) return { label: "执行中", color: "#f59e0b", bg: "rgba(245,158,11,0.12)" };
  if (success.has(status)) return { label: "成功", color: "#22c55e", bg: "rgba(34,197,94,0.12)" };
  if (status === "CANCELLED") return { label: "已终止", color: "#94a3b8", bg: "rgba(148,163,184,0.12)" };
  return { label: "失败", color: "#ef4444", bg: "rgba(239,68,68,0.12)" };
}

export function TasksPanel({ role, showToast: externalToast }: TasksPanelProps) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [activeTab, setActiveTab] = useState<"all" | "manual" | "retryable">("all");
  const [filter, setFilter] = useState("");
  const [debouncedFilter, setDebouncedFilter] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [actioning, setActioning] = useState<ActioningState>(null);
  const [toast, setToast] = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());

  // Debounce filter input: wait 500ms after user stops typing
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedFilter(filter), 500);
    return () => clearTimeout(timer);
  }, [filter]);

  function showToast(type: "success" | "error", msg: string) {
    if (externalToast) { externalToast(type, msg); return; }
    setToast({ type, msg });
    setTimeout(() => setToast(null), 3500);
  }

  // Build server query params based on tab
  const getStatusParam = useCallback(() => {
    if (activeTab === "manual") return "MANUAL_REVIEW";
    // For "retryable", we fetch all and filter client-side since it's multiple statuses
    // But we can use the "all" endpoint — the page size is small enough
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
      if (debouncedFilter.trim()) params.set("search", debouncedFilter.trim());
      const res = await apiRequest<{ items: TaskSummary[]; total: number }>(`tasks?${params.toString()}`);
      setTasks(res.items);
      setTotalItems(res.total);
    } catch (err) {
      console.error("Failed to load tasks:", err);
    } finally {
      setIsLoading(false);
    }
  }, [currentPage, activeTab, debouncedFilter, getStatusParam]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const totalPages = Math.ceil(totalItems / PAGE_SIZE);

  // Server-side search — for "retryable" tab, apply extra client-side status filter
  const displayTasks = tasks.filter((task) => {
    if (
      activeTab === "retryable" &&
      !["PENDING", "FAILED_RETRYABLE", "FAILED_FINAL", "MANUAL_REVIEW"].includes(task.status)
    ) {
      return false;
    }
    return true;
  });

  async function handleRetry(taskId: string) {
    setActioning({ taskId, action: "retry" });
    try {
      await apiRequest(`tasks/${taskId}/retry`, { method: "POST" });
      showToast("success", "已重新入队，等待 Worker 处理");
      await loadData();
    } catch (err) {
      showToast("error", getErrorMessage(err));
    } finally {
      setActioning(null);
    }
  }

  async function handleManualComplete(taskId: string) {
    const resultMessage =
      window.prompt("填写手动完成说明", "Manually completed from console") ?? "";
    setActioning({ taskId, action: "complete" });
    try {
      await apiRequest(`tasks/${taskId}/manual-complete`, { method: "POST", body: { resultMessage } });
      showToast("success", "任务已标记为完成");
      await loadData();
    } catch (err) {
      showToast("error", getErrorMessage(err));
    } finally {
      setActioning(null);
    }
  }

  async function handleManualFail(taskId: string) {
    const reason = window.prompt("填写失败原因", "Manual review failed") ?? "";
    setActioning({ taskId, action: "fail" });
    try {
      await apiRequest(`tasks/${taskId}/manual-fail`, { method: "POST", body: { reason } });
      showToast("success", "任务已标记为失败");
      await loadData();
    } catch (err) {
      showToast("error", getErrorMessage(err));
    } finally {
      setActioning(null);
    }
  }

  async function handleCancel(taskId: string) {
    const reason = window.prompt("填写终止原因（可选）", "Cancelled by operator");
    if (reason === null) return; // user pressed browser Cancel
    setActioning({ taskId, action: "cancel" });
    try {
      await apiRequest(`tasks/${taskId}/cancel`, { method: "POST", body: { reason } });
      showToast("success", "任务已终止");
      await loadData();
    } catch (err) {
      showToast("error", getErrorMessage(err));
    } finally {
      setActioning(null);
    }
  }

  return (
    <section id="tasks" className="glass-panel">
      {/* Toast notification */}
      {toast && (
        <div className={`gfa-toast ${toast.type}`}>
          {toast.type === "success" ? "✅" : "❌"} {toast.msg}
        </div>
      )}

      <div className="panel-stack">
        <div className="section-head">
          <div className="section-copy">
            <p className="label">任务列表</p>
            <h2 className="panel-title">自动化任务</h2>
            <p className="muted">支持重试、手动完成和手动失败，先把人工兜底能力做出来。</p>
          </div>

          <div className="filter-row" style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <input
              className="search-field"
              placeholder="搜索 任务ID / 订单号 / 邮箱 / 母号"
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
                setCurrentPage(1);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") loadData();
              }}
            />
            <button
              className="button secondary small"
              onClick={loadData}
              disabled={isLoading}
              type="button"
              style={{ whiteSpace: "nowrap" }}
            >
              {isLoading ? "刷新中..." : "刷新"}
            </button>
          </div>
        </div>

        <div style={{ fontSize: '0.875rem', color: 'var(--foreground-muted, #737373)', marginBottom: '2px' }}>
          共 {totalItems} 条
          {totalPages > 0 && ` · 第 ${currentPage}/${totalPages} 页`}
        </div>

        <div className="panel-tabs">
          <button
            className={`panel-tab${activeTab === "all" ? " active" : ""}`}
            onClick={() => { setActiveTab("all"); setCurrentPage(1); }}
            type="button"
          >
            全部任务
          </button>
          <button
            className={`panel-tab${activeTab === "manual" ? " active" : ""}`}
            onClick={() => { setActiveTab("manual"); setCurrentPage(1); }}
            type="button"
          >
            人工处理
          </button>
          <button
            className={`panel-tab${activeTab === "retryable" ? " active" : ""}`}
            onClick={() => { setActiveTab("retryable"); setCurrentPage(1); }}
            type="button"
          >
            可重试
          </button>
        </div>

        <div className="table-wrap workspace-table-wrap" style={{ minHeight: '200px', position: 'relative' }}>
          {isLoading && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)', zIndex: 10 }}>
              <Spinner />
            </div>
          )}
          <table className="data-table" style={{ tableLayout: 'fixed', width: '100%' }}>
            <colgroup>
              <col style={{ width: '20%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '15%' }} />
              <col style={{ width: '30%' }} />
              <col style={{ width: '25%' }} />
            </colgroup>
            <thead>
              <tr>
                <th>任务</th>
                <th>状态</th>
                <th>关联对象</th>
                <th>错误</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {displayTasks.length ? (<>
                {displayTasks.map((task) => {
                  const isActioning = actioning?.taskId === task.id;
                  // Parse payload to extract target emails
                  let payloadEmails: { target?: string; newUser?: string; user?: string } = {};
                  try {
                    if (task.payload) {
                      const p = JSON.parse(task.payload);
                      payloadEmails = {
                        target: p.targetMemberEmail,
                        newUser: p.newUserEmail,
                        user: p.userEmail,
                      };
                    }
                  } catch { /* ignore */ }
                  const displayEmail = payloadEmails.user || payloadEmails.target || task.order?.userEmail;
                  return (
                    <tr key={task.id}>
                      <td>
                        <div className="strong">{task.type}</div>
                        {displayEmail && (
                          <div style={{ fontSize: '0.85rem', wordBreak: 'break-all' }}>
                            {displayEmail}
                            {payloadEmails.newUser && payloadEmails.target && (
                              <span className="muted"> → {payloadEmails.newUser}</span>
                            )}
                          </div>
                        )}
                        <div className="muted mono" style={{ fontSize: '0.75rem' }}>
                          {task.id} · retry {task.retryCount}/{task.maxRetryCount}
                        </div>
                        <TaskTimeMeta task={task} />
                      </td>
                      <td>
                        {(() => {
                          const ss = getSimplifiedStatus(isActioning ? "RUNNING" : task.status);
                          return (
                            <span style={{
                              display: 'inline-block', padding: '2px 10px', borderRadius: 999,
                              fontSize: '0.78rem', fontWeight: 600, letterSpacing: '0.02em',
                              color: ss.color, background: ss.bg, border: `1px solid ${ss.color}22`,
                            }}>
                              {isActioning ? "执行中" : ss.label}
                            </span>
                          );
                        })()}
                        {!isActioning && task.status !== getSimplifiedStatus(task.status).label && (
                          <div style={{ fontSize: '0.7rem', color: 'var(--clr-muted, #94a3b8)', marginTop: 2 }}>
                            {task.status}
                          </div>
                        )}
                      </td>
                      <td>
                        {task.order?.orderNo && (
                          <div style={{ fontSize: '0.85rem' }}><span className="muted">订单：</span>{task.order.orderNo}</div>
                        )}
                        {task.familyGroup?.groupName && (
                          <div style={{ fontSize: '0.85rem' }}><span className="muted">家庭组：</span>{task.familyGroup.groupName}</div>
                        )}
                        {task.account?.name && (
                          <div style={{ fontSize: '0.85rem' }}><span className="muted">母号：</span>{task.account.name}</div>
                        )}
                        {!task.order?.orderNo && !task.familyGroup?.groupName && !task.account?.name && (
                          <span className="muted">-</span>
                        )}
                      </td>
                      <td
                        style={{ cursor: task.lastErrorMessage ? 'pointer' : 'default' }}
                        onClick={() => {
                          if (!task.lastErrorMessage) return;
                          setExpandedErrors(prev => {
                            const next = new Set(prev);
                            if (next.has(task.id)) next.delete(task.id);
                            else next.add(task.id);
                            return next;
                          });
                        }}
                      >
                        <div style={{ fontWeight: 500 }}>{task.lastErrorCode ?? "-"}</div>
                        <div className="muted" style={{
                          ...(!expandedErrors.has(task.id) ? {
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical' as const,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            maxHeight: '2.8em',
                          } : {}),
                          wordBreak: 'break-word',
                          lineHeight: '1.4',
                        }}>{task.lastErrorMessage ?? "No error"}</div>
                        {task.lastErrorMessage && task.lastErrorMessage.length > 60 && (
                          <div style={{ fontSize: '0.75rem', color: 'var(--accent, #0d9488)', marginTop: 2 }}>
                            {expandedErrors.has(task.id) ? '▲ 收起' : '▼ 展开'}
                          </div>
                        )}
                      </td>
                      <td>
                        <div className="inline-actions" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {canRetryTask(role, task.status) && (
                            <button
                              className="button secondary small"
                              disabled={isActioning}
                              onClick={() => void handleRetry(task.id)}
                              type="button"
                              style={{ gap: 4, fontSize: '0.78rem' }}
                            >
                              {isActioning && actioning?.action === "retry"
                                ? <><Spinner size={12} color="currentColor" /> 重试中...</>
                                : "🔄 重试"}
                            </button>
                          )}
                          {canCancelTask(role, task.status) && (
                            <button
                              className="button secondary small"
                              disabled={isActioning}
                              onClick={() => void handleCancel(task.id)}
                              type="button"
                              style={{ gap: 4, fontSize: '0.78rem', color: 'var(--clr-error, #ef4444)' }}
                            >
                              {isActioning && actioning?.action === "cancel"
                                ? <><Spinner size={12} color="currentColor" /> 终止中...</>
                                : "⛔ 终止"}
                            </button>
                          )}
                          {canManualCompleteTask(role, task.status) && (
                            <button
                              className="button secondary small"
                              disabled={isActioning}
                              onClick={() => void handleManualComplete(task.id)}
                              type="button"
                              style={{ gap: 4, fontSize: '0.78rem' }}
                            >
                              {isActioning && actioning?.action === "complete"
                                ? <><Spinner size={12} color="currentColor" /> 处理中...</>
                                : "✅ 手动完成"}
                            </button>
                          )}
                          {canManualFailTask(role, task.status) && (
                            <button
                              className="button secondary small"
                              disabled={isActioning}
                              onClick={() => void handleManualFail(task.id)}
                              type="button"
                              style={{ gap: 4, fontSize: '0.78rem' }}
                            >
                              {isActioning && actioning?.action === "fail"
                                ? <><Spinner size={12} color="currentColor" /> 处理中...</>
                                : "❌ 手动失败"}
                            </button>
                          )}
                          {!canRetryTask(role, task.status) &&
                          !canManualCompleteTask(role, task.status) &&
                          !canManualFailTask(role, task.status) &&
                          !canCancelTask(role, task.status) && (
                            <span className="muted" style={{ fontSize: '0.78rem' }}>—</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              {/* Pagination */}
              {totalPages > 1 && (
                <tr>
                  <td colSpan={5}>
                    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '4px', padding: '8px 0', flexWrap: 'wrap' }}>
                      <button className="button secondary small" disabled={currentPage <= 1 || isLoading} onClick={() => setCurrentPage(p => Math.max(1, p - 1))} type="button" style={{ minWidth: 60 }}>← 上页</button>
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
                            <button
                              key={p}
                              className={`button small ${p === currentPage ? '' : 'secondary'}`}
                              disabled={isLoading}
                              onClick={() => setCurrentPage(p as number)}
                              type="button"
                              style={{ minWidth: 32, padding: '4px 8px', fontWeight: p === currentPage ? 700 : 400 }}
                            >
                              {p}
                            </button>
                          )
                        );
                      })()}
                      <button className="button secondary small" disabled={currentPage >= totalPages || isLoading} onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} type="button" style={{ minWidth: 60 }}>下页 →</button>
                    </div>
                  </td>
                </tr>
              )}
              </>) : (
                <tr>
                  <td colSpan={5}>
                    <div className="empty-state">没有匹配的任务。</div>
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
