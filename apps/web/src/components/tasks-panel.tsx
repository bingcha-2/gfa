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

export function TasksPanel({
  tasks,
  role,
  onRetry,
  onManualComplete,
  onManualFail
}: TasksPanelProps) {
  const [filter, setFilter] = useState("");
  const [activeTab, setActiveTab] = useState<"all" | "manual" | "retryable">("all");
  const deferredFilter = useDeferredValue(filter);

  const filteredTasks = tasks.filter((task) => {
    if (activeTab === "manual" && task.status !== "MANUAL_REVIEW") {
      return false;
    }

    if (
      activeTab === "retryable" &&
      !["FAILED_RETRYABLE", "FAILED_FINAL", "MANUAL_REVIEW"].includes(task.status)
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

  async function handleManualComplete(taskId: string) {
    const resultMessage =
      window.prompt("填写手动完成说明", "Manually completed from console") ?? "";
    await onManualComplete(taskId, resultMessage);
  }

  async function handleManualFail(taskId: string) {
    const reason = window.prompt("填写失败原因", "Manual review failed") ?? "";
    await onManualFail(taskId, reason);
  }

  return (
    <section id="tasks" className="glass-panel">
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
                filteredTasks.map((task) => (
                  <tr key={task.id}>
                    <td>
                      <div className="strong mono">{task.id.slice(0, 12)}</div>
                      <div className="muted">
                        {task.type} · retry {task.retryCount}/{task.maxRetryCount}
                      </div>
                    </td>
                    <td>
                      <StatusBadge value={task.status} />
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
                            onClick={() => void onRetry(task.id)}
                            type="button"
                          >
                            重试
                          </button>
                        ) : null}
                        {canManualCompleteTask(role, task.status) ? (
                          <button
                            className="button secondary small"
                            onClick={() => void handleManualComplete(task.id)}
                            type="button"
                          >
                            手动完成
                          </button>
                        ) : null}
                        {canManualFailTask(role, task.status) ? (
                          <button
                            className="button secondary small"
                            onClick={() => void handleManualFail(task.id)}
                            type="button"
                          >
                            手动失败
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
                ))
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
