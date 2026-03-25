"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
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
import { StatusBadge } from "./status-badge";
import { TasksPanel } from "./tasks-panel";

type ConsoleData = {
  user: SessionUser;
  accounts: AccountSummary[];
  groups: FamilyGroupSummary[];
  orders: OrderSummary[];
  tasks: TaskSummary[];
  redeemCodes: RedeemCodeSummary[];
};

type ConsoleSection = "overview" | "accounts" | "groups" | "orders" | "tasks" | "codes";

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
  const [isLoading, startTransition] = useTransition();

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
        router.push("/console/login");
        router.refresh();
        return;
      }

      setError(message);
    }
  }

  async function runAction(action: () => Promise<unknown>) {
    try {
      await action();
      await loadDashboard();
      setError(null);
      return true;
    } catch (actionError) {
      const message = getErrorMessage(actionError);

      if (isUnauthorized(message)) {
        router.push("/console/login");
        router.refresh();
        return false;
      }

      setError(message);
      return false;
    }
  }

  async function handleLogout() {
    await fetch("/api/session/logout", {
      method: "POST",
      cache: "no-store"
    });
    router.push("/console/login");
    router.refresh();
  }

  async function createAccount(payload: {
    name: string;
    loginEmail: string;
    adspowerProfileId: string;
    loginPassword?: string;
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
  }) {
    return runAction(() =>
      apiRequest("redeem-codes/batch-create", {
        method: "POST",
        body: payload
      })
    );
  }

  async function syncGroup(groupId: string) {
    return runAction(() =>
      apiRequest(`family-groups/${groupId}/sync`, {
        method: "POST"
      })
    );
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
      caption: "Summary",
      metric: `${activeOrders} active`
    },
    {
      id: "accounts" as const,
      label: "母号池",
      caption: "Accounts",
      metric: `${data.accounts.length} total`
    },
    {
      id: "groups" as const,
      label: "家庭组",
      caption: "Groups",
      metric: `${availableSlots} slots`
    },
    {
      id: "orders" as const,
      label: "订单",
      caption: "Orders",
      metric: `${data.orders.length} total`
    },
    {
      id: "tasks" as const,
      label: "任务",
      caption: "Tasks",
      metric: `${manualReviewTasks} review`
    },
    {
      id: "codes" as const,
      label: "卡密",
      caption: "Codes",
      metric: `${unusedCodes} unused`
    }
  ];

  function renderWorkspace() {
    switch (activeSection) {
      case "overview":
        return (
          <div className="panel-stack">
            <section className="surface-grid three-up">
              <MetricTile
                title="Available Slots"
                value={String(availableSlots)}
                description="当前所有家庭组剩余可发邀请空位。"
              />
              <MetricTile
                title="Pending Invites"
                value={String(pendingInvites)}
                description="已发出但还没完成接受的邀请数量。"
              />
              <MetricTile
                title="Manual Review"
                value={String(manualReviewTasks)}
                description="已经进入人工处理队列的任务数量。"
              />
              <MetricTile
                title="Account Alerts"
                value={String(disabledAccounts)}
                description="非 HEALTHY 母号数量，用于快速发现异常。"
              />
              <MetricTile
                title="Unused Codes"
                value={String(unusedCodes)}
                description="当前仍可兑换、未被消耗的卡密库存。"
              />
              <MetricTile
                title="Open Orders"
                value={String(activeOrders)}
                description="仍在排队、执行或等待用户接受邀请的订单。"
              />
            </section>

            <section className="surface-grid two-up">
              <article className="glass-panel">
                <div className="panel-stack">
                  <div className="section-copy">
                    <p className="label">Recent Orders</p>
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
                    <p className="label">Review Queue</p>
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
            role={data.user.role}
          />
        );
      case "orders":
        return (
          <OrdersPanel
            orders={data.orders}
            onReplace={replaceMember}
            role={data.user.role}
          />
        );
      case "tasks":
        return (
          <TasksPanel
            tasks={data.tasks}
            onManualComplete={manualComplete}
            onManualFail={manualFail}
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
      default:
        return null;
    }
  }

  return (
    <>
      <nav className="nav-strip">
        <div className="nav-brand">
          <div className="nav-mark">GO</div>
          <span>Operations Console</span>
        </div>

        <div className="nav-links">
          <button
            className="button secondary"
            onClick={() => startTransition(() => void loadDashboard())}
            type="button"
          >
            {isLoading ? "刷新中..." : "刷新数据"}
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
                <p className="label">Session</p>
                <h2 className="panel-title">{data.user.displayName}</h2>
                <p className="muted">{data.user.email}</p>
              </div>
              <StatusBadge value={data.user.role} tone="sky" />
            </div>
          </div>

          <div className="glass-panel">
            <div className="panel-stack">
              <p className="label">Navigation</p>
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
                  <p className="label">Workspace</p>
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
