"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

import { apiRequest, getErrorMessage } from "../lib/client-api";
import {
  AccountSummary,
  FamilyGroupSummary,
  SessionUser,
} from "../lib/types";
import { AccountPanel } from "./account-panel";
import { GroupPanel } from "./group-panel";

import { OrdersPanel } from "./orders-panel";
import { RedeemCodesPanel } from "./redeem-codes-panel";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "./status-badge";
import { TasksPanel } from "./tasks-panel";
import { MemberLookupPanel } from "./member-lookup-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { SchedulerPanel } from "./scheduler-panel";
import { DailyStatsPanel } from "./daily-stats-panel";
import { UserManagementPanel } from "./user-management-panel";
import { AgentServicePanel } from "./agent-service-panel";
import { FaqPanel } from "./faq-panel";

type ConsoleData = {
  user: SessionUser;
  stats?: any;
  accounts: AccountSummary[] | null;
  groups: FamilyGroupSummary[] | null;
};

type ConsoleSection = "daily-stats" | "accounts" | "groups" | "orders" | "tasks" | "codes" | "scheduler" | "lookup" | "agent-service" | "faq" | "settings" | "users";

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

export type TransferBatchResult = {
  batchId: string;
  phase: string;
  totalMembers: number;
  memberEmails: string[];
  removeTaskIds: string[];
};

export type TransferStatusResult = {
  id: string;
  phase: string;
  sourceGroupId: string;
  targetGroupId: string;
  sourceGroupName: string;
  targetGroupName: string;
  totalMembers: number;
  removes: { success: number; failed: number; pending: number };
  invites: { sent: number; failed: number; pending: number };
  memberDetails: { email: string; removeStatus: string; inviteStatus?: string }[];
  errorDetail: { email: string; error: string }[];
  createdAt: string;
  updatedAt: string;
};

export type MigrateResult = {
  removedFromGroupId: string;
  removedFromGroupName: string;
  inviteResult: {
    targetGroupId: string;
    targetGroupName: string;
    taskId: string;
  } | null;
  error?: string;
};

const orderTerminalStatuses = new Set(["INVITE_SENT", "COMPLETED", "FAILED"]);

type ConsoleAppProps = {
  initialData: { user: SessionUser; stats: any };
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
  const [data, setData] = useState<ConsoleData>({ ...initialData, accounts: null, groups: null });
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<ConsoleSection>("daily-stats");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isActioning, setIsActioning] = useState(false);
  const [toast, setToast] = useState<{ type: "success" | "error" | "info"; msg: string } | null>(null);
  const [pwForm, setPwForm] = useState({ current: "", newPw: "", confirm: "" });
  const [pwLoading, setPwLoading] = useState(false);

  function showToast(type: "success" | "error" | "info", msg: string) {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 3800);
  }

  async function loadModule(section: ConsoleSection | "_stats", force = false) {
    try {
      if (section === "accounts" && (force || !data.accounts)) {
        const accounts = await apiRequest<AccountSummary[]>("accounts");
        setData(prev => ({ ...prev, accounts }));
      } else if (section === "groups" && (force || !data.groups)) {
        const groups = await apiRequest<FamilyGroupSummary[]>("family-groups");
        setData(prev => ({ ...prev, groups }));
      } else if (section === "_stats" && force) {
        const stats = await apiRequest<any>("stats");
        setData(prev => ({ ...prev, stats }));
      }
      // tasks, orders, codes, expire — self-managed panels, no central loading needed
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

  useEffect(() => {
    setIsRefreshing(true);
    loadModule(activeSection).finally(() => setIsRefreshing(false));
  }, [activeSection]);

  async function loadDashboard() {
    // For self-managed panels (tasks, orders, codes), only refresh stats
    const refreshCurrent = ["accounts", "groups"].includes(activeSection)
      ? loadModule(activeSection, true)
      : Promise.resolve();
    const refreshStats = loadModule("_stats", true);
    await Promise.all([refreshCurrent, refreshStats]);
  }

  async function runAction(action: () => Promise<unknown>) {
    setIsActioning(true);
    const minDelay = new Promise<void>((res) => setTimeout(res, 200));
    try {
      const [result] = await Promise.allSettled([action(), minDelay]);
      if (result.status === "rejected") throw result.reason;
      // Only refresh stats (lightweight), self-managed panels refresh themselves
      await loadModule("_stats", true);
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

  async function bulkImport(payload: { lines: string[], subscriptionExpiresAt?: string }) {
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
        body: payload
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

  async function syncAccountGroups(id: string) {
    return runAction(() =>
      apiRequest(`accounts/${id}/sync`, { method: "POST" })
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

  async function crossInvite(emails: string[], validDays?: number): Promise<CrossInviteResult | null> {
    try {
      const result = await apiRequest<CrossInviteResult>("family-groups/cross-invite", {
        method: "POST",
        body: { emails, validDays }
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

  async function bulkInviteGroup(groupId: string, emails: string[], validDays?: number): Promise<BulkGroupInviteResult | null> {
    try {
      const result = await apiRequest<BulkGroupInviteResult>(`family-groups/${groupId}/bulk-invite`, {
        method: "POST",
        body: { emails, validDays }
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

  async function migrateMember(groupId: string, memberEmail: string): Promise<MigrateResult | null> {
    try {
      const result = await apiRequest<MigrateResult>(
        `family-groups/${groupId}/migrate-member`,
        { method: "POST", body: { memberEmail } }
      );
      await loadDashboard();
      return result;
    } catch (err) {
      const message = getErrorMessage(err);
      showToast("error", message);
      return null;
    }
  }

  async function createTransfer(sourceGroupId: string, targetGroupId: string, memberEmails?: string[]): Promise<TransferBatchResult | null> {
    try {
      const body: Record<string, unknown> = { sourceGroupId, targetGroupId };
      if (memberEmails && memberEmails.length > 0) body.memberEmails = memberEmails;
      const result = await apiRequest<TransferBatchResult>("family-groups/transfer", {
        method: "POST",
        body,
      });
      showToast("success", `迁移任务已创建，共 ${result.totalMembers} 个成员`);
      return result;
    } catch (err) {
      const message = getErrorMessage(err);
      showToast("error", message);
      return null;
    }
  }

  async function getTransferStatus(batchId: string): Promise<TransferStatusResult | null> {
    try {
      return await apiRequest<TransferStatusResult>(`family-groups/transfer/${batchId}`);
    } catch {
      return null;
    }
  }

  // Task and Order actions are now handled internally by their self-managing panels.
  // Only group/account actions that need central state refresh remain here.

  const availableSlots = data.stats?.availableSlots ?? 0;
  const activeOrders = data.stats?.activeOrders ?? 0;
  const manualReviewTasks = data.stats?.manualReviewTasks ?? 0;
  const disabledAccounts = data.stats?.disabledAccounts ?? 0;
  const pendingInvites = data.stats?.pendingInvites ?? 0;
  const unusedCodes = data.stats?.unusedCodes ?? 0;
  const recentOrders = data.stats?.recentOrders ?? [];
  const reviewQueue = data.stats?.reviewQueue ?? [];

  const isSuperAdmin = data.user.role === "SUPER_ADMIN";
  const isAdminOrOps = isSuperAdmin || data.user.role === "ADMIN" || data.user.role === "OPERATIONS";

  // Permission-based section visibility
  const userPerms: string[] | null = (data.user as any).permissions ?? null;
  function hasPermission(permKey: string): boolean {
    if (isSuperAdmin) return true;
    if (!userPerms || userPerms.length === 0) return true; // null/empty = all permissions
    return userPerms.includes(permKey);
  }

  // Permission-to-section mapping
  const SECTION_PERM_MAP: Record<string, string> = {
    "daily-stats": "daily_stats",
    accounts: "accounts",
    groups: "groups",
    orders: "orders",
    tasks: "tasks",
    codes: "codes",
    scheduler: "scheduler",
    lookup: "lookup",
    "agent-service": "agent_service",
    faq: "faq",
  };

  const allNavItems = [
    { id: "daily-stats" as const, label: "数据汇总", caption: "每日数据", metric: "今日" },
    { id: "accounts" as const, label: "母号池", caption: "账号管理", metric: `${data.stats?.totals?.accounts ?? 0} 个` },
    { id: "groups" as const, label: "家庭组", caption: "家庭组管理", metric: `${availableSlots} 空位` },
    { id: "orders" as const, label: "订单", caption: "订单管理", metric: `${data.stats?.totals?.orders ?? 0} 条` },
    { id: "tasks" as const, label: "任务", caption: "自动化任务", metric: `${manualReviewTasks} 待处理` },
    { id: "codes" as const, label: "卡密", caption: "卡密管理", metric: `${unusedCodes} 未使用` },
    ...(isAdminOrOps ? [{ id: "scheduler" as const, label: "自动维护", caption: "定时调度", metric: "" }] : []),
    { id: "lookup" as const, label: "成员管理", caption: "查询 & 操作", metric: "" },
    { id: "agent-service" as const, label: "代理服务", caption: "进组 & 验证", metric: "" },
    { id: "faq" as const, label: "FAQ管理", caption: "常见问题", metric: "" },
    ...(isSuperAdmin ? [{ id: "users" as const, label: "用户管理", caption: "管理员账号", metric: "" }] : []),
    { id: "settings" as const, label: "修改密码", caption: "安全设置", metric: "" },
  ];

  // Filter navigation by permissions
  const navigation = allNavItems.filter((item) => {
    const permKey = SECTION_PERM_MAP[item.id];
    if (!permKey) return true; // settings, users — always visible (users already guarded by isSuperAdmin)
    return hasPermission(permKey);
  });

  function renderWorkspace() {
    switch (activeSection) {
      case "accounts":
        return (
            <AccountPanel
            accounts={data.accounts || []}
            onCreate={createAccount}
            onBulkImport={bulkImport}
            onDelete={deleteAccount}
            onUpdate={updateAccount}
            onConfirmLogin={confirmLogin}
            onSyncAccount={syncAccountGroups}
            role={data.user.role}
          />
        );
      case "groups":
        return (
          <GroupPanel
            accounts={data.accounts || []}
            groups={data.groups || []}
            onCreate={createGroup}
            onSync={syncGroup}
            onRemoveMember={removeMember}
            onReplaceMember={replaceGroupMember}
            onCrossInvite={crossInvite}
            onCrossRemove={crossRemove}
            onBulkInviteGroup={bulkInviteGroup}
            onBulkRemoveGroup={bulkRemoveGroup}
            onToggleAutoAssign={toggleAutoAssign}
            onCreateTransfer={createTransfer}
            onGetTransferStatus={getTransferStatus}
            onUpdateAccount={updateAccount}
            onMigrateMember={migrateMember}
            role={data.user.role}
          />
        );
      case "orders":
        return (
          <OrdersPanel
            role={data.user.role}
            showToast={showToast}
          />
        );
      case "tasks":
        return (
          <TasksPanel
            role={data.user.role}
            showToast={showToast}
          />
        );
      case "codes":
        return (
          <RedeemCodesPanel role={data.user.role} />
        );
      case "daily-stats":
        return (
          <DailyStatsPanel role={data.user.role} />
        );

      case "scheduler":
        return (
          <SchedulerPanel showToast={showToast} />
        );
      case "lookup":
        return (
          <MemberLookupPanel
            onRemoveMember={removeMember}
            onRetryOrder={async (orderId: string) => {
              try {
                await apiRequest(`orders/${orderId}/retry`, { method: "POST" });
                return true;
              } catch { return false; }
            }}
            onReplaceMember={async (payload: { orderId: string; targetMemberEmail: string; newUserEmail: string }) => {
              try {
                await apiRequest(`orders/${payload.orderId}/replace-member`, {
                  method: "POST",
                  body: { targetMemberEmail: payload.targetMemberEmail, newUserEmail: payload.newUserEmail },
                });
                return true;
              } catch { return false; }
            }}
            showToast={showToast}
          />
        );
      case "agent-service":
        return (
          <AgentServicePanel showToast={showToast} />
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
                <Input
                  type="password"
                  value={pwForm.current}
                  onChange={(e) => setPwForm((p) => ({ ...p, current: e.target.value }))}
                  required
                  autoComplete="current-password"
                />
              </label>
              <label className="field-label">
                新密码（至少 6 位）
                <Input
                  type="password"
                  value={pwForm.newPw}
                  onChange={(e) => setPwForm((p) => ({ ...p, newPw: e.target.value }))}
                  required
                  minLength={6}
                  autoComplete="new-password"
                />
              </label>
              <label className="field-label">
                确认新密码
                <Input
                  type="password"
                  value={pwForm.confirm}
                  onChange={(e) => setPwForm((p) => ({ ...p, confirm: e.target.value }))}
                  required
                  minLength={6}
                  autoComplete="new-password"
                />
              </label>
              <Button type="submit" disabled={pwLoading}>
                {pwLoading ? "修改中..." : "确认修改"}
              </Button>
            </form>
          </div>
        );
      case "faq":
        return (
          <FaqPanel showToast={showToast} />
        );
      case "users":
        return (
          <UserManagementPanel showToast={showToast} />
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
          <Button
            variant="outline"
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
          >
            {isRefreshing ? (
              <><Spinner size={14} color="currentColor" /> 刷新中...</>
            ) : "刷新数据"}
          </Button>
          <Link className="pill-link" href="/redeem">
            公共提交页
          </Link>
          <Button variant="outline" onClick={handleLogout} type="button">
            退出登录
          </Button>
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
                    {item.metric && <span className="console-menu-metric">{item.metric}</span>}
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
