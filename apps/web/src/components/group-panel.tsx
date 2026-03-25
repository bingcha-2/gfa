"use client";

import { Fragment, useEffect, useState } from "react";

import { apiRequest } from "../lib/client-api";
import { canCreateGroup } from "../lib/permissions";
import { AccountSummary, FamilyGroupSummary } from "../lib/types";
import { StatusBadge } from "./status-badge";

type MemberInfo = {
  id: string;
  email: string;
  displayName?: string | null;
  role: string;
  status: string;
  joinedAt?: string | null;
};

type GroupDetail = {
  members?: MemberInfo[];
  invites?: { id: string; email: string; status: string; createdAt: string }[];
};

type GroupPanelProps = {
  accounts: AccountSummary[];
  groups: FamilyGroupSummary[];
  role?: string;
  onCreate: (payload: {
    accountId: string;
    groupName: string;
    maxMembers: number;
  }) => Promise<boolean>;
  onSync: (groupId: string) => Promise<boolean>;
  onRemoveMember: (groupId: string, memberEmail: string) => Promise<boolean>;
};

function formatDate(dateStr?: string | null) {
  if (!dateStr) return "-";
  return new Date(dateStr).toLocaleDateString("zh-CN");
}

export function GroupPanel({
  accounts,
  groups,
  role,
  onCreate,
  onSync,
  onRemoveMember
}: GroupPanelProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
  const [syncingGroupId, setSyncingGroupId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const canManage = canCreateGroup(role);
  const [activeTab, setActiveTab] = useState<"inventory" | "create">("inventory");
  const [form, setForm] = useState({
    accountId: accounts[0]?.id ?? "",
    groupName: "",
    maxMembers: "5"
  });
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const [groupDetail, setGroupDetail] = useState<GroupDetail | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);

  useEffect(() => {
    if (!form.accountId && accounts[0]?.id) {
      setForm((current) => ({
        ...current,
        accountId: accounts[0]?.id ?? ""
      }));
    }
  }, [accounts, form.accountId]);

  function showToast(type: 'success' | 'error', msg: string) {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 3500);
  }

  async function handleSync(groupId: string) {
    setSyncingGroupId(groupId);
    try {
      const ok = await onSync(groupId);
      if (ok) {
        showToast('success', '同步任务已入队，等待 Worker 执行');
        // If this group's member list is expanded, refresh it after a short delay
        if (expandedGroupId === groupId) {
          setTimeout(async () => {
            try {
              const detail = await apiRequest<GroupDetail>(`family-groups/${groupId}`);
              setGroupDetail(detail);
            } catch { /* noop */ }
          }, 4000);
        }
      } else {
        showToast('error', '同步触发失败');
      }
    } catch {
      showToast('error', '同步请求异常');
    } finally {
      setSyncingGroupId(null);
    }
  }

  async function toggleMembers(groupId: string) {
    if (expandedGroupId === groupId) {
      setExpandedGroupId(null);
      setGroupDetail(null);
      return;
    }

    setExpandedGroupId(groupId);
    setIsLoadingDetail(true);
    setGroupDetail(null);

    try {
      const detail = await apiRequest<GroupDetail>(`family-groups/${groupId}`);
      setGroupDetail(detail);
    } catch {
      setGroupDetail({ members: [], invites: [] });
    } finally {
      setIsLoadingDetail(false);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canManage || !form.accountId) {
      return;
    }

    setIsSubmitting(true);

    try {
      const success = await onCreate({
        accountId: form.accountId,
        groupName: form.groupName,
        maxMembers: Number(form.maxMembers)
      });

      if (success) {
        setForm((current) => ({
          ...current,
          groupName: "",
          maxMembers: "5"
        }));
        setActiveTab("inventory");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section id="groups" className="glass-panel">
      {/* Toast */}
      {toast && (
        <div
          style={{
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            zIndex: 9999,
            background: toast.type === 'success' ? 'var(--green, #16a34a)' : 'var(--red, #dc2626)',
            color: '#fff',
            padding: '10px 20px',
            borderRadius: '8px',
            fontSize: '0.875rem',
            fontWeight: 500,
            boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
          }}
        >
          {toast.type === 'success' ? '✅' : '❌'} {toast.msg}
        </div>
      )}
      <div className="panel-stack">
        <div className="section-head">
          <div className="section-copy">
            <p className="label">Family Groups</p>
            <h2 className="panel-title">家庭组库存</h2>
            <p className="muted">保留可用空位、待邀请数、组状态和同步入口。</p>
          </div>
        </div>

        <div className="panel-tabs">
          <button
            className={`panel-tab${activeTab === "inventory" ? " active" : ""}`}
            onClick={() => setActiveTab("inventory")}
            type="button"
          >
            库存列表
          </button>
          <button
            className={`panel-tab${activeTab === "create" ? " active" : ""}`}
            onClick={() => setActiveTab("create")}
            type="button"
          >
            新增家庭组
          </button>
        </div>

        {activeTab === "create" ? (
          canManage ? (
            <form className="form-card field-grid workspace-form" onSubmit={submit}>
              <div className="field">
                <label htmlFor="group-account">归属母号</label>
                <select
                  disabled={!accounts.length}
                  id="group-account"
                  required
                  value={form.accountId}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      accountId: event.target.value
                    }))
                  }
                >
                  {accounts.length ? null : <option value="">请先创建母号</option>}
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="group-name">家庭组名称</label>
                <input
                  id="group-name"
                  required
                  value={form.groupName}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      groupName: event.target.value
                    }))
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="group-max">最大成员数</label>
                <input
                  id="group-max"
                  min="1"
                  required
                  type="number"
                  value={form.maxMembers}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      maxMembers: event.target.value
                    }))
                  }
                />
              </div>
              {!accounts.length ? (
                <div className="notice warn">创建家庭组前，必须先在左侧建立至少一个母号。</div>
              ) : null}
              <button
                className="button"
                disabled={isSubmitting || !accounts.length}
                type="submit"
              >
                {isSubmitting ? "创建中..." : "新增家庭组"}
              </button>
            </form>
          ) : (
            <div className="form-card panel-stack workspace-empty">
              <div>
                <p className="label">Read Only</p>
                <h3 className="panel-title">当前角色没有新增家庭组权限</h3>
              </div>
              <p className="muted">
                家庭组创建只对 ADMIN 开放。同步入口仍然保留，方便支持和运营查看库存后手动刷新状态。
              </p>
            </div>
          )
        ) : (
          <div className="table-wrap workspace-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>家庭组</th>
                  <th>库存</th>
                  <th>状态</th>
                  <th>母号</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {groups.length ? (
                  groups.map((group) => (
                    <Fragment key={group.id}>
                      <tr>
                        <td>
                          <div className="strong">{group.groupName}</div>
                          <div className="muted">
                            {group._count?.members ?? group.memberCount} members ·{" "}
                            {group._count?.invites ?? group.pendingInviteCount} invites
                          </div>
                        </td>
                        <td>
                          <div>{group.availableSlots} slots left</div>
                          <div className="muted">risk {group.riskScore}</div>
                        </td>
                        <td>
                          <StatusBadge value={group.status} />
                        </td>
                        <td>{group.account?.name ?? "-"}</td>
                        <td>
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <button
                              className="button secondary small"
                              onClick={() => void toggleMembers(group.id)}
                              type="button"
                            >
                              {expandedGroupId === group.id ? "收起" : "查看成员"}
                            </button>
                            <button
                              className="button secondary small"
                              disabled={syncingGroupId === group.id}
                              onClick={() => void handleSync(group.id)}
                              type="button"
                            >
                              {syncingGroupId === group.id ? '⏳ 同步中...' : '同步'}
                            </button>
                          </div>
                        </td>
                      </tr>
                      {expandedGroupId === group.id && (
                        <tr key={`${group.id}-detail`}>
                          <td colSpan={5} style={{ padding: 0 }}>
                            <div style={{ background: 'var(--surface-2, #fafaf9)', padding: '12px 16px', borderTop: '1px solid var(--border, #e5e5e5)' }}>
                              {isLoadingDetail ? (
                                <div className="muted" style={{ padding: '12px', textAlign: 'center' }}>加载中...</div>
                              ) : (
                                <>
                                  {/* Members */}
                                  <div style={{ marginBottom: '12px' }}>
                                    <div style={{ fontWeight: 600, fontSize: '0.875rem', marginBottom: '8px' }}>
                                      成员列表 ({groupDetail?.members?.length ?? 0})
                                    </div>
                                    {groupDetail?.members?.length ? (
                                      <table className="data-table" style={{ fontSize: '0.875rem' }}>
                                        <thead>
                                           <tr>
                                             <th>邮箱</th>
                                             <th>显示名</th>
                                             <th>角色</th>
                                             <th>状态</th>
                                             <th>加入时间</th>
                                             {canManage && <th style={{ minWidth: 80 }}>操作</th>}
                                           </tr>
                                         </thead>
                                         <tbody>
                                           {groupDetail.members.map((m) => (
                                             <tr key={m.id}>
                                               <td style={{ fontFamily: 'monospace' }}>{m.email}</td>
                                               <td>{m.displayName ?? "-"}</td>
                                               <td><StatusBadge value={m.role} tone={m.role === "OWNER" ? "sky" : undefined} /></td>
                                               <td><StatusBadge value={m.status} /></td>
                                               <td className="muted">{formatDate(m.joinedAt)}</td>
                                               {canManage && (
                                                 <td>
                                                   {m.role !== "OWNER" && (
                                                     <button
                                                       className="button"
                                                       style={{ fontSize: '0.8rem', padding: '3px 10px', background: 'var(--red, #dc2626)', color: '#fff', border: 'none', whiteSpace: 'nowrap', borderRadius: '4px', cursor: 'pointer' }}
                                                       disabled={removingMemberId === m.id}
                                                       onClick={async () => {
                                                         if (!confirm(`确定移除成员 ${m.email}？`)) return;
                                                         setRemovingMemberId(m.id);
                                                         try {
                                                           await onRemoveMember(group.id, m.email);
                                                           const detail = await apiRequest<GroupDetail>(`family-groups/${group.id}`);
                                                           setGroupDetail(detail);
                                                         } finally {
                                                           setRemovingMemberId(null);
                                                         }
                                                       }}
                                                       type="button"
                                                     >
                                                       {removingMemberId === m.id ? "移除中..." : "🗑 移除"}
                                                     </button>
                                                   )}
                                                 </td>
                                               )}
                                             </tr>
                                           ))}
                                         </tbody>
                                      </table>
                                    ) : (
                                      <div className="muted" style={{ fontSize: '0.875rem' }}>暂无成员记录</div>
                                    )}
                                  </div>

                                  {/* Invites */}
                                  {(groupDetail?.invites?.length ?? 0) > 0 && (
                                    <div>
                                      <div style={{ fontWeight: 600, fontSize: '0.875rem', marginBottom: '8px' }}>
                                        邀请记录 ({groupDetail?.invites?.length ?? 0})
                                      </div>
                                      <table className="data-table" style={{ fontSize: '0.875rem' }}>
                                        <thead>
                                          <tr>
                                            <th>邮箱</th>
                                            <th>状态</th>
                                            <th>创建时间</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {groupDetail!.invites!.map((inv) => (
                                            <tr key={inv.id}>
                                              <td style={{ fontFamily: 'monospace' }}>{inv.email}</td>
                                              <td><StatusBadge value={inv.status} /></td>
                                              <td className="muted">{formatDate(inv.createdAt)}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5}>
                      <div className="empty-state">还没有家庭组库存。</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
