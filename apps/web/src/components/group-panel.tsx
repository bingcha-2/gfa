"use client";

import { Fragment, useEffect, useState } from "react";

import { apiRequest } from "../lib/client-api";
import { canCreateGroup } from "../lib/permissions";
import { AccountSummary, FamilyGroupSummary } from "../lib/types";
import { Spinner } from "./spinner";
import { StatusBadge } from "./status-badge";
import type {
  BulkGroupInviteResult,
  BulkGroupRemoveResult,
  CrossInviteResult,
  CrossRemoveResult
} from "./console-app";

type MemberInfo = {
  id: string;
  email: string;
  displayName?: string | null;
  role: string;
  status: string;
  isInGroup?: boolean;
  joinedAt?: string | null;
  googleMemberId?: string | null;
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
  onCrossInvite: (emails: string[]) => Promise<CrossInviteResult | null>;
  onCrossRemove: (memberEmails: string[]) => Promise<CrossRemoveResult | null>;
  onBulkInviteGroup: (groupId: string, emails: string[]) => Promise<BulkGroupInviteResult | null>;
  onBulkRemoveGroup: (groupId: string, memberEmails: string[]) => Promise<BulkGroupRemoveResult | null>;
  onToggleAutoAssign: (groupId: string) => Promise<boolean>;
};

function formatDate(dateStr?: string | null) {
  if (!dateStr) return "-";
  return new Date(dateStr).toLocaleDateString("zh-CN");
}

// Parse a newline-separated textarea into a trimmed, non-empty email array
function parseEmails(text: string): string[] {
  return text.split('\n').map(l => l.trim()).filter(Boolean);
}

export function GroupPanel({
  accounts,
  groups,
  role,
  onCreate,
  onSync,
  onRemoveMember,
  onCrossInvite,
  onCrossRemove,
  onBulkInviteGroup,
  onBulkRemoveGroup,
  onToggleAutoAssign
}: GroupPanelProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
  const [syncingGroupId, setSyncingGroupId] = useState<string | null>(null);
  const [togglingGroupId, setTogglingGroupId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const canManage = canCreateGroup(role);
  const [activeTab, setActiveTab] = useState<"inventory" | "create" | "batch">("inventory");

  // --- Batch tab state ---
  const [batchSubTab, setBatchSubTab] = useState<"cross-invite" | "cross-remove" | "group-invite" | "group-remove">("cross-invite");
  const [batchText, setBatchText] = useState("");
  const [batchGroupId, setBatchGroupId] = useState("");
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchResult, setBatchResult] = useState<CrossInviteResult | CrossRemoveResult | BulkGroupInviteResult | BulkGroupRemoveResult | null>(null);

  // Reset result when switching tabs or subtabs
  function switchBatchSubTab(tab: typeof batchSubTab) {
    setBatchSubTab(tab);
    setBatchResult(null);
    setBatchText("");
    // Reset group selector when switching to cross-group ops (no group needed)
    if (tab === "cross-invite" || tab === "cross-remove") {
      setBatchGroupId("");
    }
  }
  const [form, setForm] = useState({
    accountId: accounts[0]?.id ?? "",
    groupName: "",
    maxMembers: "5"
  });
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const [groupDetail, setGroupDetail] = useState<GroupDetail | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);

  // --- Inventory search / filter state ---
  const [searchEmail, setSearchEmail] = useState("");
  const [filterStatus, setFilterStatus] = useState("ALL");
  const PAGE_SIZE = 20;
  const [showAll, setShowAll] = useState(false);

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

  async function handleToggleAutoAssign(groupId: string) {
    setTogglingGroupId(groupId);
    try {
      const ok = await onToggleAutoAssign(groupId);
      if (ok) {
        showToast('success', '自动分配开关已切换');
      } else {
        showToast('error', '切换失败');
      }
    } catch {
      showToast('error', '切换请求异常');
    } finally {
      setTogglingGroupId(null);
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
        <div className={`gfa-toast ${toast.type}`} style={{ bottom: '72px' }}>
          {toast.type === 'success' ? '✅' : '❌'} {toast.msg}
        </div>
      )}
      <div className="panel-stack">
        <div className="section-head">
          <div className="section-copy">
            <p className="label">家庭组列表</p>
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
          <button
            className={`panel-tab${activeTab === "batch" ? " active" : ""}`}
            onClick={() => { setActiveTab("batch"); setBatchResult(null); }}
            type="button"
          >
            批量操作
          </button>
        </div>

        {activeTab === "batch" ? (
          <div className="panel-stack">
            {/* Batch sub-tab bar */}
            <div className="panel-tabs" style={{ gap: '4px' }}>
              {([
                { id: "cross-invite" as const, label: "跨组邀请" },
                { id: "cross-remove" as const, label: "跨组踢人" },
                { id: "group-invite" as const, label: "指定组邀请" },
                { id: "group-remove" as const, label: "指定组踢人" }
              ]).map(t => (
                <button
                  key={t.id}
                  className={`panel-tab${batchSubTab === t.id ? " active" : ""}`}
                  onClick={() => switchBatchSubTab(t.id)}
                  type="button"
                  style={{ fontSize: '0.875rem' }}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="form-card field-grid workspace-form">
              {/* Description */}
              <div className="notice" style={{ background: 'var(--surface-2, #f5f5f4)', border: 'none', borderRadius: '8px', padding: '10px 14px', fontSize: '0.875rem', lineHeight: 1.7 }}>
                {batchSubTab === "cross-invite" && <><strong>跨组批量邀请</strong>：自动分配到可用槽位，先填满第一组再溢出到下一组。</>}
                {batchSubTab === "cross-remove" && <><strong>跨组批量踢人</strong>：自动查找每个邮箱所在组并入队移除任务。</>}
                {batchSubTab === "group-invite" && <><strong>指定组批量邀请</strong>：选择目标家庭组，一次最多 5 个。超出 availableSlots 时拒绝。</>}
                {batchSubTab === "group-remove" && <><strong>指定组批量踢人</strong>：选择目标家庭组，批量移除指定邮箱成员。</>}
              </div>

              {/* Group selector for single-group ops */}
              {(batchSubTab === "group-invite" || batchSubTab === "group-remove") && (
                <div className="field">
                  <label htmlFor="batch-group-select">目标家庭组</label>
                  <select
                    id="batch-group-select"
                    value={batchGroupId}
                    onChange={e => { setBatchGroupId(e.target.value); setBatchResult(null); }}
                  >
                    <option value="">-- 请选择家庭组 --</option>
                    {groups.map(g => (
                      <option key={g.id} value={g.id}>
                        {g.groupName} · {g.availableSlots} slots · {g.account?.name ?? '-'}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Email textarea */}
              <div className="field">
                <label htmlFor="batch-emails">
                  邮箱列表（每行一个，共 {parseEmails(batchText).length} 个）
                </label>
                <textarea
                  id="batch-emails"
                  rows={6}
                  placeholder={`user1@gmail.com
user2@gmail.com`}
                  value={batchText}
                  onChange={e => { setBatchText(e.target.value); setBatchResult(null); }}
                  style={{ fontFamily: 'monospace', fontSize: '0.875rem', resize: 'vertical' }}
                />
              </div>

              {/* Action buttons */}
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  className="button"
                  type="button"
                  disabled={batchLoading || !parseEmails(batchText).length || ((batchSubTab === "group-invite" || batchSubTab === "group-remove") && !batchGroupId)}
                  onClick={async () => {
                    const emails = parseEmails(batchText);
                    setBatchLoading(true);
                    setBatchResult(null);
                    try {
                      let result: CrossInviteResult | CrossRemoveResult | BulkGroupInviteResult | BulkGroupRemoveResult | null = null;
                      if (batchSubTab === "cross-invite") result = await onCrossInvite(emails);
                      else if (batchSubTab === "cross-remove") result = await onCrossRemove(emails);
                      else if (batchSubTab === "group-invite") result = await onBulkInviteGroup(batchGroupId, emails);
                      else if (batchSubTab === "group-remove") result = await onBulkRemoveGroup(batchGroupId, emails);
                      if (result) { setBatchResult(result); setBatchText(""); }
                    } finally {
                      setBatchLoading(false);
                    }
                  }}
                >
                  {batchLoading ? <><Spinner size={14} color="currentColor" /> 提交中...</> : '提交任务'}
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={batchLoading}
                  onClick={() => { setBatchText(""); setBatchResult(null); }}
                >
                  清空
                </button>
              </div>

              {/* Result display */}
              {batchResult && (
                <div style={{ marginTop: '4px' }}>
                  {batchSubTab === "cross-invite" && (() => {
                    const r = batchResult as CrossInviteResult;
                    const allocated = r.allocated ?? [];
                    const unplaceable = r.unplaceable ?? [];
                    const alreadyActive = r.alreadyActive ?? [];
                    return (
                      <div className="panel-stack" style={{ gap: '8px' }}>
                        {allocated.length === 0 && unplaceable.length === 0 && alreadyActive.length === 0 && (
                          <div className="muted" style={{ fontSize: '0.875rem' }}>无操作结果</div>
                        )}
                        {allocated.map((alloc, i) => {
                          const groupName = groups.find(g => g.id === alloc.groupId)?.groupName ?? alloc.groupId.slice(0, 8) + '…';
                          return (
                            <div key={i} style={{ background: 'var(--surface-2, #f5f5f4)', borderRadius: '8px', padding: '10px 14px', fontSize: '0.875rem' }}>
                              <div style={{ fontWeight: 600, marginBottom: '4px' }}>✅ 已分配到 <strong>{groupName}</strong>（{alloc.queued.length} 个）</div>
                              <div className="muted" style={{ fontFamily: 'monospace', fontSize: '0.8rem', wordBreak: 'break-all' }}>{alloc.queued.join(', ')}</div>
                            </div>
                          );
                        })}
                        {unplaceable.length > 0 && (
                          <div style={{ background: '#fef2f2', borderRadius: '8px', padding: '10px 14px', fontSize: '0.875rem' }}>
                            <div style={{ fontWeight: 600, color: '#dc2626', marginBottom: '4px' }}>⚠️ 无法分配（槽位不足，{unplaceable.length} 个）</div>
                            <div style={{ fontFamily: 'monospace', fontSize: '0.8rem', wordBreak: 'break-all' }}>{unplaceable.join(', ')}</div>
                          </div>
                        )}
                        {alreadyActive.length > 0 && (
                          <div style={{ background: '#eff6ff', borderRadius: '8px', padding: '10px 14px', fontSize: '0.875rem' }}>
                            <div style={{ fontWeight: 600, color: '#2563eb', marginBottom: '4px' }}>ℹ️ 已是活跃成员（跳过，{alreadyActive.length} 个）</div>
                            <div style={{ fontFamily: 'monospace', fontSize: '0.8rem', wordBreak: 'break-all', color: '#1d4ed8' }}>{alreadyActive.join(', ')}</div>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {(batchSubTab === "cross-remove" || batchSubTab === "group-remove") && (
                    <BatchResultTable result={batchResult as CrossRemoveResult | BulkGroupRemoveResult} />
                  )}

                  {batchSubTab === "group-invite" && (
                    <BatchInviteResultTable result={batchResult as BulkGroupInviteResult} />
                  )}
                </div>
              )}
            </div>
          </div>
        ) : activeTab === "create" ? (
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
                <p className="label">只读模式</p>
                <h3 className="panel-title">当前角色没有新增家庭组权限</h3>
              </div>
              <p className="muted">
                家庭组创建只对 ADMIN 开放。同步入口仍然保留，方便支持和运营查看库存后手动刷新状态。
              </p>
            </div>
          )
        ) : (
        <div className="table-wrap workspace-table-wrap">
          {/* ----- Search bar ----- */}
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '10px' }}>
            <div style={{ position: 'relative', flex: '1 1 200px', minWidth: 160 }}>
              <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--foreground-muted, #a3a3a3)', fontSize: '0.9rem', pointerEvents: 'none' }}>🔍</span>
              <input
                id="group-search-email"
                type="text"
                placeholder="搜索母号邮箱…"
                value={searchEmail}
                onChange={(e) => { setSearchEmail(e.target.value); setShowAll(false); }}
                style={{ paddingLeft: 32, width: '100%', boxSizing: 'border-box' }}
              />
            </div>
            <select
              id="group-filter-status"
              value={filterStatus}
              onChange={(e) => { setFilterStatus(e.target.value); setShowAll(false); }}
              style={{ flex: '0 0 auto', minWidth: 120 }}
            >
              <option value="ALL">全部状态</option>
              <option value="ACTIVE">🟢 ACTIVE</option>
              <option value="MANUAL_ONLY">⏸ MANUAL_ONLY</option>
              <option value="DISABLED">🚫 DISABLED</option>
            </select>
            {(searchEmail || filterStatus !== 'ALL') && (
              <button
                className="button secondary small"
                type="button"
                onClick={() => { setSearchEmail(''); setFilterStatus('ALL'); setShowAll(false); }}
                style={{ whiteSpace: 'nowrap' }}
              >
                清除筛选
              </button>
            )}
          </div>
          {/* ----- Filtered result ----- */}
          {(() => {
            const q = searchEmail.trim().toLowerCase();
            const filtered = groups.filter((g) => {
              const matchEmail = !q || (g.account?.loginEmail ?? '').toLowerCase().includes(q);
              const matchStatus = filterStatus === 'ALL' || g.status === filterStatus;
              return matchEmail && matchStatus;
            });
            const displayed = showAll ? filtered : filtered.slice(0, PAGE_SIZE);
            const hasMore = !showAll && filtered.length > PAGE_SIZE;

            return (
              <>
                {/* Stats bar */}
                <div style={{ fontSize: '0.875rem', color: 'var(--foreground-muted, #737373)', marginBottom: '6px' }}>
                  共 {groups.length} 组 · 显示 {displayed.length}{filtered.length < groups.length ? `/${filtered.length} 筛选结果` : ''}
                </div>

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
                    {displayed.length ? (
                      displayed.map((group) => (
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
                            <td>
                              <div>{group.account?.name ?? "-"}</div>
                              {group.account?.loginEmail && (
                                <div className="muted" style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                                  {group.account.loginEmail}
                                </div>
                              )}
                              {group.account?.subscriptionStatus && (
                                <div style={{ marginTop: '2px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
                                  <span style={{
                                    padding: '1px 6px',
                                    borderRadius: '4px',
                                    fontWeight: 600,
                                    fontSize: '0.75rem',
                                    background: group.account.subscriptionStatus === 'ACTIVE' ? 'rgba(16,185,129,0.12)' : group.account.subscriptionStatus === 'EXPIRED' ? 'rgba(239,68,68,0.12)' : 'rgba(245,158,11,0.12)',
                                    color: group.account.subscriptionStatus === 'ACTIVE' ? '#059669' : group.account.subscriptionStatus === 'EXPIRED' ? '#dc2626' : '#d97706',
                                  }}>
                                    {group.account.subscriptionStatus === 'ACTIVE' ? '✅ 订阅中' : group.account.subscriptionStatus === 'EXPIRED' ? '❌ 已过期' : '⚠️ 已暂停'}
                                  </span>
                                  {group.account.subscriptionPlan && (
                                    <span style={{ fontSize: '0.75rem', fontWeight: 500 }}>
                                      {group.account.subscriptionPlan}
                                    </span>
                                  )}
                                  {group.account.subscriptionExpiresAt && (
                                    <span className="muted" style={{ fontSize: '0.75rem' }}>
                                      · {formatDate(group.account.subscriptionExpiresAt)}
                                    </span>
                                  )}
                                </div>
                              )}
                            </td>
                            <td>
                              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
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
                                  style={{ gap: 6 }}
                                >
                                  {syncingGroupId === group.id
                                    ? <><Spinner size={12} color="currentColor" /> 同步中...</>
                                    : '同步'}
                                </button>
                                <button
                                  className="button secondary small"
                                  disabled={togglingGroupId === group.id || group.status === 'DISABLED'}
                                  onClick={() => void handleToggleAutoAssign(group.id)}
                                  type="button"
                                  title={group.status === 'DISABLED' ? '组已停用，无法切换' : (group.status === 'ACTIVE' ? '点击关闭自动分配' : '点击开启自动分配')}
                                  style={{
                                    color: group.status === 'ACTIVE' ? '#059669' : group.status === 'MANUAL_ONLY' ? '#92400e' : undefined,
                                    borderColor: group.status === 'ACTIVE' ? '#059669' : group.status === 'MANUAL_ONLY' ? '#d97706' : undefined,
                                    opacity: group.status === 'DISABLED' ? 0.5 : 1
                                  }}
                                >
                                  {togglingGroupId === group.id
                                    ? <><Spinner size={12} color="currentColor" /> 切换中...</>
                                    : group.status === 'ACTIVE' ? '🟢 自动 ON'
                                    : group.status === 'MANUAL_ONLY' ? '⏸ 自动 OFF'
                                    : '🚫 已停用'}
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
                                                {groupDetail.members.map((m) => {
                                                  const ownerEmail = group.account?.loginEmail?.toLowerCase() ?? "";
                                                  const isOwner = m.role === "OWNER" || (ownerEmail !== "" && m.email.toLowerCase() === ownerEmail);
                                                  return (
                                                   <tr key={m.id} style={isOwner ? { background: 'rgba(56,189,248,0.06)' } : undefined}>
                                                     <td style={{ fontFamily: 'monospace' }}>
                                                       {m.email}
                                                       {isOwner && (
                                                         <span style={{
                                                           marginLeft: '6px',
                                                           fontSize: '0.75rem',
                                                           padding: '1px 6px',
                                                           borderRadius: '4px',
                                                           background: 'rgba(56,189,248,0.15)',
                                                           color: '#0284c7',
                                                           fontWeight: 600,
                                                           fontFamily: 'inherit'
                                                         }}>
                                                           👑 母号
                                                         </span>
                                                       )}
                                                       <span
                                                         title={m.googleMemberId ? `GaiaID: ${m.googleMemberId}` : '未同步 GaiaID'}
                                                         style={{
                                                           marginLeft: '4px',
                                                           fontSize: '0.7rem',
                                                           cursor: 'help',
                                                           opacity: m.googleMemberId ? 0.6 : 0.4,
                                                         }}
                                                       >
                                                         {m.googleMemberId ? '🔗' : '⚠️'}
                                                       </span>
                                                     </td>
                                                     <td>{m.displayName ?? "-"}</td>
                                                     <td><StatusBadge value={isOwner ? "OWNER" : m.role} tone={isOwner ? "sky" : undefined} /></td>
                                                     <td>
                                                       {m.isInGroup
                                                         ? <StatusBadge value="已在组" tone="emerald" />
                                                         : m.status === "PENDING"
                                                           ? <StatusBadge value="待接受" tone="amber" />
                                                           : <StatusBadge value={m.status} />}
                                                     </td>
                                                     <td className="muted">{formatDate(m.joinedAt)}</td>
                                                     {canManage && (
                                                       <td>
                                                         {!isOwner && (
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
                                                  );
                                                })}
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
                          <div className="empty-state">
                            {searchEmail || filterStatus !== 'ALL'
                              ? `没有符合条件的家庭组。`
                              : '还没有家庭组库存。'}
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>

                {/* Pagination footer */}
                {hasMore && (
                  <div style={{ textAlign: 'center', padding: '12px 0 4px' }}>
                    <button
                      className="button secondary small"
                      type="button"
                      onClick={() => setShowAll(true)}
                    >
                      显示全部 {filtered.length} 条
                    </button>
                  </div>
                )}
              </>
            );
          })()}
        </div>
        )}
      </div>
    </section>
  );
}

// --- Helper sub-components for batch result display ---

function ResultRow({ label, items, color }: { label: string; items: string[]; color?: string }) {
  if (!items.length) return null;
  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '0.875rem', padding: '6px 0', borderBottom: '1px solid var(--border, #e5e5e5)' }}>
      <span style={{ minWidth: 120, fontWeight: 600, color: color ?? 'inherit', flexShrink: 0 }}>{label} ({items.length})</span>
      <span style={{ fontFamily: 'monospace', fontSize: '0.8rem', color: 'var(--foreground-muted, #737373)', wordBreak: 'break-all' }}>{items.join(', ')}</span>
    </div>
  );
}

function BatchResultTable({ result }: { result: CrossRemoveResult | BulkGroupRemoveResult }) {
  return (
    <div style={{ background: 'var(--surface-2, #f5f5f4)', borderRadius: '8px', padding: '10px 14px' }}>
      <ResultRow label="✅ 已入队" items={result.queued ?? []} color="#059669" />
      <ResultRow label="⚠️ 未找到" items={result.notFound ?? []} color="#d97706" />
      <ResultRow label="ℹ️ 已移除" items={result.alreadyRemoved ?? []} />
      <ResultRow label="❌ 入队失败" items={result.failed ?? []} color="#dc2626" />
    </div>
  );
}

function BatchInviteResultTable({ result }: { result: BulkGroupInviteResult }) {
  return (
    <div style={{ background: 'var(--surface-2, #f5f5f4)', borderRadius: '8px', padding: '10px 14px' }}>
      <ResultRow label="✅ 已入队" items={result.queued ?? []} color="#059669" />
      <ResultRow label="❌ 被拒绝" items={result.rejected ?? []} color="#dc2626" />
      {result.reason && (
        <div style={{ fontSize: '0.875rem', color: '#dc2626', marginTop: '6px' }}>原因：{result.reason}</div>
      )}
    </div>
  );
}
