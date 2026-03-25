"use client";

import { useDeferredValue, useState } from "react";

import {
  canManualCompleteTask,
  canManualFailTask,
  canRetryTask
} from "../lib/permissions";
import { TaskSummary } from "../lib/types";
import { StatusBadge } from "./status-badge";

type TasksPanelProps = {
  tasks: TaskSummary[];
  role?: string;
  onRetry: (taskId: string) => Promise<boolean>;
  onManualComplete: (taskId: string, resultMessage: string) => Promise<boolean>;
  onManualFail: (taskId: string, reason: string) => Promise<boolean>;
};

type ActioningState = {
  taskId: string;
  action: "retry" | "complete" | "fail";
} | null;

export function TasksPanel({
  tasks,
  role,
  onRetry,
  onManualComplete,
  onManualFail
}: TasksPanelProps) {
  const [filter, setFilter] = useState("");
  const [activeTab, setActiveTab] = useState<"all" | "manual" | "retryable">("all");
  const [actioning, setActioning] = useState<ActioningState>(null);
  const [toast, setToast] = useState<{ type: "success" | "error"; msg: string } | null>(null);
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
      task.familyGroup?.groupName?.toLowerCase().includes(query)
    );
  });

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

  return (
    <section id="tasks" className="glass-panel">
      {/* Toast notification */}
      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: "24px",
            right: "24px",
            zIndex: 9999,
            background: toast.type === "success" ? "var(--green, #16a34a)" : "var(--red, #dc2626)",
            color: "#fff",
            padding: "10px 20px",
            borderRadius: "8px",
            fontSize: "0.875rem",
            fontWeight: 500,
            boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            animation: "fadeInUp 0.2s ease"
          }}
        >
          {toast.type === "success" ? "✅" : "❌"} {toast.msg}
        </div>
      )}

      <div className="panel-stack">
        <div className="section-head">
          <div className="section-copy">
            <p className="label">Tasks</p>
            <h2 className="panel-title">自动化任务</h2>
            <p className="muted">支持重试、手动完成和手动失败，先把人工兜底能力做出来。</p>
          </div>

          <div className="filter-row">
            <input
              className="search-field"
              placeholder="筛选任务号 / 类型 / 状态"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
        </div>

        <div className="panel-tabs">
          <button
            className={`panel-tab${activeTab === "all" ? " active" : ""}`}
            onClick={() => setActiveTab("all")}
            type="button"
          >
            全部任务
          </button>
          <button
            className={`panel-tab${activeTab === "manual" ? " active" : ""}`}
            onClick={() => setActiveTab("manual")}
            type="button"
          >
            人工处理
          </button>
          <button
            className={`panel-tab${activeTab === "retryable" ? " active" : ""}`}
            onClick={() => setActiveTab("retryable")}
            type="button"
          >
            可重试
          </button>
        </div>

        <div className="table-wrap workspace-table-wrap">
          <table className="data-table">
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
              {filteredTasks.length ? (
                filteredTasks.map((task) => {
                  const isActioning = actioning?.taskId === task.id;
                  return (
                    <tr key={task.id}>
                      <td>
                        <div className="strong mono">{task.id.slice(0, 12)}</div>
                        <div className="muted">
                          {task.type} · retry {task.retryCount}/{task.maxRetryCount}
                        </div>
                      </td>
                      <td>
                        <StatusBadge value={isActioning ? "RUNNING" : task.status} />
                      </td>
                      <td>
                        <div>{task.order?.orderNo ?? "-"}</div>
                        <div className="muted">{task.familyGroup?.groupName ?? "-"}</div>
                      </td>
                      <td>
                        <div>{task.lastErrorCode ?? "-"}</div>
                        <div className="muted">{task.lastErrorMessage ?? "No error"}</div>
                      </td>
                      <td>
                        <div className="inline-actions">
                          {canRetryTask(role, task.status) ? (
                            <button
                              className="button secondary small"
                              disabled={isActioning}
                              onClick={() => void handleRetry(task.id)}
                              type="button"
                            >
                              {isActioning && actioning?.action === "retry" ? "⏳ 重试中..." : "重试"}
                            </button>
                          ) : null}
                          {canManualCompleteTask(role, task.status) ? (
                            <button
                              className="button secondary small"
                              disabled={isActioning}
                              onClick={() => void handleManualComplete(task.id)}
                              type="button"
                            >
                              {isActioning && actioning?.action === "complete" ? "⏳ 处理中..." : "手动完成"}
                            </button>
                          ) : null}
                          {canManualFailTask(role, task.status) ? (
                            <button
                              className="button secondary small"
                              disabled={isActioning}
                              onClick={() => void handleManualFail(task.id)}
                              type="button"
                            >
                              {isActioning && actioning?.action === "fail" ? "⏳ 处理中..." : "手动失败"}
                            </button>
                          ) : null}
                          {!canRetryTask(role, task.status) &&
                          !canManualCompleteTask(role, task.status) &&
                          !canManualFailTask(role, task.status) ? (
                            <span className="muted">无可用动作</span>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : (
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
