"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";

import { apiRequest, getErrorMessage } from "../lib/client-api";
import {
  AccountSummary,
  FamilyGroupSummary,
  OrderSummary,
  RedeemCodeSummary,
  SessionUser,
  TaskSummary
} from "../lib/types";
import { AccountPanel } from "./account-panel";
import { GroupPanel } from "./group-panel";
import { MetricTile } from "./metric-tile";
import { OrdersPanel } from "./orders-panel";
import { RedeemCodesPanel } from "./redeem-codes-panel";
import { Spinner } from "./spinner";
import { StatusBadge } from "./status-badge";
import { TasksPanel } from "./tasks-panel";
import { ExpireScanPanel } from "./expire-scan-panel";
import { MemberLookupPanel } from "./member-lookup-panel";

type ConsoleData = {
  user: SessionUser;
  accounts: AccountSummary[];
  groups: FamilyGroupSummary[];
  orders: OrderSummary[];
  tasks: TaskSummary[];
  redeemCodes: RedeemCodeSummary[];
};

type ConsoleSection = "overview" | "accounts" | "groups" | "orders" | "tasks" | "codes" | "expire" | "lookup" | "settings";

// --- Bulk operation result types ---
export type CrossInviteResult = {
  allocated: { groupId: string; accountId: string; queued: string[] }[];
  unplaceable: string[];
  alreadyActive: string[];
  reason?: string;
};

export type CrossRemoveResult = {
  queued: string[];
  notFound: string[];
  alreadyRemoved: string[];
  failed: string[];
};

export type BulkGroupInviteResult = {
  queued: string[];
  rejected: string[];
  reason?: string;
};

export type BulkGroupRemoveResult = {
  queued: string[];
  notFound: string[];
  alreadyRemoved: string[];
  failed: string[];
};

const orderTerminalStatuses = new Set(["INVITE_SENT", "COMPLETED", "FAILED"]);

type ConsoleAppProps = {
  initialData: ConsoleData;
};

function isUnauthorized(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("unauthorized") ||
    normalized.includes("jwt") ||
    normalized.includes("401")
  );
}

export function ConsoleApp({ initialData }: ConsoleAppProps) {
  const router = useRouter();
  const [data, setData] = useState<ConsoleData>(initialData);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<ConsoleSection>("overview");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isActioning, setIsActioning] = useState(false);
  const [toast, setToast] = useState<{ type: "success" | "error" | "info"; msg: string } | null>(null);
  const [pwForm, setPwForm] = useState({ current: "", newPw: "", confirm: "" });
  const [pwLoading, setPwLoading] = useState(false);

  function showToast(type: "success" | "error" | "info", msg: string) {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 3800);
  }

  async function loadDashboard() {
    try {
      const [user, accounts, groups, orders, tasks, redeemCodes] = await Promise.all([
        apiRequest<SessionUser>("auth/me"),
        apiRequest<AccountSummary[]>("accounts"),
        apiRequest<FamilyGroupSummary[]>("family-groups"),
        apiRequest<OrderSummary[]>("orders"),
        apiRequest<TaskSummary[]>("tasks"),
        apiRequest<RedeemCodeSummary[]>("redeem-codes")
      ]);

      setData({ user, accounts, groups, orders, tasks, redeemCodes });
      setError(null);
    } catch (requestError) {
      const message = getErrorMessage(requestError);

      if (isUnauthorized(message)) {
        const prefix = (process.env.NEXT_PUBLIC_ADMIN_PATH_PREFIX ?? "console").replace(/^\/|\/$/g, "") || "console";
        router.push(`/${prefix}/login`);
        router.refresh();
        return;
      }

      setError(message);
    }
  }

  async function runAction(action: () => Promise<unknown>) {
    setIsActioning(true);
    const minDelay = new Promise<void>((res) => setTimeout(res, 600));
    try {
      const [result] = await Promise.allSettled([action(), minDelay]);
      if (result.status === "rejected") throw result.reason;
      await loadDashboard();
      setError(null);
      return true;
    } catch (actionError) {
      await minDelay;
      const message = getErrorMessage(actionError);

      if (isUnauthorized(message)) {
        const prefix = (process.env.NEXT_PUBLIC_ADMIN_PATH_PREFIX ?? "console").replace(/^\/|\/$/g, "") || "console";
        router.push(`/${prefix}/login`);
        router.refresh();
        return false;
      }

      setError(message);
      showToast("error", message);
      return false;
    } finally {
      setIsActioning(false);
    }
  }

  async function handleLogout() {
    await fetch("/api/session/logout", {
      method: "POST",
      cache: "no-store"
    });
    const prefix = (process.env.NEXT_PUBLIC_ADMIN_PATH_PREFIX ?? "console").replace(/^\/|\/$/g, "") || "console";
    router.push(`/${prefix}/login`);
    router.refresh();
  }

  async function createAccount(payload: {
    name: string;
    loginEmail: string;
    adspowerProfileId: string;
    loginPassword: string;
    totpSecret?: string;
    notes?: string;
  }) {
    return runAction(() =>
      apiRequest("accounts", {
        method: "POST",
        body: payload
      })
    );
  }

  async function bulkImport(lines: string[]) {
    try {
      const result = await apiRequest<{
        total: number;
        created: number;
        skipped: number;
        errorCount: number;
        createdEmails: string[];
        skippedEmails: string[];
        errors: string[];
      }>("accounts/bulk-import", {
        method: "POST",
        body: { lines }
      });
      // Refresh dashboard data after import
      await loadDashboard();
      setError(null);
      return result;
    } catch (importError) {
      const message = getErrorMessage(importError);
      if (isUnauthorized(message)) {
        const prefix = (process.env.NEXT_PUBLIC_ADMIN_PATH_PREFIX ?? "console").replace(/^\/|\/$/g, "") || "console";
        router.push(`/${prefix}/login`);
        router.refresh();
        return null;
      }
      setError(message);
      return null;
    }
  }

  async function deleteAccount(id: string) {
    return runAction(() =>
      apiRequest(`accounts/${id}`, { method: "DELETE" })
    );
  }

  async function updateAccount(id: string, payload: Record<string, string | undefined>) {
    return runAction(() =>
      apiRequest(`accounts/${id}`, {
        method: "PATCH",
        body: payload
      })
    );
  }

  async function confirmLogin(id: string) {
    return runAction(() =>
      apiRequest(`accounts/${id}/confirm-login`, { method: "POST" })
    );
  }

  async function createGroup(payload: {
    accountId: string;
    groupName: string;
    maxMembers: number;
  }) {
    return runAction(() =>
      apiRequest("family-groups", {
        method: "POST",
        body: payload
      })
    );
  }

  async function createCodes(payload: {
    count: number;
    product: string;
    codeType: "JOIN_GROUP" | "ACCOUNT_SWAP" | "SUBSCRIPTION";
    validDays?: number;
    swapLimit?: number;
    swapWindowHours?: number;
  }): Promise<string[] | null> {
    setIsActioning(true);
    try {
      // Returns the created RedeemCode records; we extract the code strings
      const created = await apiRequest<{ code: string }[]>("redeem-codes/batch-create", {
        method: "POST",
        body: payload
      });
      await loadDashboard();
      return created.map((c) => c.code);
    } catch (err) {
      const message = getErrorMessage(err);
      if (isUnauthorized(message)) {
        const prefix = (process.env.NEXT_PUBLIC_ADMIN_PATH_PREFIX ?? "console").replace(/^\/|\/$/g, "") || "console";
        router.push(`/${prefix}/login`);
        router.refresh();
        return null;
      }
      setError(message);
      showToast("error", message);
      return null;
    } finally {
      setIsActioning(false);
    }
  }

  async function syncGroup(groupId: string): Promise<{ taskId: string } | null> {
    setIsActioning(true);
    try {
      const result = await apiRequest<{ queued: boolean; taskId: string }>(
        `family-groups/${groupId}/sync`,
        { method: "POST" }
      );
      await loadDashboard();
      return result?.taskId ? { taskId: result.taskId } : null;
    } catch (err) {
      const message = getErrorMessage(err);
      if (isUnauthorized(message)) {
        const prefix = (process.env.NEXT_PUBLIC_ADMIN_PATH_PREFIX ?? "console").replace(/^\/|\/$/g, "") || "console";
        router.push(`/${prefix}/login`);
        router.refresh();
        return null;
      }
      showToast("error", message);
      return null;
    } finally {
      setIsActioning(false);
    }
  }

  async function removeMember(groupId: string, memberEmail: string): Promise<{ taskId: string } | null> {
    setIsActioning(true);
    try {
      const result = await apiRequest<{ queued: boolean; taskId: string }>(
        `family-groups/${groupId}/remove-member`,
        { method: "POST", body: { memberEmail } }
      );
      await loadDashboard();
      return result?.taskId ? { taskId: result.taskId } : null;
    } catch (err) {
      const message = getErrorMessage(err);
      if (isUnauthorized(message)) {
        const prefix = (process.env.NEXT_PUBLIC_ADMIN_PATH_PREFIX ?? "console").replace(/^\/|\/$/g, "") || "console";
        router.push(`/${prefix}/login`);
        router.refresh();
        return null;
      }
      showToast("error", message);
      return null;
    } finally {
      setIsActioning(false);
    }
  }

  async function replaceGroupMember(groupId: string, targetEmail: string, newEmail: string): Promise<{ taskId: string } | null> {
    setIsActioning(true);
    try {
      const result = await apiRequest<{ queued: boolean; taskId: string }>(
        `family-groups/${groupId}/replace-member`,
        { method: "POST", body: { targetMemberEmail: targetEmail, newUserEmail: newEmail } }
      );
      await loadDashboard();
      return result?.taskId ? { taskId: result.taskId } : null;
    } catch (err) {
      const message = getErrorMessage(err);
      if (isUnauthorized(message)) {
        const prefix = (process.env.NEXT_PUBLIC_ADMIN_PATH_PREFIX ?? "console").replace(/^\/|\/$/g, "") || "console";
        router.push(`/${prefix}/login`);
        router.refresh();
        return null;
      }
      showToast("error", message);
      return null;
    } finally {
      setIsActioning(false);
    }
  }

  async function crossInvite(emails: string[]): Promise<CrossInviteResult | null> {
    try {
      const result = await apiRequest<CrossInviteResult>("family-groups/cross-invite", {
        method: "POST",
        body: { emails }
      });
      await loadDashboard();
      return result;
    } catch (err) {
      const message = getErrorMessage(err);
      showToast("error", message);
      return null;
    }
  }

  async function crossRemove(memberEmails: string[]): Promise<CrossRemoveResult | null> {
    try {
      const result = await apiRequest<CrossRemoveResult>("family-groups/cross-remove", {
        method: "POST",
        body: { memberEmails }
      });
      await loadDashboard();
      return result;
    } catch (err) {
      const message = getErrorMessage(err);
      showToast("error", message);
      return null;
    }
  }

  async function bulkInviteGroup(groupId: string, emails: string[]): Promise<BulkGroupInviteResult | null> {
    try {
      const result = await apiRequest<BulkGroupInviteResult>(`family-groups/${groupId}/bulk-invite`, {
        method: "POST",
        body: { emails }
      });
      await loadDashboard();
      return result;
    } catch (err) {
      const message = getErrorMessage(err);
      showToast("error", message);
      return null;
    }
  }

  async function bulkRemoveGroup(groupId: string, memberEmails: string[]): Promise<BulkGroupRemoveResult | null> {
    try {
      const result = await apiRequest<BulkGroupRemoveResult>(`family-groups/${groupId}/bulk-remove`, {
        method: "POST",
        body: { memberEmails }
      });
      await loadDashboard();
      return result;
    } catch (err) {
      const message = getErrorMessage(err);
      showToast("error", message);
      return null;
    }
  }

  async function toggleAutoAssign(groupId: string): Promise<boolean> {
    try {
      await apiRequest(`family-groups/${groupId}/toggle-auto-assign`, { method: "POST" });
      await loadDashboard();
      return true;
    } catch (err) {
      const message = getErrorMessage(err);
      showToast("error", message);
      return false;
    }
  }

  async function retryTask(taskId: string) {
    return runAction(() =>
      apiRequest(`tasks/${taskId}/retry`, {
        method: "POST"
      })
    );
  }

  async function manualComplete(taskId: string, resultMessage: string) {
    return runAction(() =>
      apiRequest(`tasks/${taskId}/manual-complete`, {
        method: "POST",
        body: { resultMessage }
      })
    );
  }

  async function manualFail(taskId: string, reason: string) {
    return runAction(() =>
      apiRequest(`tasks/${taskId}/manual-fail`, {
        method: "POST",
        body: { reason }
      })
    );
  }

  async function cancelTask(taskId: string, reason: string) {
    return runAction(() =>
      apiRequest(`tasks/${taskId}/cancel`, {
        method: "POST",
        body: { reason }
      })
    );
  }

  async function disableCode(codeId: string) {
    return runAction(() =>
      apiRequest(`redeem-codes/${codeId}/disable`, {
        method: "PATCH"
      })
    );
  }

  async function replaceMember(payload: {
    orderId: string;
    targetMemberEmail: string;
    newUserEmail: string;
  }) {
    return runAction(() =>
      apiRequest(`orders/${payload.orderId}/replace-member`, {
        method: "POST",
        body: {
          targetMemberEmail: payload.targetMemberEmail,
          newUserEmail: payload.newUserEmail
        }
      })
    );
  }

  async function retryOrder(orderId: string) {
    return runAction(() =>
      apiRequest(`orders/${orderId}/retry`, {
        method: "POST"
      })
    );
  }

  const availableSlots =
    data.groups.reduce((sum, group) => sum + group.availableSlots, 0) ?? 0;
  const activeOrders =
    data.orders.filter((order) => !orderTerminalStatuses.has(order.status)).length ?? 0;
  const manualReviewTasks =
    data.tasks.filter((task) => task.status === "MANUAL_REVIEW").length ?? 0;
  const disabledAccounts =
    data.accounts.filter((account) => account.status !== "HEALTHY").length ?? 0;
  const pendingInvites =
    data.groups.reduce((sum, group) => sum + group.pendingInviteCount, 0) ?? 0;
  const unusedCodes =
    data.redeemCodes.filter((code) => code.status === "UNUSED").length ?? 0;
  const recentOrders = data.orders.slice(0, 5);
  const reviewQueue = data.tasks.filter((task) => task.status === "MANUAL_REVIEW").slice(0, 5);

  const navigation = [
    {
      id: "overview" as const,
      label: "总览",
      caption: "运营概览",
      metric: `${activeOrders} 处理中`
    },
    {
      id: "accounts" as const,
      label: "母号池",
      caption: "账号管理",
      metric: `${data.accounts.length} 个`
    },
    {
      id: "groups" as const,
      label: "家庭组",
      caption: "家庭组管理",
      metric: `${availableSlots} 空位`
    },
    {
      id: "orders" as const,
      label: "订单",
      caption: "订单管理",
      metric: `${data.orders.length} 条`
    },
    {
      id: "tasks" as const,
      label: "任务",
      caption: "自动化任务",
      metric: `${manualReviewTasks} 待处理`
    },
    {
      id: "codes" as const,
      label: "卡密",
      caption: "卡密管理",
      metric: `${unusedCodes} 未使用`
    },
    {
      id: "expire" as const,
      label: "到期扫描",
      caption: "过期订单",
      metric: `${data.orders.filter((o) => o.status === "EXPIRED").length} 已过期`
    },
    {
      id: "lookup" as const,
      label: "成员管理",
      caption: "查询 & 操作",
      metric: ""
    },
    {
      id: "settings" as const,
      label: "修改密码",
      caption: "安全设置",
      metric: ""
    }
  ];

  function renderWorkspace() {
    switch (activeSection) {
      case "overview":
        return (
          <div className="panel-stack">
            <section className="surface-grid three-up">
              <MetricTile
                title="可用空位"
                value={String(availableSlots)}
                description="当前所有家庭组剩余可发邀请空位。"
              />
              <MetricTile
                title="待接受邀请"
                value={String(pendingInvites)}
                description="已发出但还没完成接受的邀请数量。"
              />
              <MetricTile
                title="待人工处理"
                value={String(manualReviewTasks)}
                description="已经进入人工处理队列的任务数量。"
              />
              <MetricTile
                title="异常母号"
                value={String(disabledAccounts)}
                description="非正常状态的母号数量，用于快速发现异常。"
              />
              <MetricTile
                title="可用卡密"
                value={String(unusedCodes)}
                description="当前仍可兑换、未被消耗的卡密库存。"
              />
              <MetricTile
                title="进行中订单"
                value={String(activeOrders)}
                description="仍在排队、执行或等待用户接受邀请的订单。"
              />
            </section>

            <section className="surface-grid two-up">
              <article className="glass-panel">
                <div className="panel-stack">
                  <div className="section-copy">
                    <p className="label">最近订单</p>
                    <h2 className="panel-title">最近订单</h2>
                    <p className="muted">优先看最新提交是否已经进入正确状态。</p>
                  </div>

                  {recentOrders.length ? (
                    <div className="list-stack">
                      {recentOrders.map((order) => (
                        <div className="list-card" key={order.id}>
                          <div className="split-head">
                            <div>
                              <div className="strong mono">{order.orderNo}</div>
                              <div className="muted">{order.userEmail}</div>
                            </div>
                            <StatusBadge value={order.status} />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="empty-state">还没有订单。</div>
                  )}
                </div>
              </article>

              <article className="glass-panel">
                <div className="panel-stack">
                  <div className="section-copy">
                    <p className="label">待处理队列</p>
                    <h2 className="panel-title">人工接管队列</h2>
                    <p className="muted">这里保留最近需要人处理的任务，先处理最紧急的。</p>
                  </div>

                  {reviewQueue.length ? (
                    <div className="list-stack">
                      {reviewQueue.map((task) => (
                        <div className="list-card" key={task.id}>
                          <div className="split-head">
                            <div>
                              <div className="strong mono">{task.order?.orderNo ?? task.id.slice(0, 12)}</div>
                              <div className="muted">
                                {task.familyGroup?.groupName ?? "-"} · {task.type}
                              </div>
                            </div>
                            <StatusBadge value={task.status} />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="empty-state">当前没有待人工任务。</div>
                  )}
                </div>
              </article>
            </section>
          </div>
        );
      case "accounts":
        return (
            <AccountPanel
            accounts={data.accounts}
            onCreate={createAccount}
            onBulkImport={bulkImport}
            onDelete={deleteAccount}
            onUpdate={updateAccount}
            onConfirmLogin={confirmLogin}
            role={data.user.role}
          />
        );
      case "groups":
        return (
          <GroupPanel
            accounts={data.accounts}
            groups={data.groups}
            onCreate={createGroup}
            onSync={syncGroup}
            onRemoveMember={removeMember}
            onReplaceMember={replaceGroupMember}
            onCrossInvite={crossInvite}
            onCrossRemove={crossRemove}
            onBulkInviteGroup={bulkInviteGroup}
            onBulkRemoveGroup={bulkRemoveGroup}
            onToggleAutoAssign={toggleAutoAssign}
            role={data.user.role}
          />
        );
      case "orders":
        return (
          <OrdersPanel
            orders={data.orders}
            onReplace={replaceMember}
            onRetry={retryOrder}
            role={data.user.role}
          />
        );
      case "tasks":
        return (
          <TasksPanel
            tasks={data.tasks}
            onManualComplete={manualComplete}
            onManualFail={manualFail}
            onCancel={cancelTask}
            onRetry={retryTask}
            role={data.user.role}
          />
        );
      case "codes":
        return (
          <RedeemCodesPanel
            codes={data.redeemCodes}
            onCreate={createCodes}
            onDisable={disableCode}
            role={data.user.role}
          />
        );
      case "expire":
        return (
          <ExpireScanPanel
            expiredOrders={data.orders.filter((o) => o.status === "EXPIRED")}
          />
        );
      case "lookup":
        return (
          <MemberLookupPanel
            onRemoveMember={removeMember}
            onRetryOrder={retryOrder}
            onReplaceMember={replaceMember}
            showToast={showToast}
          />
        );
      case "settings":
        return (
          <div className="panel-stack">
            <div className="section-copy">
              <p className="label">Security</p>
              <h2 className="panel-title">修改登录密码</h2>
              <p className="muted">修改当前账号 ({data.user.email}) 的登录密码。</p>
            </div>
            <form
              className="form-stack"
              onSubmit={async (e) => {
                e.preventDefault();
                if (pwForm.newPw !== pwForm.confirm) {
                  showToast("error", "两次输入的新密码不一致");
                  return;
                }
                if (pwForm.newPw.length < 6) {
                  showToast("error", "新密码至少 6 个字符");
                  return;
                }
                setPwLoading(true);
                try {
                  await apiRequest("auth/change-password", {
                    method: "PATCH",
                    body: {
                      currentPassword: pwForm.current,
                      newPassword: pwForm.newPw
                    }
                  });
                  showToast("success", "密码修改成功，下次登录请使用新密码");
                  setPwForm({ current: "", newPw: "", confirm: "" });
                } catch (err) {
                  const msg = getErrorMessage(err);
                  showToast("error", msg.includes("incorrect") ? "当前密码错误" : msg);
                } finally {
                  setPwLoading(false);
                }
              }}
            >
              <label className="field-label">
                当前密码
                <input
                  type="password"
                  className="field-input"
                  value={pwForm.current}
                  onChange={(e) => setPwForm((p) => ({ ...p, current: e.target.value }))}
                  required
                  autoComplete="current-password"
                />
              </label>
              <label className="field-label">
                新密码（至少 6 位）
                <input
                  type="password"
                  className="field-input"
                  value={pwForm.newPw}
                  onChange={(e) => setPwForm((p) => ({ ...p, newPw: e.target.value }))}
                  required
                  minLength={6}
                  autoComplete="new-password"
                />
              </label>
              <label className="field-label">
                确认新密码
                <input
                  type="password"
                  className="field-input"
                  value={pwForm.confirm}
                  onChange={(e) => setPwForm((p) => ({ ...p, confirm: e.target.value }))}
                  required
                  minLength={6}
                  autoComplete="new-password"
                />
              </label>
              <button className="button primary" type="submit" disabled={pwLoading}>
                {pwLoading ? "修改中..." : "确认修改"}
              </button>
            </form>
          </div>
        );
      default:
        return null;
    }
  }

  return (
    <>
      {/* Global loading bar */}
      {(isRefreshing || isActioning) && <div className="gfa-loading-bar" />}

      {/* Global toast */}
      {toast && (
        <div className={`gfa-toast ${toast.type}`}>
          {toast.type === "success" ? "✅" : toast.type === "error" ? "❌" : "ℹ️"} {toast.msg}
        </div>
      )}

      <nav className="nav-strip">
        <div className="nav-brand">
          <div className="nav-mark">GO</div>
          <span>Operations Console</span>
        </div>

        <div className="nav-links">
          <button
            className="button secondary"
            disabled={isRefreshing || isActioning}
            onClick={async () => {
              setIsRefreshing(true);
              try {
                await loadDashboard();
              } finally {
                setIsRefreshing(false);
              }
            }}
            type="button"
            style={{ gap: 8 }}
          >
            {isRefreshing ? (
              <><Spinner size={14} color="currentColor" /> 刷新中...</>
            ) : "刷新数据"}
          </button>
          <Link className="pill-link" href="/redeem">
            公共提交页
          </Link>
          <button className="button" onClick={handleLogout} type="button">
            退出登录
          </button>
        </div>
      </nav>

      <section className="console-layout">
        <aside className="console-sidebar">
          <div className="glass-panel">
            <div className="panel-stack">
              <div>
                <p className="label">当前会话</p>
                <h2 className="panel-title">{data.user.displayName}</h2>
                <p className="muted">{data.user.email}</p>
              </div>
              <StatusBadge value={data.user.role} tone="sky" />
            </div>
          </div>

          <div className="glass-panel">
            <div className="panel-stack">
              <p className="label">导航菜单</p>
              <div className="console-menu">
                {navigation.map((item) => (
                  <button
                    className={`console-menu-button${activeSection === item.id ? " active" : ""}`}
                    key={item.id}
                    onClick={() => setActiveSection(item.id)}
                    type="button"
                  >
                    <span className="console-menu-copy">
                      <span>{item.label}</span>
                      <small>{item.caption}</small>
                    </span>
                    <span className="console-menu-metric">{item.metric}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </aside>

        <div className="console-content">
          {error ? <div className="notice error">{error}</div> : null}
          <section className="glass-panel workspace-shell">
            <div className="panel-stack">
              <div className="workspace-head">
                <div className="section-copy">
                  <p className="label">工作区</p>
                  <h2 className="panel-title">
                    {navigation.find((item) => item.id === activeSection)?.label ?? "控制台"}
                  </h2>
                  <p className="muted">
                    {navigation.find((item) => item.id === activeSection)?.metric ?? ""}
                  </p>
                </div>
              </div>
              {renderWorkspace()}
            </div>
          </section>
        </div>
      </section>
    </>
  );
}
