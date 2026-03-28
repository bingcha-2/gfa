"use client";

import { useDeferredValue, useState } from "react";

import {
  canCancelTask,
  canManualCompleteTask,
  canManualFailTask,
  canRetryTask
} from "../lib/permissions";
import { TaskSummary } from "../lib/types";
import { Spinner } from "./spinner";
import { StatusBadge } from "./status-badge";

type TasksPanelProps = {
  tasks: TaskSummary[];
  role?: string;
  onRetry: (taskId: string) => Promise<boolean>;
  onManualComplete: (taskId: string, resultMessage: string) => Promise<boolean>;
  onManualFail: (taskId: string, reason: string) => Promise<boolean>;
  onCancel: (taskId: string, reason: string) => Promise<boolean>;
};

type ActioningState = {
  taskId: string;
  action: "retry" | "complete" | "fail" | "cancel";
} | null;

export function TasksPanel({
  tasks,
  role,
  onRetry,
  onManualComplete,
  onManualFail,
  onCancel
}: TasksPanelProps) {
  const [filter, setFilter] = useState("");
  const [activeTab, setActiveTab] = useState<"all" | "manual" | "retryable">("all");
  const [actioning, setActioning] = useState<ActioningState>(null);
  const [toast, setToast] = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 20;
  const deferredFilter = useDeferredValue(filter);

  function showToast(type: "success" | "error", msg: string) {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 3500);
  }

  const filteredTasks = tasks.filter((task) => {
    if (activeTab === "manual" && task.status !== "MANUAL_REVIEW") {
      return false;
    }

    if (
      activeTab === "retryable" &&
      !["PENDING", "FAILED_RETRYABLE", "FAILED_FINAL", "MANUAL_REVIEW"].includes(task.status)
    ) {
      return false;
    }

    const query = deferredFilter.trim().toLowerCase();

    if (!query) {
      return true;
    }

    return (
      task.id.toLowerCase().includes(query) ||
      task.type.toLowerCase().includes(query) ||
      task.status.toLowerCase().includes(query) ||
      task.order?.orderNo?.toLowerCase().includes(query) ||
      task.order?.userEmail?.toLowerCase().includes(query) ||
      task.familyGroup?.groupName?.toLowerCase().includes(query) ||
      task.account?.name?.toLowerCase().includes(query)
    );
  });
  const paginated = filteredTasks.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const totalPages = Math.ceil(filteredTasks.length / PAGE_SIZE);

  async function handleRetry(taskId: string) {
    setActioning({ taskId, action: "retry" });
    try {
      const ok = await onRetry(taskId);
      if (ok) showToast("success", "已重新入队，等待 Worker 处理");
      else showToast("error", "重试失败，请查看日志");
    } catch {
      showToast("error", "重试请求失败");
    } finally {
      setActioning(null);
    }
  }

  async function handleManualComplete(taskId: string) {
    const resultMessage =
      window.prompt("填写手动完成说明", "Manually completed from console") ?? "";
    setActioning({ taskId, action: "complete" });
    try {
      const ok = await onManualComplete(taskId, resultMessage);
      if (ok) showToast("success", "任务已标记为完成");
      else showToast("error", "操作失败");
    } catch {
      showToast("error", "请求失败");
    } finally {
      setActioning(null);
    }
  }

  async function handleManualFail(taskId: string) {
    const reason = window.prompt("填写失败原因", "Manual review failed") ?? "";
    setActioning({ taskId, action: "fail" });
    try {
      const ok = await onManualFail(taskId, reason);
      if (ok) showToast("success", "任务已标记为失败");
      else showToast("error", "操作失败");
    } catch {
      showToast("error", "请求失败");
    } finally {
      setActioning(null);
    }
  }

  async function handleCancel(taskId: string) {
    const reason = window.prompt("填写终止原因（可选）", "Cancelled by operator");
    if (reason === null) return; // user pressed browser Cancel
    setActioning({ taskId, action: "cancel" });
    try {
      const ok = await onCancel(taskId, reason);
      if (ok) showToast("success", "任务已终止");
      else showToast("error", "终止失败");
    } catch {
      showToast("error", "终止请求失败");
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

          <div className="filter-row">
            <input
              className="search-field"
              placeholder="筛选邮箱 / 任务号 / 类型 / 状态"
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

        <div className="table-wrap workspace-table-wrap">
          <table className="data-table" style={{ tableLayout: 'fixed', width: '100%' }}>
            <colgroup>
              <col style={{ width: '18%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '15%' }} />
              <col style={{ width: '32%' }} />
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
              {paginated.length ? (<>
                {paginated.map((task) => {
                  const isActioning = actioning?.taskId === task.id;
                  return (
                    <tr key={task.id}>
                      <td>
                        <div className="strong">{task.type}</div>
                        {task.order?.userEmail && (
                          <div style={{ fontSize: '0.85rem' }}>{task.order.userEmail}</div>
                        )}
                        <div className="muted mono" style={{ fontSize: '0.75rem' }}>
                          {task.id.slice(0, 12)} · retry {task.retryCount}/{task.maxRetryCount}
                        </div>
                      </td>
                      <td>
                        <StatusBadge value={isActioning ? "RUNNING" : task.status} />
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
                        <div className="inline-actions">
                          {canRetryTask(role, task.status) ? (
                            <button
                              className="button secondary small"
                              disabled={isActioning}
                              onClick={() => void handleRetry(task.id)}
                              type="button"
                              style={{ gap: 6 }}
                            >
                              {isActioning && actioning?.action === "retry"
                                ? <><Spinner size={12} color="currentColor" /> 重试中...</>
                                : "重试"}
                            </button>
                          ) : null}
                          {canManualCompleteTask(role, task.status) ? (
                            <button
                              className="button secondary small"
                              disabled={isActioning}
                              onClick={() => void handleManualComplete(task.id)}
                              type="button"
                              style={{ gap: 6 }}
                            >
                              {isActioning && actioning?.action === "complete"
                                ? <><Spinner size={12} color="currentColor" /> 处理中...</>
                                : "手动完成"}
                            </button>
                          ) : null}
                          {canManualFailTask(role, task.status) ? (
                            <button
                              className="button secondary small"
                              disabled={isActioning}
                              onClick={() => void handleManualFail(task.id)}
                              type="button"
                              style={{ gap: 6 }}
                            >
                              {isActioning && actioning?.action === "fail"
                                ? <><Spinner size={12} color="currentColor" /> 处理中...</>
                                : "手动失败"}
                            </button>
                          ) : null}
                          {canCancelTask(role, task.status) ? (
                            <button
                              className="button secondary small"
                              disabled={isActioning}
                              onClick={() => void handleCancel(task.id)}
                              type="button"
                              style={{ gap: 6, color: 'var(--clr-error, #ef4444)' }}
                            >
                              {isActioning && actioning?.action === "cancel"
                                ? <><Spinner size={12} color="currentColor" /> 终止中...</>
                                : "终止"}
                            </button>
                          ) : null}
                          {!canRetryTask(role, task.status) &&
                          !canManualCompleteTask(role, task.status) &&
                          !canManualFailTask(role, task.status) &&
                          !canCancelTask(role, task.status) ? (
                            <span className="muted">无可用动作</span>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              {/* Pagination */}
              {totalPages > 1 && (
                <tr>
                  <td colSpan={5}>
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
