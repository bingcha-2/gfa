"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import { apiRequest } from "../lib/client-api";
import { canCreateGroup } from "../lib/permissions";
import { AccountSummary, FamilyGroupSummary } from "../lib/types";
import { Spinner } from "./spinner";
import { StatusBadge } from "./status-badge";
import { SearchableSelect } from "./searchable-select";
import type {
  BulkGroupInviteResult,
  BulkGroupRemoveResult,
  CrossInviteResult,
  CrossRemoveResult,
  TransferBatchResult,
  TransferStatusResult
} from "./console-app";

type MemberInfo = {
  id: string;
  email: string;
  displayName?: string | null;
  role: string;
  status: string;
  isInGroup?: boolean;
  joinedAt?: string | null;
  expiresAt?: string | null;
  googleMemberId?: string | null;
};

type ExpiredMemberInfo = {
  id: string;
  email: string;
  displayName: string | null;
  expiresAt: string | null;
  joinedAt: string | null;
  status: string;
  familyGroupId: string;
  groupName: string;
  accountEmail: string | null;
  isExpired: boolean;
  daysRemaining: number | null;
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
  onSync: (groupId: string) => Promise<{ taskId: string } | null>;
  onRemoveMember: (groupId: string, memberEmail: string) => Promise<{ taskId: string } | null>;
  onReplaceMember: (groupId: string, targetEmail: string, newEmail: string) => Promise<{ taskId: string } | null>;
  onCrossInvite: (emails: string[], validDays?: number) => Promise<CrossInviteResult | null>;
  onCrossRemove: (memberEmails: string[]) => Promise<CrossRemoveResult | null>;
  onBulkInviteGroup: (groupId: string, emails: string[], validDays?: number) => Promise<BulkGroupInviteResult | null>;
  onBulkRemoveGroup: (groupId: string, memberEmails: string[]) => Promise<BulkGroupRemoveResult | null>;
  onToggleAutoAssign: (groupId: string) => Promise<boolean>;
  onCreateTransfer: (sourceGroupId: string, targetGroupId: string, memberEmails?: string[]) => Promise<TransferBatchResult | null>;
  onGetTransferStatus: (batchId: string) => Promise<TransferStatusResult | null>;
  onUpdateAccount?: (accountId: string, payload: Record<string, string | undefined>) => Promise<boolean>;
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
  onReplaceMember,
  onCrossInvite,
  onCrossRemove,
  onBulkInviteGroup,
  onBulkRemoveGroup,
  onToggleAutoAssign,
  onCreateTransfer,
  onGetTransferStatus,
  onUpdateAccount
}: GroupPanelProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editingDateGroupId, setEditingDateGroupId] = useState<string | null>(null);
  const [editingDateValue, setEditingDateValue] = useState("");
  const [isUpdatingDate, setIsUpdatingDate] = useState(false);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
  const [replacingMemberId, setReplacingMemberId] = useState<string | null>(null);
  const [replaceEmail, setReplaceEmail] = useState("");
  const [syncingGroupId, setSyncingGroupId] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<{ groupId: string; taskId: string; status: string; message?: string } | null>(null);
  const syncPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const expandedGroupIdRef = useRef<string | null>(null);
  // Per-member task status tracking: keyed by memberId
  const [memberTaskMap, setMemberTaskMap] = useState<Record<string, { taskId: string; type: string; status: string; message: string }>>({});
  const memberPollRefs = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const [togglingGroupId, setTogglingGroupId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const canManage = canCreateGroup(role);
  const [activeTab, setActiveTab] = useState<"inventory" | "create" | "batch" | "expiry">("inventory");

  // --- Expiry tab state ---
  const [expiryFilter, setExpiryFilter] = useState<"expired" | "expiring_soon" | "all">("all");
  const [expirySearch, setExpirySearch] = useState("");
  const [expiryMembers, setExpiryMembers] = useState<ExpiredMemberInfo[]>([]);
  const [expiryTotal, setExpiryTotal] = useState(0);
  const [expiryPage, setExpiryPage] = useState(1);
  const [expiryLoading, setExpiryLoading] = useState(false);
  const [expirySelected, setExpirySelected] = useState<Set<string>>(new Set());
  const [expiryRemoving, setExpiryRemoving] = useState(false);
  const [expiryRemoveResult, setExpiryRemoveResult] = useState<CrossRemoveResult | null>(null);
  const EXPIRY_PAGE_SIZE = 30;
  // Editing member dates
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [editJoinedAt, setEditJoinedAt] = useState("");
  const [editExpiresAt, setEditExpiresAt] = useState("");
  const [savingMemberDates, setSavingMemberDates] = useState(false);

  // Batch invite validDays state
  const [batchValidDays, setBatchValidDays] = useState(30);

  // --- Batch tab state ---
  const [batchSubTab, setBatchSubTab] = useState<"cross-invite" | "cross-remove" | "group-invite" | "group-remove" | "transfer">("cross-invite");

  // Fetch expired members; accepts optional overrides for filter values
  // that haven't been committed to state yet (for onChange auto-refresh).
  async function fetchExpiryMembers(page = 1, overrides?: { filter?: string }) {
    setExpiryLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("status", overrides?.filter ?? expiryFilter);
      params.set("page", String(page));
      params.set("pageSize", String(EXPIRY_PAGE_SIZE));
      if (expirySearch.trim()) params.set("email", expirySearch.trim());
      const data = await apiRequest<{ members: ExpiredMemberInfo[]; total: number }>(`family-groups/expired-members?${params}`);
      setExpiryMembers(data.members);
      setExpiryTotal(data.total);
      setExpiryPage(page);
      setExpirySelected(new Set());
    } catch {
      setExpiryMembers([]);
      setExpiryTotal(0);
    } finally {
      setExpiryLoading(false);
    }
  }

  async function handleBulkRemoveExpired() {
    const emails = expiryMembers.filter(m => expirySelected.has(m.id)).map(m => m.email);
    if (!emails.length || !confirm(`确定批量踢出 ${emails.length} 个到期成员？`)) return;
    setExpiryRemoving(true);
    setExpiryRemoveResult(null);
    try {
      const result = await onCrossRemove(emails);
      if (result) {
        setExpiryRemoveResult(result);
        showToast('success', `已入队 ${result.queued?.length ?? 0} 个移除任务`);
        fetchExpiryMembers(expiryPage);
      }
    } finally {
      setExpiryRemoving(false);
    }
  }

  async function handleSaveMemberDates(memberId: string, groupId: string) {
    setSavingMemberDates(true);
    try {
      await apiRequest(`family-groups/${groupId}/members/${memberId}/dates`, {
        method: 'PATCH',
        body: {
          joinedAt: editJoinedAt || null,
          expiresAt: editExpiresAt || null,
        },
      });
      showToast('success', '日期已更新');
      setEditingMemberId(null);
      if (expandedGroupId) refreshGroupDetail(expandedGroupId);
    } catch {
      showToast('error', '日期更新失败');
    } finally {
      setSavingMemberDates(false);
    }
  }
  const [batchText, setBatchText] = useState("");
  const [batchGroupId, setBatchGroupId] = useState("");
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchResult, setBatchResult] = useState<CrossInviteResult | CrossRemoveResult | BulkGroupInviteResult | BulkGroupRemoveResult | null>(null);

  // Transfer state
  const [transferSourceId, setTransferSourceId] = useState("");
  const [transferTargetId, setTransferTargetId] = useState("");
  const [transferEmails, setTransferEmails] = useState("");
  const [transferLoading, setTransferLoading] = useState(false);
  const [transferStatus, setTransferStatus] = useState<TransferStatusResult | null>(null);
  const transferPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function switchBatchSubTab(tab: typeof batchSubTab) {
    setBatchSubTab(tab);
    setBatchResult(null);
    setBatchText("");
    if (tab === "cross-invite" || tab === "cross-remove") {
      setBatchGroupId("");
    }
    // Stop transfer polling when leaving the transfer sub-tab
    if (tab !== "transfer" && transferPollRef.current) {
      clearInterval(transferPollRef.current);
      transferPollRef.current = null;
    }
  }

  // Clean up transfer polling on unmount
  useEffect(() => {
    return () => {
      if (transferPollRef.current) clearInterval(transferPollRef.current);
    };
  }, []);

  function startTransferPolling(batchId: string) {
    if (transferPollRef.current) clearInterval(transferPollRef.current);
    transferPollRef.current = setInterval(async () => {
      const status = await onGetTransferStatus(batchId);
      if (status) {
        setTransferStatus(status);
        if (["COMPLETED", "PARTIALLY_FAILED", "FAILED"].includes(status.phase)) {
          if (transferPollRef.current) clearInterval(transferPollRef.current);
          transferPollRef.current = null;
        }
      }
    }, 5000);
  }

  async function submitTransfer() {
    setTransferLoading(true);
    setTransferStatus(null);
    try {
      const emails = transferEmails.trim() ? parseEmails(transferEmails) : undefined;
      const result = await onCreateTransfer(transferSourceId, transferTargetId, emails);
      if (result) {
        const status = await onGetTransferStatus(result.batchId);
        if (status) setTransferStatus(status);
        startTransferPolling(result.batchId);
      }
    } finally {
      setTransferLoading(false);
    }
  }
  const [form, setForm] = useState({
    accountId: accounts[0]?.id ?? "",
    groupName: "",
    maxMembers: "5"
  });
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  // Keep ref in sync for use inside setInterval closures
  useEffect(() => { expandedGroupIdRef.current = expandedGroupId; }, [expandedGroupId]);
  const [groupDetail, setGroupDetail] = useState<GroupDetail | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);

  // --- Inventory search / filter state ---
  const [searchMode, setSearchMode] = useState<"parent" | "member">("parent");
  const [searchEmail, setSearchEmail] = useState("");
  const [filterStatus, setFilterStatus] = useState("ALL");
  const PAGE_SIZE = 20;
  const [currentGroupPage, setCurrentGroupPage] = useState(1);

  // --- Member (子号) search state ---
  const [memberGroups, setMemberGroups] = useState<FamilyGroupSummary[]>([]);
  const [memberSearchLoading, setMemberSearchLoading] = useState(false);
  const [memberSearchDone, setMemberSearchDone] = useState(false);

  async function fetchGroupsByMember() {
    const q = searchEmail.trim();
    if (!q || q.length < 2) { setMemberGroups([]); setMemberSearchDone(false); return; }
    setMemberSearchLoading(true);
    try {
      const data = await apiRequest<FamilyGroupSummary[]>(`family-groups?memberEmail=${encodeURIComponent(q)}`);
      setMemberGroups(data);
      setMemberSearchDone(true);
      setCurrentGroupPage(1);
    } catch {
      setMemberGroups([]);
      setMemberSearchDone(true);
    } finally {
      setMemberSearchLoading(false);
    }
  }

  useEffect(() => {
    if (!form.accountId && accounts[0]?.id) {
      setForm((current) => ({
        ...current,
        accountId: accounts[0]?.id ?? ""
      }));
    }
  }, [accounts, form.accountId]);

  // When parent refreshes inventory (groups array changes),
  // also re-fetch the expanded group's member detail
  useEffect(() => {
    if (!expandedGroupId) return;
    let cancelled = false;
    apiRequest<GroupDetail>(`family-groups/${expandedGroupId}`)
      .then((detail) => { if (!cancelled) setGroupDetail(detail); })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups]);

  function showToast(type: 'success' | 'error', msg: string) {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 3500);
  }

  // Cleanup sync polling on unmount
  useEffect(() => {
    return () => {
      if (syncPollRef.current) clearInterval(syncPollRef.current);
      Object.values(memberPollRefs.current).forEach(clearInterval);
    };
  }, []);

  const refreshGroupDetail = useCallback(async (gid: string) => {
    try {
      const detail = await apiRequest<GroupDetail>(`family-groups/${gid}`);
      setGroupDetail(detail);
    } catch { /* noop */ }
  }, []);

  /** Start polling a member task after remove/replace is queued */
  function pollMemberTask(memberId: string, taskId: string, type: 'remove' | 'replace', groupId: string) {
    // Clear any existing poll for this member
    if (memberPollRefs.current[memberId]) { clearInterval(memberPollRefs.current[memberId]); }

    setMemberTaskMap(prev => ({ ...prev, [memberId]: { taskId, type, status: 'PENDING', message: type === 'remove' ? '移除排队中' : '替换排队中' } }));

    let pollCount = 0;
    const MAX_POLLS = 60;
    const statusLabels: Record<string, string> = {
      PENDING: type === 'remove' ? '移除排队中' : '替换排队中',
      QUEUED: type === 'remove' ? '移除排队中' : '替换排队中',
      RUNNING: type === 'remove' ? '移除执行中' : '替换执行中',
      SUCCESS: type === 'remove' ? '已移除' : '替换完成',
      REPLACED_AND_INVITE_SENT: '已替换并发送邀请',
      FAILED: type === 'remove' ? '移除失败' : '替换失败',
      MANUAL_REVIEW: '需人工处理',
      CANCELLED: '已取消',
    };
    const terminalStatuses = new Set(['SUCCESS', 'FAILED', 'MANUAL_REVIEW', 'CANCELLED', 'REPLACED_AND_INVITE_SENT']);

    memberPollRefs.current[memberId] = setInterval(async () => {
      pollCount++;
      if (pollCount > MAX_POLLS) {
        clearInterval(memberPollRefs.current[memberId]);
        delete memberPollRefs.current[memberId];
        setMemberTaskMap(prev => ({ ...prev, [memberId]: { taskId, type, status: 'TIMEOUT', message: '轮询超时' } }));
        return;
      }
      try {
        const task = await apiRequest<{ status: string; lastErrorMessage?: string }>(`tasks/${taskId}`);
        setMemberTaskMap(prev => ({ ...prev, [memberId]: { taskId, type, status: task.status, message: statusLabels[task.status] ?? task.status } }));

        if (terminalStatuses.has(task.status)) {
          clearInterval(memberPollRefs.current[memberId]);
          delete memberPollRefs.current[memberId];

          if (task.status === 'SUCCESS' || task.status === 'REPLACED_AND_INVITE_SENT') {
            showToast('success', statusLabels[task.status]);
          } else if (task.status === 'FAILED') {
            showToast('error', task.lastErrorMessage ?? statusLabels[task.status]);
          }

          // Refresh member list
          if (expandedGroupIdRef.current === groupId) {
            refreshGroupDetail(groupId);
          }

          // Auto-clear after 10 seconds
          setTimeout(() => setMemberTaskMap(prev => {
            const next = { ...prev };
            if (next[memberId]?.taskId === taskId) delete next[memberId];
            return next;
          }), 10000);
        }
      } catch { /* network error, keep polling */ }
    }, 3000);
  }

  async function handleSync(groupId: string) {
    // Stop any existing poll
    if (syncPollRef.current) { clearInterval(syncPollRef.current); syncPollRef.current = null; }

    setSyncingGroupId(groupId);
    setSyncStatus(null);
    try {
      const result = await onSync(groupId);
      if (!result) {
        showToast('error', '同步触发失败');
        setSyncingGroupId(null);
        return;
      }

      // Start polling task status
      const { taskId } = result;
      setSyncStatus({ groupId, taskId, status: 'PENDING', message: '任务已入队' });

      let pollCount = 0;
      const MAX_POLLS = 60; // 60 × 3s = 3 minutes timeout

      syncPollRef.current = setInterval(async () => {
        pollCount++;
        if (pollCount > MAX_POLLS) {
          if (syncPollRef.current) { clearInterval(syncPollRef.current); syncPollRef.current = null; }
          setSyncingGroupId(null);
          setSyncStatus({ groupId, taskId, status: 'TIMEOUT', message: '轮询超时，请在任务面板查看' });
          showToast('error', '同步任务超时，请到任务面板查看状态');
          setTimeout(() => setSyncStatus((prev) => prev?.taskId === taskId ? null : prev), 8000);
          return;
        }

        try {
          const task = await apiRequest<{ status: string; resultMessage?: string; lastErrorMessage?: string }>(`tasks/${taskId}`);
          const terminalStatuses = new Set(['SUCCESS', 'FAILED', 'MANUAL_REVIEW', 'CANCELLED', 'REPLACED_AND_INVITE_SENT']);
          const statusLabels: Record<string, string> = {
            PENDING: '排队中',
            QUEUED: '排队中',
            RUNNING: '同步执行中',
            SUCCESS: '同步完成',
            FAILED: '同步失败',
            MANUAL_REVIEW: '需要人工处理',
            CANCELLED: '已取消',
          };

          setSyncStatus({
            groupId,
            taskId,
            status: task.status,
            message: statusLabels[task.status] ?? task.status,
          });

          if (terminalStatuses.has(task.status)) {
            if (syncPollRef.current) { clearInterval(syncPollRef.current); syncPollRef.current = null; }
            setSyncingGroupId(null);

            if (task.status === 'SUCCESS') {
              showToast('success', '同步完成');
            } else if (task.status === 'FAILED') {
              showToast('error', task.lastErrorMessage ?? '同步失败');
            } else if (task.status === 'MANUAL_REVIEW') {
              showToast('error', '同步需要人工处理');
            }

            // Refresh member detail if expanded (read from ref to avoid stale closure)
            if (expandedGroupIdRef.current === groupId) {
              refreshGroupDetail(groupId);
            }

            // Auto-clear status after 8 seconds
            setTimeout(() => setSyncStatus((prev) => prev?.taskId === taskId ? null : prev), 8000);
          }
        } catch {
          // Network error during poll — keep polling, don't crash
        }
      }, 3000);
    } catch {
      showToast('error', '同步请求异常');
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
          <button
            className={`panel-tab${activeTab === "expiry" ? " active" : ""}`}
            onClick={() => { setActiveTab("expiry"); fetchExpiryMembers(1); }}
            type="button"
          >
            到期管理
          </button>
        </div>

        {activeTab === "expiry" ? (
          <div className="panel-stack">
            {/* Expiry management panel */}
            <div className="form-card field-grid workspace-form">
              <div className="notice" style={{ background: 'var(--surface-2, #f5f5f4)', border: 'none', borderRadius: '8px', padding: '10px 14px', fontSize: '0.875rem', lineHeight: 1.7 }}>
                <strong>到期管理</strong>：查看即将到期或已到期的成员，支持按邮箱搜索、批量踢出。
              </div>
              {/* Filters */}
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                <select
                  value={expiryFilter}
                  onChange={(e) => { const v = e.target.value as any; setExpiryFilter(v); fetchExpiryMembers(1, { filter: v }); }}
                  style={{ minWidth: 120 }}
                >
                  <option value="all">全部有到期时间</option>
                  <option value="expired">🔴 已到期</option>
                  <option value="expiring_soon">🟡 7天内到期</option>
                </select>
                <div style={{ position: 'relative', flex: '1 1 200px', minWidth: 160 }}>
                  <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--foreground-muted, #a3a3a3)', fontSize: '0.9rem', pointerEvents: 'none' }}>🔍</span>
                  <input
                    type="text"
                    placeholder="搜索子号邮箱…"
                    value={expirySearch}
                    onChange={(e) => setExpirySearch(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && fetchExpiryMembers(1)}
                    style={{ paddingLeft: 32, width: '100%', boxSizing: 'border-box' }}
                  />
                </div>
                <button className="button secondary small" type="button" onClick={() => fetchExpiryMembers(1)}>
                  查询
                </button>
              </div>

              {/* Results table */}
              {expiryLoading ? (
                <div style={{ padding: '20px', textAlign: 'center' }}><Spinner size={20} /> 加载中...</div>
              ) : expiryMembers.length === 0 ? (
                <div className="muted" style={{ padding: '20px', textAlign: 'center', fontSize: '0.875rem' }}>无匹配记录</div>
              ) : (
                <>
                  <div style={{ fontSize: '0.875rem', color: 'var(--foreground-muted)', marginBottom: '4px' }}>
                    共 {expiryTotal} 条 · 第 {expiryPage}/{Math.ceil(expiryTotal / EXPIRY_PAGE_SIZE)} 页 · 已选 {expirySelected.size} 个
                  </div>
                  <table className="data-table" style={{ fontSize: '0.875rem' }}>
                    <thead>
                      <tr>
                        <th style={{ width: 30 }}>
                          <input
                            type="checkbox"
                            checked={expirySelected.size === expiryMembers.length && expiryMembers.length > 0}
                            onChange={(e) => {
                              if (e.target.checked) setExpirySelected(new Set(expiryMembers.map(m => m.id)));
                              else setExpirySelected(new Set());
                            }}
                          />
                        </th>
                        <th>邮箱</th>
                        <th>家庭组</th>
                        <th>到期时间</th>
                        <th>剩余天数</th>
                        <th>状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {expiryMembers.map(m => (
                        <tr key={m.id} style={m.isExpired ? { background: 'rgba(239,68,68,0.05)' } : undefined}>
                          <td>
                            <input
                              type="checkbox"
                              checked={expirySelected.has(m.id)}
                              onChange={(e) => {
                                const next = new Set(expirySelected);
                                if (e.target.checked) next.add(m.id);
                                else next.delete(m.id);
                                setExpirySelected(next);
                              }}
                            />
                          </td>
                          <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{m.email}</td>
                          <td style={{ fontSize: '0.8rem' }}>{m.groupName}</td>
                          <td style={{ fontSize: '0.8rem', color: m.isExpired ? '#dc2626' : m.daysRemaining !== null && m.daysRemaining <= 7 ? '#d97706' : undefined }}>
                            {m.expiresAt ? new Date(m.expiresAt).toLocaleDateString('zh-CN') : '-'}
                          </td>
                          <td style={{ fontSize: '0.8rem', fontWeight: 600, color: m.isExpired ? '#dc2626' : m.daysRemaining !== null && m.daysRemaining <= 3 ? '#d97706' : '#059669' }}>
                            {m.daysRemaining !== null ? (m.daysRemaining <= 0 ? `已过期 ${Math.abs(m.daysRemaining)} 天` : `${m.daysRemaining} 天`) : '-'}
                          </td>
                          <td><StatusBadge value={m.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {/* Pagination */}
                  {Math.ceil(expiryTotal / EXPIRY_PAGE_SIZE) > 1 && (
                    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px', padding: '8px 0' }}>
                      <button className="button secondary small" disabled={expiryPage <= 1} onClick={() => fetchExpiryMembers(expiryPage - 1)} type="button">← 上页</button>
                      <span style={{ fontSize: '0.85rem' }}>{expiryPage} / {Math.ceil(expiryTotal / EXPIRY_PAGE_SIZE)}</span>
                      <button className="button secondary small" disabled={expiryPage >= Math.ceil(expiryTotal / EXPIRY_PAGE_SIZE)} onClick={() => fetchExpiryMembers(expiryPage + 1)} type="button">下页 →</button>
                    </div>
                  )}

                  {/* Bulk actions */}
                  <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                    <button
                      className="button"
                      style={{ background: 'var(--red, #dc2626)', color: '#fff', border: 'none' }}
                      disabled={expirySelected.size === 0 || expiryRemoving}
                      onClick={handleBulkRemoveExpired}
                      type="button"
                    >
                      {expiryRemoving ? <><Spinner size={14} color="currentColor" /> 踢出中...</> : `🗑 批量踢出 (${expirySelected.size})`}
                    </button>
                  </div>

                  {expiryRemoveResult && <BatchResultTable result={expiryRemoveResult} />}
                </>
              )}
            </div>
          </div>
        ) : activeTab === "batch" ? (
          <div className="panel-stack">
            {/* Batch sub-tab bar */}
            <div className="panel-tabs" style={{ gap: '4px' }}>
              {([
                { id: "cross-invite" as const, label: "跨组邀请" },
                { id: "cross-remove" as const, label: "跨组踢人" },
                { id: "group-invite" as const, label: "指定组邀请" },
                { id: "group-remove" as const, label: "指定组踢人" },
                { id: "transfer" as const, label: "整组迁移" }
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

            {batchSubTab === "transfer" ? (
              <div className="form-card field-grid workspace-form">
                <div className="notice" style={{ background: 'var(--surface-2, #f5f5f4)', border: 'none', borderRadius: '8px', padding: '10px 14px', fontSize: '0.875rem', lineHeight: 1.7 }}>
                  <strong>整组迁移</strong>：将 A 组成员整体迁移到 B 组。自动执行“先踢出、再邀请”两阶段流程，允许部分失败。留空邮箱列表 = 迁移全组。
                </div>
                <div className="field">
                  <label>源家庭组（踢出成员）</label>
                  <SearchableSelect id="transfer-source" value={transferSourceId} onChange={setTransferSourceId} placeholder="-- 选择源家庭组 --" options={groups.map(g => ({ value: g.id, label: `${g.groupName} · ${g.account?.name ?? '-'}` }))} />
                </div>
                <div className="field">
                  <label>目标家庭组（邀请成员）</label>
                  <SearchableSelect id="transfer-target" value={transferTargetId} onChange={setTransferTargetId} placeholder="-- 选择目标家庭组 --" options={groups.filter(g => g.id !== transferSourceId).map(g => ({ value: g.id, label: `${g.groupName} · ${g.availableSlots} slots · ${g.account?.name ?? '-'}` }))} />
                </div>
                <div className="field">
                  <label htmlFor="transfer-emails">指定迁移邮箱（可选，留空 = 迁移全组非 Owner 成员）</label>
                  <textarea id="transfer-emails" rows={4} placeholder="留空即迁移全组\n或每行一个邮箱指定迁移哪些" value={transferEmails} onChange={e => setTransferEmails(e.target.value)} style={{ fontFamily: 'monospace', fontSize: '0.875rem', resize: 'vertical' }} />
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button className="button" type="button" disabled={transferLoading || !transferSourceId || !transferTargetId} onClick={submitTransfer}>
                    {transferLoading ? <><Spinner size={14} color="currentColor" /> 提交中...</> : '🚀 开始迁移'}
                  </button>
                </div>
                {transferStatus && (
                  <div style={{ marginTop: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                      <strong>迁移批次</strong>
                      <StatusBadge value={transferStatus.phase} />
                      {["REMOVING", "INVITING"].includes(transferStatus.phase) && <Spinner size={14} />}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', marginBottom: '12px' }}>
                      <div style={{ background: 'var(--surface-2, #f5f5f4)', borderRadius: '8px', padding: '10px', textAlign: 'center' }}>
                        <div style={{ fontSize: '0.875rem', color: '#666' }}>移除</div>
                        <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>
                          <span style={{ color: '#16a34a' }}>{transferStatus.removes.success}</span>
                          {transferStatus.removes.failed > 0 && <span style={{ color: '#dc2626' }}> / {transferStatus.removes.failed}❌</span>}
                          {transferStatus.removes.pending > 0 && <span style={{ color: '#d97706' }}> / {transferStatus.removes.pending}⏳</span>}
                        </div>
                      </div>
                      <div style={{ background: 'var(--surface-2, #f5f5f4)', borderRadius: '8px', padding: '10px', textAlign: 'center' }}>
                        <div style={{ fontSize: '0.875rem', color: '#666' }}>邀请</div>
                        <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>
                          <span style={{ color: '#16a34a' }}>{transferStatus.invites.sent}</span>
                          {transferStatus.invites.failed > 0 && <span style={{ color: '#dc2626' }}> / {transferStatus.invites.failed}❌</span>}
                          {transferStatus.invites.pending > 0 && <span style={{ color: '#d97706' }}> / {transferStatus.invites.pending}⏳</span>}
                        </div>
                      </div>
                      <div style={{ background: 'var(--surface-2, #f5f5f4)', borderRadius: '8px', padding: '10px', textAlign: 'center' }}>
                        <div style={{ fontSize: '0.875rem', color: '#666' }}>总成员</div>
                        <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>{transferStatus.totalMembers}</div>
                      </div>
                    </div>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
                      <thead><tr style={{ borderBottom: '1px solid #e5e7eb' }}><th style={{ textAlign: 'left', padding: '6px 8px' }}>邮箱</th><th style={{ textAlign: 'center', padding: '6px 8px' }}>移除</th><th style={{ textAlign: 'center', padding: '6px 8px' }}>邀请</th></tr></thead>
                      <tbody>
                        {transferStatus.memberDetails.map(m => (
                          <tr key={m.email} style={{ borderBottom: '1px solid #f3f4f6' }}>
                            <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontSize: '0.8rem' }}>{m.email}</td>
                            <td style={{ textAlign: 'center', padding: '6px 8px' }}><StatusBadge value={m.removeStatus} /></td>
                            <td style={{ textAlign: 'center', padding: '6px 8px' }}>{m.inviteStatus ? <StatusBadge value={m.inviteStatus} /> : <span className="muted">—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {transferStatus.errorDetail.length > 0 && (
                      <div style={{ marginTop: '8px', background: '#fef2f2', borderRadius: '8px', padding: '10px 14px', fontSize: '0.875rem' }}>
                        <div style={{ fontWeight: 600, color: '#dc2626', marginBottom: '4px' }}>⚠️ 错误详情</div>
                        {transferStatus.errorDetail.map((e, i) => (<div key={i} style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{e.email}: {e.error}</div>))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
            <div className="form-card field-grid workspace-form">
              {/* Description */}
              <div className="notice" style={{ background: 'var(--surface-2, #f5f5f4)', border: 'none', borderRadius: '8px', padding: '10px 14px', fontSize: '0.875rem', lineHeight: 1.7 }}>
                {batchSubTab === "cross-invite" && <><strong>跨组批量邀请</strong>：自动分配到可用槽位，先填满第一组再溢出到下一组。</>}
                {batchSubTab === "cross-remove" && <><strong>跨组批量踢人</strong>：自动查找每个邮箱所在组并入队移除任务。</>}
                {batchSubTab === "group-invite" && <><strong>指定组批量邀请</strong>：选择目标家庭组，一次最多 5 个。超出 availableSlots 时拒绝。</>}
                {batchSubTab === "group-remove" && <><strong>指定组批量踢人</strong>：选择目标家庭组，批量移除指定邮箱成员。</>}
              </div>

              {/* Valid days for invite operations */}
              {(batchSubTab === "cross-invite" || batchSubTab === "group-invite") && (
                <div className="field" style={{ maxWidth: 200 }}>
                  <label htmlFor="batch-valid-days">有效天数（默认 30）</label>
                  <input
                    id="batch-valid-days"
                    type="number"
                    min={1}
                    value={batchValidDays}
                    onChange={(e) => setBatchValidDays(parseInt(e.target.value, 10) || 30)}
                    style={{ width: '100%' }}
                  />
                </div>
              )}

              {/* Group selector for single-group ops */}
              {(batchSubTab === "group-invite" || batchSubTab === "group-remove") && (
                <div className="field">
                  <label htmlFor="batch-group-select">目标家庭组</label>
                  <SearchableSelect
                    id="batch-group-select"
                    value={batchGroupId}
                    onChange={(val) => { setBatchGroupId(val); setBatchResult(null); }}
                    placeholder="-- 请选择家庭组 --"
                    options={groups.map(g => ({
                      value: g.id,
                      label: `${g.groupName} · ${g.availableSlots} slots · ${g.account?.name ?? '-'}`
                    }))}
                  />
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
                      if (batchSubTab === "cross-invite") result = await onCrossInvite(emails, batchValidDays);
                      else if (batchSubTab === "cross-remove") result = await onCrossRemove(emails);
                      else if (batchSubTab === "group-invite") result = await onBulkInviteGroup(batchGroupId, emails, batchValidDays);
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
            )}
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
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' }}>
            {/* Search mode toggle */}
            <div style={{
              display: 'inline-flex',
              borderRadius: '8px',
              border: '1px solid var(--border, #e5e5e5)',
              overflow: 'hidden',
              flexShrink: 0,
            }}>
              <button
                type="button"
                onClick={() => { setSearchMode("parent"); setSearchEmail(""); setMemberGroups([]); setMemberSearchDone(false); setCurrentGroupPage(1); }}
                style={{
                  padding: '6px 14px',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  border: 'none',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  background: searchMode === "parent" ? 'var(--accent, #2563eb)' : 'transparent',
                  color: searchMode === "parent" ? '#fff' : 'var(--foreground-muted, #737373)',
                }}
              >
                母号
              </button>
              <button
                type="button"
                onClick={() => { setSearchMode("member"); setSearchEmail(""); setMemberGroups([]); setMemberSearchDone(false); setCurrentGroupPage(1); }}
                style={{
                  padding: '6px 14px',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  border: 'none',
                  borderLeft: '1px solid var(--border, #e5e5e5)',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  background: searchMode === "member" ? 'var(--accent, #2563eb)' : 'transparent',
                  color: searchMode === "member" ? '#fff' : 'var(--foreground-muted, #737373)',
                }}
              >
                子号
              </button>
            </div>
            {/* Search input */}
            <div style={{ position: 'relative', flex: '1 1 200px', minWidth: 160 }}>
              <svg style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--foreground-muted, #a3a3a3)' }} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input
                id="group-search-email"
                type="text"
                placeholder={searchMode === "parent" ? "搜索母号邮箱…" : "搜索子号邮箱…"}
                value={searchEmail}
                onChange={(e) => {
                  setSearchEmail(e.target.value);
                  if (searchMode === "parent") setCurrentGroupPage(1);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && searchMode === "member") fetchGroupsByMember();
                }}
                style={{
                  paddingLeft: 34,
                  width: '100%',
                  boxSizing: 'border-box',
                  borderRadius: '8px',
                  border: '1px solid var(--border, #e5e5e5)',
                  height: '36px',
                  fontSize: '0.875rem',
                  transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
                  outline: 'none',
                }}
                onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent, #2563eb)'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(37,99,235,0.1)'; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border, #e5e5e5)'; e.currentTarget.style.boxShadow = 'none'; }}
              />
            </div>
            {searchMode === "member" && (
              <button
                className="button small"
                type="button"
                onClick={() => fetchGroupsByMember()}
                disabled={memberSearchLoading || searchEmail.trim().length < 2}
                style={{ height: '36px', borderRadius: '8px', fontWeight: 600, minWidth: 60 }}
              >
                {memberSearchLoading ? '…' : '查询'}
              </button>
            )}
            {searchMode === "parent" && (
              <select
                id="group-filter-status"
                value={filterStatus}
                onChange={(e) => { setFilterStatus(e.target.value); setCurrentGroupPage(1); }}
                style={{ flex: '0 0 auto', minWidth: 120, height: '36px', borderRadius: '8px', border: '1px solid var(--border, #e5e5e5)', fontSize: '0.875rem' }}
              >
                <option value="ALL">全部状态</option>
                <option value="ACTIVE">🟢 ACTIVE</option>
                <option value="MANUAL_ONLY">⏸ MANUAL_ONLY</option>
                <option value="DISABLED">🚫 DISABLED</option>
              </select>
            )}
            {(searchEmail || filterStatus !== 'ALL') && (
              <button
                className="button secondary small"
                type="button"
                onClick={() => { setSearchEmail(''); setFilterStatus('ALL'); setCurrentGroupPage(1); setMemberGroups([]); setMemberSearchDone(false); }}
                style={{ whiteSpace: 'nowrap', height: '36px', borderRadius: '8px' }}
              >
                清除
              </button>
            )}
          </div>

          {/* ----- Unified group table (both 母号 and 子号 modes) ----- */}
          {(() => {
            // In member mode: show loading / prompt states
            if (searchMode === "member") {
              if (memberSearchLoading) return <div style={{ padding: '24px', textAlign: 'center' }}><Spinner size={20} /> 搜索中...</div>;
              if (!memberSearchDone) return <div className="muted" style={{ padding: '24px', textAlign: 'center', fontSize: '0.875rem' }}>输入子号邮箱后点击查询</div>;
            }

            // Compute source and apply filters
            const source = searchMode === "member" ? memberGroups : groups;
            const q = searchEmail.trim().toLowerCase();
            const filtered = searchMode === "parent"
              ? source.filter((g) => {
                  const matchEmail = !q || (g.account?.loginEmail ?? '').toLowerCase().includes(q);
                  const matchStatus = filterStatus === 'ALL' || g.status === filterStatus;
                  return matchEmail && matchStatus;
                })
              : source;
            const totalGroupPages = Math.ceil(filtered.length / PAGE_SIZE);
            const displayed = filtered.slice((currentGroupPage - 1) * PAGE_SIZE, currentGroupPage * PAGE_SIZE);

            return (
              <>
                {/* Stats bar */}
                <div style={{ fontSize: '0.875rem', color: 'var(--foreground-muted, #737373)', marginBottom: '6px' }}>
                  {searchMode === "member"
                    ? `找到 ${filtered.length} 个家庭组`
                    : `共 ${groups.length} 组${filtered.length < groups.length ? ` · 筛选 ${filtered.length} 条` : ''}`}
                  {totalGroupPages > 0 && ` · 第 ${currentGroupPage}/${totalGroupPages} 页`}
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
                                {group.memberCount ?? group._count?.members ?? 0} members ·{" "}
                                {group.pendingInviteCount ?? group._count?.invites ?? 0} invites
                              </div>
                            </td>
                            <td>
                              <div>{group.availableSlots} slots left</div>
                              <div className="muted">risk {group.riskScore}</div>
                            </td>
                            <td>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <StatusBadge value={group.status} />
                                {!group.lastSyncedAt && (
                                  <span 
                                    className="badge" 
                                    style={{ 
                                      background: 'rgba(239,68,68,0.12)', 
                                      color: '#dc2626', 
                                      fontSize: '0.7rem', 
                                      fontWeight: 600,
                                      padding: '1px 6px',
                                      borderRadius: '4px'
                                    }}
                                    title="该组尚未同步，已被自动邀请/轮换系统排除"
                                  >
                                    ⚠️ 未同步
                                  </span>
                                )}
                              </div>
                            </td>
                            <td>
                              <div>{group.account?.name ?? "-"}</div>
                              {group.account?.loginEmail && (
                                <div className="muted" style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                                  {group.account.loginEmail}
                                </div>
                              )}
                              {(
                                <div style={{ marginTop: '2px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
                                  <span style={{
                                    padding: '1px 6px',
                                    borderRadius: '4px',
                                    fontWeight: 600,
                                    fontSize: '0.75rem',
                                    background: group.account?.subscriptionStatus === 'ACTIVE' ? 'rgba(16,185,129,0.12)' : group.account?.subscriptionStatus === 'EXPIRED' ? 'rgba(239,68,68,0.12)' : group.account?.subscriptionStatus === 'SUSPENDED' ? 'rgba(245,158,11,0.12)' : 'rgba(156,163,175,0.12)',
                                    color: group.account?.subscriptionStatus === 'ACTIVE' ? '#059669' : group.account?.subscriptionStatus === 'EXPIRED' ? '#dc2626' : group.account?.subscriptionStatus === 'SUSPENDED' ? '#d97706' : '#6b7280',
                                  }}>
                                    {group.account?.subscriptionStatus === 'ACTIVE' ? '✅ 订阅中' : group.account?.subscriptionStatus === 'EXPIRED' ? '❌ 已过期' : group.account?.subscriptionStatus === 'SUSPENDED' ? '⚠️ 已暂停' : '❓ 未知'}
                                  </span>
                                  {group.account?.subscriptionPlan && (
                                    <span style={{ fontSize: '0.75rem', fontWeight: 500 }}>
                                      {group.account.subscriptionPlan}
                                    </span>
                                  )}
                                  <span className="muted" style={{ fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                    · 到期 
                                    {editingDateGroupId === group.id ? (
                                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                                        <input
                                          type="date"
                                          value={editingDateValue}
                                          onChange={e => setEditingDateValue(e.target.value)}
                                          style={{ padding: '0px 4px', fontSize: '0.75rem', height: '20px' }}
                                        />
                                        <button
                                          type="button"
                                          style={{ background: 'var(--emerald, #059669)', color: 'white', border: 'none', borderRadius: '4px', padding: '0px 6px', height: '20px', cursor: 'pointer' }}
                                          disabled={isUpdatingDate}
                                          onClick={async () => {
                                            if (!onUpdateAccount || !group.account?.id) return;
                                            setIsUpdatingDate(true);
                                            try {
                                              const ok = await onUpdateAccount(group.account.id, { subscriptionExpiresAt: editingDateValue || undefined });
                                              if (ok) setEditingDateGroupId(null);
                                            } finally {
                                              setIsUpdatingDate(false);
                                            }
                                          }}
                                        >
                                          {isUpdatingDate ? "..." : "保存"}
                                        </button>
                                        <button
                                          type="button"
                                          style={{ background: 'var(--foreground-muted, #737373)', color: 'white', border: 'none', borderRadius: '4px', padding: '0px 6px', height: '20px', cursor: 'pointer' }}
                                          disabled={isUpdatingDate}
                                          onClick={() => setEditingDateGroupId(null)}
                                        >
                                          取消
                                        </button>
                                      </span>
                                    ) : (
                                      <>
                                        {group.account?.subscriptionExpiresAt ? formatDate(group.account.subscriptionExpiresAt) : '未设置'}
                                        {canManage && onUpdateAccount && (
                                          <button
                                            type="button"
                                            title="修改到期时间"
                                            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: '0.75rem' }}
                                            onClick={() => {
                                              setEditingDateGroupId(group.id);
                                              setEditingDateValue(group.account?.subscriptionExpiresAt ? new Date(group.account.subscriptionExpiresAt).toISOString().split('T')[0] : '');
                                            }}
                                          >
                                            ✏️
                                          </button>
                                        )}
                                      </>
                                    )}
                                  </span>
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
                                {/* Sync status indicator */}
                                {syncStatus?.groupId === group.id && (
                                  <span style={{
                                    fontSize: '0.8rem',
                                    fontWeight: 500,
                                    padding: '2px 8px',
                                    borderRadius: '4px',
                                    whiteSpace: 'nowrap',
                                    background: syncStatus.status === 'SUCCESS' ? 'rgba(16,185,129,0.12)'
                                      : syncStatus.status === 'FAILED' || syncStatus.status === 'MANUAL_REVIEW' ? 'rgba(239,68,68,0.12)'
                                      : 'rgba(59,130,246,0.12)',
                                    color: syncStatus.status === 'SUCCESS' ? '#059669'
                                      : syncStatus.status === 'FAILED' || syncStatus.status === 'MANUAL_REVIEW' ? '#dc2626'
                                      : '#2563eb',
                                  }}>
                                    {syncStatus.status === 'RUNNING' && <Spinner size={10} color="currentColor" />}
                                    {' '}{syncStatus.message}
                                  </span>
                                )}
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
                                                 <th>到期时间</th>
                                                 {canManage && <th style={{ minWidth: 80 }}>操作</th>}
                                               </tr>
                                             </thead>
                                             <tbody>
                                                {groupDetail.members.map((m) => {
                                                  const ownerEmail = group.account?.loginEmail?.toLowerCase() ?? "";
                                                  const isOwner = m.role === "OWNER" || (ownerEmail !== "" && m.email.toLowerCase() === ownerEmail);
                                                  return (
                                                   <Fragment key={m.id}>
                                                   <tr style={isOwner ? { background: 'rgba(56,189,248,0.06)' } : undefined}>
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
                                                     <td className="muted">{m.joinedAt ? formatDate(m.joinedAt) : '-'}</td>
                                                     <td>
                                                       <span style={{ color: m.expiresAt && new Date(m.expiresAt) <= new Date() ? '#dc2626' : m.expiresAt && new Date(m.expiresAt) <= new Date(Date.now() + 7 * 86400000) ? '#d97706' : undefined }}>
                                                         {m.expiresAt ? formatDate(m.expiresAt) : <span className="muted">-</span>}
                                                       </span>
                                                       {canManage && !isOwner && editingMemberId !== m.id && (
                                                         <button
                                                           type="button"
                                                           onClick={() => { setEditingMemberId(m.id); setEditJoinedAt(m.joinedAt ? m.joinedAt.slice(0, 16) : ''); setEditExpiresAt(m.expiresAt ? m.expiresAt.slice(0, 16) : ''); }}
                                                           style={{
                                                             marginLeft: '6px',
                                                             fontSize: '0.7rem',
                                                             padding: '2px 8px',
                                                             borderRadius: '4px',
                                                             border: '1px solid var(--border, #e5e5e5)',
                                                             background: 'var(--surface-2, #fafaf9)',
                                                             color: 'var(--foreground-muted, #737373)',
                                                             cursor: 'pointer',
                                                             transition: 'all 0.15s',
                                                             verticalAlign: 'middle',
                                                           }}
                                                           onMouseEnter={e => { e.currentTarget.style.background = 'var(--accent, #2563eb)'; e.currentTarget.style.color = '#fff'; e.currentTarget.style.borderColor = 'var(--accent, #2563eb)'; }}
                                                           onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface-2, #fafaf9)'; e.currentTarget.style.color = 'var(--foreground-muted, #737373)'; e.currentTarget.style.borderColor = 'var(--border, #e5e5e5)'; }}
                                                         >
                                                           编辑
                                                         </button>
                                                       )}
                                                     </td>
                                                     {canManage && (
                                                       <td>
                                                         {!isOwner && (<>
                                                           <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' }}>
                                                             <button
                                                               className="button"
                                                               style={{ fontSize: '0.8rem', padding: '3px 10px', background: 'var(--red, #dc2626)', color: '#fff', border: 'none', whiteSpace: 'nowrap', borderRadius: '4px', cursor: 'pointer' }}
                                                               disabled={removingMemberId === m.id || replacingMemberId !== null || !!memberTaskMap[m.id]}
                                                                onClick={async () => {
                                                                  if (!confirm(`确定移除成员 ${m.email}？`)) return;
                                                                  setRemovingMemberId(m.id);
                                                                  try {
                                                                    const result = await onRemoveMember(group.id, m.email);
                                                                    if (result?.taskId) {
                                                                      pollMemberTask(m.id, result.taskId, 'remove', group.id);
                                                                    }
                                                                  } finally {
                                                                    setRemovingMemberId(null);
                                                                  }
                                                                }}
                                                               type="button"
                                                             >
                                                               {removingMemberId === m.id ? "提交中..." : "🗑 移除"}
                                                             </button>
                                                             <button
                                                               className="button"
                                                               style={{ fontSize: '0.8rem', padding: '3px 10px', background: 'rgba(139,92,246,0.15)', color: '#a78bfa', border: '1px solid rgba(139,92,246,0.3)', whiteSpace: 'nowrap', borderRadius: '4px', cursor: 'pointer' }}
                                                               disabled={removingMemberId !== null || (replacingMemberId !== null && replacingMemberId !== m.id) || !!memberTaskMap[m.id]}
                                                               onClick={() => { setReplacingMemberId(replacingMemberId === m.id ? null : m.id); setReplaceEmail(''); }}
                                                               type="button"
                                                             >
                                                               🔀 替换
                                                             </button>
                                                              {/* Per-member task status indicator */}
                                                              {memberTaskMap[m.id] && (() => {
                                                                const ts = memberTaskMap[m.id];
                                                                const isOk = ts.status === 'SUCCESS' || ts.status === 'REPLACED_AND_INVITE_SENT';
                                                                const isFail = ts.status === 'FAILED' || ts.status === 'MANUAL_REVIEW' || ts.status === 'TIMEOUT';
                                                                const isRunning = ts.status === 'RUNNING';
                                                                return (
                                                                  <span style={{
                                                                    fontSize: '0.78rem',
                                                                    fontWeight: 500,
                                                                    padding: '2px 8px',
                                                                    borderRadius: '4px',
                                                                    whiteSpace: 'nowrap',
                                                                    display: 'inline-flex',
                                                                    alignItems: 'center',
                                                                    gap: '4px',
                                                                    background: isOk ? 'rgba(16,185,129,0.12)' : isFail ? 'rgba(239,68,68,0.12)' : 'rgba(59,130,246,0.12)',
                                                                    color: isOk ? '#059669' : isFail ? '#dc2626' : '#2563eb',
                                                                  }}>
                                                                    {isRunning && <Spinner size={10} color="currentColor" />}
                                                                    {ts.message}
                                                                  </span>
                                                                );
                                                              })()}
                                                           </div>
                                                           {replacingMemberId === m.id && (
                                                             <div style={{ display: 'flex', gap: '4px', alignItems: 'center', marginTop: '4px' }}>
                                                               <input
                                                                 type="email"
                                                                 placeholder="新邮箱"
                                                                 value={replaceEmail}
                                                                 onChange={(e) => setReplaceEmail(e.target.value)}
                                                                 style={{ fontSize: '0.8rem', padding: '3px 6px', width: '180px' }}
                                                                 autoFocus
                                                               />
                                                               <button
                                                                 className="button"
                                                                 style={{ fontSize: '0.75rem', padding: '3px 8px', background: 'rgba(139,92,246,0.2)', color: '#a78bfa', border: '1px solid rgba(139,92,246,0.4)', borderRadius: '4px', cursor: 'pointer', whiteSpace: 'nowrap' }}
                                                                 disabled={!replaceEmail.trim() || removingMemberId !== null}
                                                                 onClick={async () => {
                                                                   const newE = replaceEmail.trim().toLowerCase();
                                                                   if (!newE) return;
                                                                   if (newE === m.email.toLowerCase()) { alert('新邮箱不能与原邮箱相同'); return; }
                                                                   if (!confirm(`确认将 ${m.email} 替换为 ${newE}？\n将自动踢出旧成员并邀请新成员。`)) return;
                                                                   setRemovingMemberId(m.id);
                                                                   try {
                                                                      const result = await onReplaceMember(group.id, m.email, newE);
                                                                      setReplacingMemberId(null);
                                                                      setReplaceEmail('');
                                                                      if (result?.taskId) {
                                                                        pollMemberTask(m.id, result.taskId, 'replace', group.id);
                                                                      }
                                                                   } finally {
                                                                     setRemovingMemberId(null);
                                                                   }
                                                                 }}
                                                                 type="button"
                                                               >
                                                                 确认
                                                               </button>
                                                               <button
                                                                 className="button secondary"
                                                                 style={{ fontSize: '0.75rem', padding: '3px 6px', borderRadius: '4px', cursor: 'pointer' }}
                                                                 onClick={() => { setReplacingMemberId(null); setReplaceEmail(''); }}
                                                                 type="button"
                                                               >
                                                                 取消
                                                               </button>
                                                             </div>
                                                           )}
                                                         </>)}
                                                       </td>
                                                     )}
                                                   </tr>
                                                   {editingMemberId === m.id && (
                                                     <tr style={{ background: 'rgba(37,99,235,0.04)' }}>
                                                       <td colSpan={canManage ? 7 : 6} style={{ padding: '10px 16px' }}>
                                                         <div style={{
                                                           display: 'flex',
                                                           alignItems: 'center',
                                                           gap: '16px',
                                                           flexWrap: 'wrap',
                                                           fontSize: '0.8rem',
                                                         }}>
                                                           <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                             <label style={{ fontWeight: 600, color: 'var(--foreground-muted, #737373)', whiteSpace: 'nowrap' }}>加入时间</label>
                                                             <input
                                                               type="datetime-local"
                                                               value={editJoinedAt}
                                                               onChange={e => setEditJoinedAt(e.target.value)}
                                                               style={{
                                                                 fontSize: '0.8rem',
                                                                 padding: '4px 8px',
                                                                 height: '32px',
                                                                 borderRadius: '6px',
                                                                 border: '1px solid var(--border, #e5e5e5)',
                                                                 outline: 'none',
                                                                 transition: 'border-color 0.15s',
                                                               }}
                                                               onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent, #2563eb)'; }}
                                                               onBlur={e => { e.currentTarget.style.borderColor = 'var(--border, #e5e5e5)'; }}
                                                             />
                                                           </div>
                                                           <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                             <label style={{ fontWeight: 600, color: 'var(--foreground-muted, #737373)', whiteSpace: 'nowrap' }}>到期时间</label>
                                                             <input
                                                               type="datetime-local"
                                                               value={editExpiresAt}
                                                               onChange={e => setEditExpiresAt(e.target.value)}
                                                               style={{
                                                                 fontSize: '0.8rem',
                                                                 padding: '4px 8px',
                                                                 height: '32px',
                                                                 borderRadius: '6px',
                                                                 border: '1px solid var(--border, #e5e5e5)',
                                                                 outline: 'none',
                                                                 transition: 'border-color 0.15s',
                                                               }}
                                                               onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent, #2563eb)'; }}
                                                               onBlur={e => { e.currentTarget.style.borderColor = 'var(--border, #e5e5e5)'; }}
                                                             />
                                                           </div>
                                                           <div style={{ display: 'flex', gap: '6px', marginLeft: 'auto' }}>
                                                             <button
                                                               type="button"
                                                               disabled={savingMemberDates}
                                                               onClick={() => handleSaveMemberDates(m.id, group.id)}
                                                               style={{
                                                                 background: 'var(--accent, #2563eb)',
                                                                 color: '#fff',
                                                                 border: 'none',
                                                                 borderRadius: '6px',
                                                                 padding: '6px 16px',
                                                                 height: '32px',
                                                                 cursor: 'pointer',
                                                                 fontSize: '0.8rem',
                                                                 fontWeight: 600,
                                                                 transition: 'opacity 0.15s',
                                                                 opacity: savingMemberDates ? 0.6 : 1,
                                                               }}
                                                             >
                                                               {savingMemberDates ? '保存中...' : '保存'}
                                                             </button>
                                                             <button
                                                               type="button"
                                                               onClick={() => setEditingMemberId(null)}
                                                               style={{
                                                                 background: 'transparent',
                                                                 border: '1px solid var(--border, #d4d4d4)',
                                                                 borderRadius: '6px',
                                                                 padding: '6px 16px',
                                                                 height: '32px',
                                                                 cursor: 'pointer',
                                                                 fontSize: '0.8rem',
                                                                 color: 'var(--foreground-muted, #737373)',
                                                                 transition: 'all 0.15s',
                                                               }}
                                                               onMouseEnter={e => { e.currentTarget.style.borderColor = '#a3a3a3'; e.currentTarget.style.color = '#404040'; }}
                                                               onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border, #d4d4d4)'; e.currentTarget.style.color = 'var(--foreground-muted, #737373)'; }}
                                                             >
                                                               取消
                                                             </button>
                                                           </div>
                                                         </div>
                                                       </td>
                                                     </tr>
                                                   )}
                                                   </Fragment>
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

                {/* Pagination */}
                {totalGroupPages > 1 && (
                  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px', padding: '12px 0 4px' }}>
                    <button className="button secondary small" disabled={currentGroupPage <= 1} onClick={() => setCurrentGroupPage(p => Math.max(1, p - 1))} type="button" style={{ minWidth: 60 }}>← 上页</button>
                    <span style={{ fontSize: '0.85rem' }}>{currentGroupPage} / {totalGroupPages}</span>
                    <button className="button secondary small" disabled={currentGroupPage >= totalGroupPages} onClick={() => setCurrentGroupPage(p => Math.min(totalGroupPages, p + 1))} type="button" style={{ minWidth: 60 }}>下页 →</button>
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
