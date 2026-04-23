"use client";

import { useState, useEffect, useCallback } from "react";
import { apiRequest, getErrorMessage } from "../lib/client-api";
import "./scheduler-panel.css";

type SchedulerConfig = {
  id: string;
  enabled: boolean;
  maxAccountsPerRun: number;
  accountCooldownMinutes: number;
  runWindowStart: string;
  runWindowEnd: string;
  staleSyncThresholdMinutes: number;
  syncEnabled: boolean;
  removeExpiredMembersEnabled: boolean;
  cancelTimedOutInvitesEnabled: boolean;
  deduplicateMembersEnabled: boolean;
  inviteTimeoutDays: number;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunSummary: string | null;
};

type SchedulerStatus = {
  isRunning: boolean;
  runningSince: string | null;
  remainingLockSeconds: number;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunSummary: {
    totalAccounts: number;
    processedAccounts: number;
    syncTasks: number;
    removeTasks: number;
    cancelledInvites: number;
    deduplicatedMembers: number;
    errors: string[];
  } | null;
};

type SchedulerTask = {
  id: string;
  type: string;
  status: string;
  source: string;
  payload: string;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  familyGroup: { id: string; groupName: string } | null;
  account: { id: string; name: string; loginEmail: string } | null;
};

type PaginatedTasks = {
  data: SchedulerTask[];
  total: number;
  page: number;
  pageSize: number;
};

type Props = {
  showToast: (type: "success" | "error" | "info", msg: string) => void;
};

const TYPE_LABELS: Record<string, string> = {
  SYNC_FAMILY_GROUP: "同步",
  REMOVE_MEMBER: "踢人",
  INVITE_MEMBER: "邀请",
  REPLACE_MEMBER: "替换",
};

const STATUS_DOTS: Record<string, string> = {
  SUCCESS: "success",
  INVITE_SENT: "success",
  REPLACED_AND_INVITE_SENT: "success",
  PENDING: "pending",
  RUNNING: "running",
  FAILED_FINAL: "failed",
  FAILED_RETRYABLE: "failed",
  MANUAL_REVIEW: "failed",
  CANCELLED: "failed",
};

function formatTime(iso: string | null): string {
  if (!iso) return "--";
  const d = new Date(iso);
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatShortTime(iso: string | null): string {
  if (!iso) return "--:--";
  const d = new Date(iso);
  return d.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function parseErrorMessage(msg: string | null): { text: string; isCooldown: boolean } {
  if (!msg) return { text: "", isCooldown: false };
  // Format LOGIN_COOLDOWN: 13s remaining -> human-friendly
  const cooldownMatch = msg.match(/LOGIN_COOLDOWN[:\s]+([\d]+)s\s*remaining/i);
  if (cooldownMatch) {
    return { text: `登录冷却中，还需 ${cooldownMatch[1]}秒`, isCooldown: true };
  }
  return { text: msg, isCooldown: false };
}

function parsePayloadEmail(payload: string): string {
  try {
    const p = JSON.parse(payload);
    return p.memberEmail || p.userEmail || "";
  } catch {
    return "";
  }
}

const PAGE_SIZE = 15;

export function SchedulerPanel({ showToast }: Props) {
  const [config, setConfig] = useState<SchedulerConfig | null>(null);
  const [status, setStatus] = useState<SchedulerStatus | null>(null);
  const [tasks, setTasks] = useState<SchedulerTask[]>([]);
  const [taskTotal, setTaskTotal] = useState(0);
  const [taskPage, setTaskPage] = useState(1);
  const [draft, setDraft] = useState<Partial<SchedulerConfig>>({});
  const [saving, setSaving] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [searching, setSearching] = useState(false);

  const load = useCallback(async (page = taskPage, opts?: { search?: string; type?: string; status?: string }) => {
    const search = opts?.search ?? searchQuery;
    const type = opts?.type ?? filterType;
    const statusFilter = opts?.status ?? filterStatus;
    const hasFilters = !!(search || type || statusFilter);
    try {
      let taskUrl = `scheduler/tasks?page=${page}&pageSize=${PAGE_SIZE}`;
      if (search) taskUrl += `&search=${encodeURIComponent(search)}`;
      if (type) taskUrl += `&type=${encodeURIComponent(type)}`;
      if (statusFilter) taskUrl += `&status=${encodeURIComponent(statusFilter)}`;

      const requests: [Promise<SchedulerConfig>, Promise<SchedulerStatus>, Promise<PaginatedTasks>] = [
        apiRequest<SchedulerConfig>("scheduler/config"),
        apiRequest<SchedulerStatus>("scheduler/status"),
        apiRequest<PaginatedTasks>(taskUrl),
      ];
      const [c, s, t] = await Promise.all(requests);
      setConfig(c);
      setStatus(s);
      setTasks(t.data);
      setTaskTotal(t.total);
      setTaskPage(t.page);
      if (!hasFilters) setDraft({});
    } catch (err) {
      showToast("error", getErrorMessage(err));
    } finally {
      setLoading(false);
      setSearching(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showToast, taskPage, searchQuery, filterType, filterStatus]);

  function handleSearch() {
    setSearching(true);
    setTaskPage(1);
    load(1, { search: searchQuery, type: filterType, status: filterStatus });
  }

  function handleClearFilters() {
    setSearchQuery("");
    setFilterType("");
    setFilterStatus("");
    setTaskPage(1);
    load(1, { search: "", type: "", status: "" });
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 15_000);
    return () => clearInterval(interval);
  }, [load]);

  async function saveConfig() {
    if (!config || Object.keys(draft).length === 0) return;
    setSaving(true);
    try {
      const updated = await apiRequest<SchedulerConfig>("scheduler/config", {
        method: "PATCH",
        body: draft,
      });
      setConfig(updated);
      setDraft({});
      showToast("success", "配置已保存");
    } catch (err) {
      showToast("error", getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function triggerRun() {
    setShowConfirm(false);
    try {
      const res = await apiRequest<{ started: boolean; reason?: string }>(
        "scheduler/run",
        { method: "POST" }
      );
      if (res.started) {
        showToast("success", "手动执行已触发");
        setTimeout(load, 2000);
      } else {
        showToast("info", res.reason || "调度器正在运行中");
      }
    } catch (err) {
      showToast("error", getErrorMessage(err));
    }
  }

  const merged = { ...config, ...draft } as SchedulerConfig;

  function field<K extends keyof SchedulerConfig>(key: K, val: SchedulerConfig[K]) {
    setDraft((prev) => ({ ...prev, [key]: val }));
  }

  if (loading || !config || !status) {
    return (
      <div className="scheduler-shell">
        <div className="sch-empty">加载中...</div>
      </div>
    );
  }

  const hasDraft = Object.keys(draft).length > 0;
  const summary = status.lastRunSummary;

  // Determine status display
  let statusClass: string;
  let statusIcon: string;
  let statusText: string;

  if (status.isRunning) {
    statusClass = "running";
    statusIcon = "⟳";
    statusText = "运行中";
  } else if (!merged.enabled) {
    statusClass = "disabled";
    statusIcon = "⏸";
    statusText = "已关闭";
  } else {
    statusClass = "idle";
    statusIcon = "◉";
    statusText = "空闲待命";
  }

  return (
    <div className="scheduler-shell">

      {/* ── Top Grid: Status + Config ── */}
      <div className="sch-grid">

        {/* Status Card */}
        <div className="sch-card">
          <div className="sch-card-title">运行状态</div>
          <div className="sch-status-area">
            <div className="sch-status-main">
              <div className={`sch-status-dot ${statusClass}`}>{statusIcon}</div>
              <div className="sch-status-info">
                <div className="sch-status-label">{statusText}</div>
                <div className="sch-status-meta">
                  {status.lastRunAt && (
                    <div>上次执行：{formatTime(status.lastRunAt)}</div>
                  )}
                  {status.lastRunStatus && (
                    <div>
                      结果：
                      {status.lastRunStatus === "SUCCESS"
                        ? "✓ 成功"
                        : status.lastRunStatus === "PARTIAL"
                          ? "⚠ 部分成功"
                          : status.lastRunStatus === "SKIPPED"
                            ? "○ 无候选"
                            : "✗ 失败"}
                    </div>
                  )}
                  {status.isRunning && status.remainingLockSeconds > 0 && (
                    <div>超时保护：{Math.ceil(status.remainingLockSeconds / 60)} 分钟后释放锁</div>
                  )}
                </div>
              </div>
            </div>

            <button
              className="sch-run-btn"
              disabled={status.isRunning}
              onClick={() => setShowConfirm(true)}
              style={{ width: "100%" }}
            >
              {status.isRunning ? "执行中..." : "▶ 立即执行"}
            </button>
          </div>
        </div>

        {/* Config Card */}
        <div className="sch-card">
          <div className="sch-card-title">维护配置</div>
          <div className="sch-config-form">
            <div className="sch-field">
              <div className="sch-field-label">
                启用自动维护
                <small>每 5 分钟检查一次</small>
              </div>
              <label className="sch-toggle">
                <input
                  type="checkbox"
                  checked={merged.enabled}
                  onChange={(e) => field("enabled", e.target.checked)}
                />
                <span className="sch-toggle-track" />
              </label>
            </div>

            <div className="sch-field">
              <div className="sch-field-label">执行窗口</div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  className="sch-input time"
                  type="time"
                  value={merged.runWindowStart}
                  onChange={(e) => field("runWindowStart", e.target.value)}
                />
                <span style={{ color: "var(--sch-fg-muted)" }}>~</span>
                <input
                  className="sch-input time"
                  type="time"
                  value={merged.runWindowEnd}
                  onChange={(e) => field("runWindowEnd", e.target.value)}
                />
              </div>
            </div>

            <div className="sch-field">
              <div className="sch-field-label">
                每轮上限
                <small>单次最多处理的账号数</small>
              </div>
              <input
                className="sch-input"
                type="number"
                min={1}
                max={100}
                value={merged.maxAccountsPerRun}
                onChange={(e) => field("maxAccountsPerRun", parseInt(e.target.value) || 1)}
              />
            </div>

            <div className="sch-field">
              <div className="sch-field-label">
                冷却时间（分钟）
                <small>同一账号两次维护最小间隔</small>
              </div>
              <input
                className="sch-input"
                type="number"
                min={5}
                value={merged.accountCooldownMinutes}
                onChange={(e) => field("accountCooldownMinutes", parseInt(e.target.value) || 60)}
              />
            </div>

            <div className="sch-field">
              <div className="sch-field-label">
                同步阈值（分钟）
                <small>家庭组距上次同步超过此时间才触发</small>
              </div>
              <input
                className="sch-input"
                type="number"
                min={60}
                value={merged.staleSyncThresholdMinutes}
                onChange={(e) => field("staleSyncThresholdMinutes", parseInt(e.target.value) || 1440)}
              />
            </div>

            <div className="sch-field">
              <div className="sch-field-label">
                邀请超时（天）
                <small>超时未接受自动取消</small>
              </div>
              <input
                className="sch-input"
                type="number"
                min={1}
                value={merged.inviteTimeoutDays}
                onChange={(e) => field("inviteTimeoutDays", parseInt(e.target.value) || 3)}
              />
            </div>

            <div className="sch-steps-header">执行步骤开关</div>

            <div className="sch-field">
              <div className="sch-field-label">同步家庭组</div>
              <label className="sch-toggle">
                <input
                  type="checkbox"
                  checked={merged.syncEnabled}
                  onChange={(e) => field("syncEnabled", e.target.checked)}
                />
                <span className="sch-toggle-track" />
              </label>
            </div>

            <div className="sch-field">
              <div className="sch-field-label">踢出到期成员</div>
              <label className="sch-toggle">
                <input
                  type="checkbox"
                  checked={merged.removeExpiredMembersEnabled}
                  onChange={(e) => field("removeExpiredMembersEnabled", e.target.checked)}
                />
                <span className="sch-toggle-track" />
              </label>
            </div>

            <div className="sch-field">
              <div className="sch-field-label">取消超时邀请</div>
              <label className="sch-toggle">
                <input
                  type="checkbox"
                  checked={merged.cancelTimedOutInvitesEnabled}
                  onChange={(e) => field("cancelTimedOutInvitesEnabled", e.target.checked)}
                />
                <span className="sch-toggle-track" />
              </label>
            </div>

            <div className="sch-field">
              <div className="sch-field-label">跨组去重</div>
              <label className="sch-toggle">
                <input
                  type="checkbox"
                  checked={merged.deduplicateMembersEnabled}
                  onChange={(e) => field("deduplicateMembersEnabled", e.target.checked)}
                />
                <span className="sch-toggle-track" />
              </label>
            </div>

            <button
              className="sch-save-btn"
              disabled={saving || !hasDraft}
              onClick={saveConfig}
            >
              {saving ? "保存中..." : "保存配置"}
            </button>
          </div>
        </div>
      </div>

      {/* ── Summary Stats ── */}
      {summary && (
        <div className="sch-summary-row">
          <span className="sch-summary-chip">
            同步 <span className="sch-chip-num">{summary.syncTasks}</span>
          </span>
          <span className="sch-summary-chip">
            踢人 <span className="sch-chip-num">{summary.removeTasks}</span>
          </span>
          <span className="sch-summary-chip">
            取消邀请 <span className="sch-chip-num">{summary.cancelledInvites}</span>
          </span>
          <span className="sch-summary-chip">
            去重 <span className="sch-chip-num">{summary.deduplicatedMembers}</span>
          </span>
          {summary.errors.length > 0 && (
            <span className="sch-summary-chip" style={{ borderColor: "var(--sch-danger)" }}>
              错误 <span className="sch-chip-num" style={{ color: "var(--sch-danger)" }}>{summary.errors.length}</span>
            </span>
          )}
        </div>
      )}

      {/* ── Timeline Log ── */}
      <div className="sch-card">
        <div className="sch-log-header">
          <div className="sch-card-title" style={{ margin: 0 }}>执行日志（最近 3 天）</div>
          {taskTotal > 0 && (
            <span className="sch-log-count">
              共 {taskTotal} 条
            </span>
          )}
        </div>

        {/* ── Search & Filters ── */}
        <div style={{
          display: "flex",
          gap: "0.5rem",
          flexWrap: "wrap",
          alignItems: "center",
          padding: "0.75rem 0",
          borderBottom: "1px solid var(--sch-border)",
        }}>
          <input
            type="text"
            className="sch-input"
            placeholder="搜索邮箱..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            style={{ flex: 1, minWidth: 140 }}
          />
          <select
            className="sch-input"
            value={filterType}
            onChange={(e) => { setFilterType(e.target.value); }}
            style={{ width: "auto", minWidth: 100 }}
          >
            <option value="">全部类型</option>
            <option value="SYNC_FAMILY_GROUP">同步</option>
            <option value="REMOVE_MEMBER">踢人</option>
            <option value="INVITE_MEMBER">邀请</option>
            <option value="REPLACE_MEMBER">替换</option>
          </select>
          <select
            className="sch-input"
            value={filterStatus}
            onChange={(e) => { setFilterStatus(e.target.value); }}
            style={{ width: "auto", minWidth: 100 }}
          >
            <option value="">全部状态</option>
            <option value="SUCCESS">成功</option>
            <option value="INVITE_SENT">邀请已发送</option>
            <option value="REPLACED_AND_INVITE_SENT">替换完成</option>
            <option value="PENDING">等待中</option>
            <option value="RUNNING">执行中</option>
            <option value="FAILED_FINAL">失败</option>
            <option value="FAILED_RETRYABLE">可重试</option>
            <option value="MANUAL_REVIEW">人工审核</option>
            <option value="CANCELLED">已取消</option>
          </select>
          <button
            className="sch-page-btn"
            onClick={handleSearch}
            disabled={searching}
            style={{ padding: "0.35rem 0.75rem", fontWeight: 600 }}
          >
            {searching ? "搜索中..." : "🔍 搜索"}
          </button>
          {(searchQuery || filterType || filterStatus) && (
            <button
              className="sch-page-btn"
              onClick={handleClearFilters}
              style={{ padding: "0.35rem 0.75rem", color: "var(--sch-danger, #f87171)" }}
            >
              ✕ 清除
            </button>
          )}
        </div>
        {tasks.length === 0 ? (
          <div className="sch-empty">暂无执行记录</div>
        ) : (
          <>
            <ul className="sch-timeline">
              {tasks.map((task) => {
                const email = parsePayloadEmail(task.payload);
                const dotClass = STATUS_DOTS[task.status] ?? "pending";

                return (
                  <li className="sch-timeline-item" key={task.id}>
                    <span className="sch-tl-time">
                      {formatShortTime(task.startedAt || task.createdAt)}
                    </span>
                    <span className={`sch-tl-dot ${dotClass}`} />
                    <div className="sch-tl-content">
                      <span className="sch-tl-type">
                        {TYPE_LABELS[task.type] ?? task.type}
                      </span>
                      {task.familyGroup?.groupName && (
                        <span>{task.familyGroup.groupName}</span>
                      )}
                      {email && (
                        <span className="sch-tl-detail"> · {email}</span>
                      )}
                      {task.account && (
                        <span className="sch-tl-detail">
                          {" ← "}
                          {task.account.loginEmail}
                        </span>
                      )}
                      {task.source === "expire-scan" && (
                        <span className="sch-tl-detail"> [到期扫描]</span>
                      )}
                      {task.lastErrorMessage && (() => {
                        const { text, isCooldown } = parseErrorMessage(task.lastErrorMessage);
                        return isCooldown
                          ? <div className="sch-tl-cooldown">{text}</div>
                          : <div className="sch-tl-error">{text}</div>;
                      })()}
                    </div>
                  </li>
                );
              })}
            </ul>

            {/* ── Pagination ── */}
            {taskTotal > PAGE_SIZE && (
              <div className="sch-pagination">
                <button
                  className="sch-page-btn"
                  disabled={taskPage <= 1}
                  onClick={() => load(taskPage - 1)}
                >
                  ‹ 上一页
                </button>
                <div className="sch-page-nums">
                  {(() => {
                    const totalPages = Math.ceil(taskTotal / PAGE_SIZE);
                    const pages: (number | string)[] = [];
                    const delta = 2;
                    for (let i = 1; i <= totalPages; i++) {
                      if (
                        i === 1 ||
                        i === totalPages ||
                        (i >= taskPage - delta && i <= taskPage + delta)
                      ) {
                        pages.push(i);
                      } else if (
                        pages.length > 0 &&
                        pages[pages.length - 1] !== "..."
                      ) {
                        pages.push("...");
                      }
                    }
                    return pages.map((p, idx) =>
                      p === "..." ? (
                        <span key={`ellipsis-${idx}`} className="sch-page-ellipsis">…</span>
                      ) : (
                        <button
                          key={p}
                          className={`sch-page-num ${p === taskPage ? "active" : ""}`}
                          onClick={() => load(p as number)}
                        >
                          {p}
                        </button>
                      )
                    );
                  })()}
                </div>
                <button
                  className="sch-page-btn"
                  disabled={taskPage >= Math.ceil(taskTotal / PAGE_SIZE)}
                  onClick={() => load(taskPage + 1)}
                >
                  下一页 ›
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Confirm Dialog ── */}
      {showConfirm && (
        <div className="sch-confirm-overlay" onClick={() => setShowConfirm(false)}>
          <div className="sch-confirm-box" onClick={(e) => e.stopPropagation()}>
            <h3>确认立即执行？</h3>
            <p>
              将跳过时间窗口限制，立即开始一轮自动维护。
              运行期间不会重复触发。
            </p>
            <div className="sch-confirm-actions">
              <button onClick={() => setShowConfirm(false)}>取消</button>
              <button className="sch-confirm-yes" onClick={triggerRun}>
                确认执行
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
