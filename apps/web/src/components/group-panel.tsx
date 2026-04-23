"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "../lib/client-api";
import { Spinner } from "./spinner";
import { 
  GroupPanelProps, 
  GroupDetail, 
  DuplicateMemberInfo, 
  ExpiredMemberInfo,
  parseEmails
} from "./group-panel-types";
import { CreateTab } from "./group-create-tab";
import { ExpiryTab } from "./group-expiry-tab";
import { BatchTab } from "./group-batch-tab";
import { InventoryTab } from "./group-inventory-tab";
import type { 
  CrossInviteResult, 
  CrossRemoveResult, 
  BulkGroupInviteResult, 
  BulkGroupRemoveResult,
  TransferStatusResult
} from "./console-app";

const EXPIRY_PAGE_SIZE = 50;

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
  onUpdateAccount,
  onMigrateMember,
}: GroupPanelProps) {
  const [activeTab, setActiveTab] = useState<"inventory" | "create" | "batch" | "expiry">("inventory");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error', msg: string } | null>(null);
  const canManage = role === "SUPER_ADMIN" || role === "ADMIN";

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

  // --- Duplicate detection state ---
  const [duplicateMembers, setDuplicateMembers] = useState<DuplicateMemberInfo[]>([]);
  const [duplicateEmailSet, setDuplicateEmailSet] = useState<Set<string>>(new Set());
  const [duplicateLoading, setDuplicateLoading] = useState(false);
  const [duplicateFetched, setDuplicateFetched] = useState(false);

  // --- Batch tab state ---
  const [batchSubTab, setBatchSubTab] = useState<"cross-invite" | "cross-remove" | "group-invite" | "group-remove" | "transfer">("cross-invite");
  const [batchText, setBatchText] = useState("");
  const [batchGroupId, setBatchGroupId] = useState("");
  const [batchValidDays, setBatchValidDays] = useState(30);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchResult, setBatchResult] = useState<CrossInviteResult | CrossRemoveResult | BulkGroupInviteResult | BulkGroupRemoveResult | null>(null);
  const [batchEmailStatuses, setBatchEmailStatuses] = useState<Array<{ email: string; status: string; errorMessage?: string }>>([]);
  const batchPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // --- Transfer state ---
  const [transferSourceId, setTransferSourceId] = useState("");
  const [transferTargetId, setTransferTargetId] = useState("");
  const [transferEmails, setTransferEmails] = useState("");
  const [transferLoading, setTransferLoading] = useState(false);
  const [transferStatus, setTransferStatus] = useState<TransferStatusResult | null>(null);
  const transferPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // --- Inventory state ---
  const [form, setForm] = useState({
    accountId: accounts[0]?.id ?? "",
    groupName: "",
    maxMembers: "5"
  });
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const expandedGroupIdRef = useRef<string | null>(null);
  const [groupDetail, setGroupDetail] = useState<GroupDetail | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [searchMode, setSearchMode] = useState<"parent" | "member">("parent");
  const [searchEmail, setSearchEmail] = useState("");
  const [filterStatus, setFilterStatus] = useState("ALL");
  const [filterExtra, setFilterExtra] = useState("ALL");
  const [currentGroupPage, setCurrentGroupPage] = useState(1);
  const [memberGroups, setMemberGroups] = useState<any[]>([]);
  const [memberSearchLoading, setMemberSearchLoading] = useState(false);
  const [memberSearchDone, setMemberSearchDone] = useState(false);

  // --- Task polling state ---
  const [syncingGroupId, setSyncingGroupId] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<{ groupId: string; taskId: string; status: string; message: string } | null>(null);
  const syncPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [togglingGroupId, setTogglingGroupId] = useState<string | null>(null);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
  const [replacingMemberId, setReplacingMemberId] = useState<string | null>(null);
  const [replaceEmail, setReplaceEmail] = useState("");
  const [migratingMemberId, setMigratingMemberId] = useState<string | null>(null);
  const [memberTaskMap, setMemberTaskMap] = useState<Record<string, { taskId: string; type: string; status: string; message: string }>>({});
  const memberPollRefs = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  // Account date editing
  const [editingDateGroupId, setEditingDateGroupId] = useState<string | null>(null);
  const [editingDateValue, setEditingDateValue] = useState("");
  const [isUpdatingDate, setIsUpdatingDate] = useState(false);

  // Member date editing
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [editJoinedAt, setEditJoinedAt] = useState('');
  const [editExpiresAt, setEditExpiresAt] = useState('');
  const [savingMemberDates, setSavingMemberDates] = useState(false);

  function showToast(type: 'success' | 'error', msg: string) {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 3500);
  }

  // --- Handlers ---

  async function fetchDuplicateMembers() {
    setDuplicateLoading(true);
    try {
      const data = await apiRequest<DuplicateMemberInfo[]>("family-groups/duplicate-members");
      if (data) {
        setDuplicateMembers(data);
        setDuplicateEmailSet(new Set(data.map((d) => d.email.toLowerCase())));
        setDuplicateFetched(true);
      }
    } catch { /* ignore */ }
    finally { setDuplicateLoading(false); }
  }

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
    if (!emails.length) return;
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

  function startBatchTaskPoll(emails: string[]) {
    if (batchPollRef.current) clearInterval(batchPollRef.current);
    setBatchEmailStatuses(emails.map(e => ({ email: e, status: 'PENDING' })));

    const poll = async () => {
      try {
        const res = await apiRequest<{ data: Array<{
          status: string;
          payload?: string;
          lastErrorMessage?: string | null;
        }>; total: number }>('tasks?type=INVITE_MEMBER&pageSize=50');
        if (!res?.data) return;
        const tasks = res.data;

        const emailSet = new Set(emails.map(e => e.toLowerCase()));
        const statusMap = new Map<string, { status: string; errorMessage?: string }>();

        for (const t of tasks) {
          try {
            const p = JSON.parse(t.payload ?? '{}');
            const userEmail = (p.userEmail ?? '').toLowerCase();
            if (emailSet.has(userEmail) && !statusMap.has(userEmail)) {
              statusMap.set(userEmail, {
                status: t.status,
                errorMessage: t.lastErrorMessage ?? undefined,
              });
            }
          } catch { /* skip */ }
        }

        setBatchEmailStatuses(prev =>
          prev.map(s => {
            const found = statusMap.get(s.email.toLowerCase());
            return found ? { ...s, ...found } : s;
          })
        );

        const allDone = emails.every(e => {
          const s = statusMap.get(e.toLowerCase());
          return s && ['SUCCESS', 'FAILED_FINAL', 'CANCELLED', 'MANUAL_REVIEW'].includes(s.status);
        });
        if (allDone && batchPollRef.current) {
          clearInterval(batchPollRef.current);
          batchPollRef.current = null;
        }
      } catch { /* ignore */ }
    };

    void poll();
    batchPollRef.current = setInterval(poll, 5000);
  }

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

  async function fetchGroupsByMember() {
    const q = searchEmail.trim();
    if (!q || q.length < 2) { setMemberGroups([]); setMemberSearchDone(false); return; }
    setMemberSearchLoading(true);
    try {
      const data = await apiRequest<any[]>(`family-groups?memberEmail=${encodeURIComponent(q)}`);
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

  const refreshGroupDetail = useCallback(async (gid: string) => {
    try {
      const detail = await apiRequest<GroupDetail>(`family-groups/${gid}`);
      setGroupDetail(detail);
    } catch { /* noop */ }
  }, []);

  function pollMemberTask(memberId: string, taskId: string, type: 'remove' | 'replace' | 'cancel-invite', groupId: string) {
    if (memberPollRefs.current[memberId]) { clearInterval(memberPollRefs.current[memberId]); }

    const labelMap: Record<string, Record<string, string>> = {
      remove: { PENDING: '移除排队中', QUEUED: '移除排队中', RUNNING: '移除执行中', SUCCESS: '已移除', FAILED: '移除失败' },
      replace: { PENDING: '替换排队中', QUEUED: '替换排队中', RUNNING: '替换执行中', SUCCESS: '替换完成', FAILED: '替换失败' },
      'cancel-invite': { PENDING: '取消邀请排队中', QUEUED: '取消邀请排队中', RUNNING: '取消邀请执行中', SUCCESS: '已取消邀请', FAILED: '取消邀请失败' },
    };
    const typeLabels = labelMap[type] ?? labelMap.remove;

    setMemberTaskMap(prev => ({ ...prev, [memberId]: { taskId, type, status: 'PENDING', message: typeLabels.PENDING } }));

    let pollCount = 0;
    const MAX_POLLS = 60;
    const statusLabels: Record<string, string> = {
      ...typeLabels,
      REPLACED_AND_INVITE_SENT: '已替换并发送邀请',
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

          if (expandedGroupIdRef.current === groupId) {
            refreshGroupDetail(groupId);
          }

          setTimeout(() => setMemberTaskMap(prev => {
            const next = { ...prev };
            if (next[memberId]?.taskId === taskId) delete next[memberId];
            return next;
          }), 10000);
        }
      } catch { /* ignore */ }
    }, 3000);
  }

  async function handleSync(groupId: string) {
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

      const { taskId } = result;
      setSyncStatus({ groupId, taskId, status: 'PENDING', message: '任务已入队' });

      let pollCount = 0;
      const MAX_POLLS = 60;

      syncPollRef.current = setInterval(async () => {
        pollCount++;
        if (pollCount > MAX_POLLS) {
          if (syncPollRef.current) { clearInterval(syncPollRef.current); syncPollRef.current = null; }
          setSyncingGroupId(null);
          setSyncStatus({ groupId, taskId, status: 'TIMEOUT', message: '轮询超时，请在任务面板查看' });
          showToast('error', '同步任务超时');
          setTimeout(() => setSyncStatus((prev) => prev?.taskId === taskId ? null : prev), 8000);
          return;
        }

        try {
          const task = await apiRequest<{ status: string; resultMessage?: string; lastErrorMessage?: string }>(`tasks/${taskId}`);
          const terminalStatuses = new Set(['SUCCESS', 'FAILED', 'MANUAL_REVIEW', 'CANCELLED', 'REPLACED_AND_INVITE_SENT']);
          const statusLabels: Record<string, string> = {
            PENDING: '排队中', QUEUED: '排队中', RUNNING: '同步执行中', SUCCESS: '同步完成', FAILED: '同步失败', MANUAL_REVIEW: '需人工处理', CANCELLED: '已取消',
          };

          setSyncStatus({ groupId, taskId, status: task.status, message: statusLabels[task.status] ?? task.status });

          if (terminalStatuses.has(task.status)) {
            if (syncPollRef.current) { clearInterval(syncPollRef.current); syncPollRef.current = null; }
            setSyncingGroupId(null);
            if (task.status === 'SUCCESS') showToast('success', '同步完成');
            else if (task.status === 'FAILED') showToast('error', task.lastErrorMessage ?? '同步失败');
            if (expandedGroupIdRef.current === groupId) refreshGroupDetail(groupId);
            setTimeout(() => setSyncStatus((prev) => prev?.taskId === taskId ? null : prev), 8000);
          }
        } catch { /* ignore */ }
      }, 3000);
    } catch {
      showToast('error', '同步异常');
      setSyncingGroupId(null);
    }
  }

  async function handleToggleAutoAssign(groupId: string) {
    setTogglingGroupId(groupId);
    try {
      const ok = await onToggleAutoAssign(groupId);
      if (ok) showToast('success', '自动分配已切换');
      else showToast('error', '切换失败');
    } catch {
      showToast('error', '请求异常');
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
    if (!duplicateFetched && !duplicateLoading) fetchDuplicateMembers();
    try {
      const detail = await apiRequest<GroupDetail>(`family-groups/${groupId}`);
      setGroupDetail(detail);
    } catch {
      setGroupDetail({ members: [], invites: [] });
    } finally {
      setIsLoadingDetail(false);
    }
  }

  async function submitCreateGroup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || !form.accountId) return;
    setIsSubmitting(true);
    try {
      const ok = await onCreate({ accountId: form.accountId, groupName: form.groupName, maxMembers: Number(form.maxMembers) });
      if (ok) {
        setForm({ accountId: form.accountId, groupName: "", maxMembers: "5" });
        setActiveTab("inventory");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  function switchBatchSubTab(tab: typeof batchSubTab) {
    setBatchSubTab(tab);
    setBatchResult(null);
    setBatchText("");
    setBatchEmailStatuses([]);
    if (batchPollRef.current) { clearInterval(batchPollRef.current); batchPollRef.current = null; }
    if (tab === "cross-invite" || tab === "cross-remove") setBatchGroupId("");
    if (tab !== "transfer" && transferPollRef.current) { clearInterval(transferPollRef.current); transferPollRef.current = null; }
  }

  // --- Effects ---

  useEffect(() => { expandedGroupIdRef.current = expandedGroupId; }, [expandedGroupId]);

  useEffect(() => {
    if (!form.accountId && accounts[0]?.id) {
      setForm(f => ({ ...f, accountId: accounts[0]!.id }));
    }
  }, [accounts, form.accountId]);

  useEffect(() => {
    if (!expandedGroupId) return;
    refreshGroupDetail(expandedGroupId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups]);

  useEffect(() => {
    return () => {
      if (syncPollRef.current) clearInterval(syncPollRef.current);
      if (batchPollRef.current) clearInterval(batchPollRef.current);
      if (transferPollRef.current) clearInterval(transferPollRef.current);
      // eslint-disable-next-line react-hooks/exhaustive-deps
      Object.values(memberPollRefs.current).forEach(clearInterval);
    };
  }, []);

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
          <button className={`panel-tab${activeTab === "inventory" ? " active" : ""}`} onClick={() => setActiveTab("inventory")} type="button">库存列表</button>
          <button className={`panel-tab${activeTab === "batch" ? " active" : ""}`} onClick={() => { setActiveTab("batch"); setBatchResult(null); }} type="button">批量操作</button>
          <button className={`panel-tab${activeTab === "create" ? " active" : ""}`} onClick={() => setActiveTab("create")} type="button">新增家庭组</button>
          <button className={`panel-tab${activeTab === "expiry" ? " active" : ""}`} onClick={() => { setActiveTab("expiry"); fetchExpiryMembers(1); }} type="button">到期管理</button>
        </div>

        {activeTab === "expiry" ? (
             <ExpiryTab
               expiryFilter={expiryFilter} setExpiryFilter={setExpiryFilter}
               expirySearch={expirySearch} setExpirySearch={setExpirySearch}
               expiryMembers={expiryMembers} expiryTotal={expiryTotal}
               expiryPage={expiryPage} expiryLoading={expiryLoading}
               expirySelected={expirySelected} setExpirySelected={setExpirySelected}
               expiryRemoving={expiryRemoving} expiryRemoveResult={expiryRemoveResult}
               fetchExpiryMembers={fetchExpiryMembers} handleBulkRemoveExpired={handleBulkRemoveExpired}
               pageSize={EXPIRY_PAGE_SIZE}
             />
          ) : activeTab === "batch" ? (
             <BatchTab
               batchSubTab={batchSubTab} switchBatchSubTab={switchBatchSubTab}
               groups={groups} batchValidDays={batchValidDays} setBatchValidDays={setBatchValidDays}
               batchGroupId={batchGroupId} setBatchGroupId={setBatchGroupId}
               batchText={batchText} setBatchText={setBatchText}
               batchLoading={batchLoading} setBatchLoading={setBatchLoading}
               batchResult={batchResult} setBatchResult={setBatchResult}
               batchEmailStatuses={batchEmailStatuses} batchPollActive={!!batchPollRef.current}
               transferSourceId={transferSourceId} setTransferSourceId={setTransferSourceId}
               transferTargetId={transferTargetId} setTransferTargetId={setTransferTargetId}
               transferEmails={transferEmails} setTransferEmails={setTransferEmails}
               transferLoading={transferLoading} transferStatus={transferStatus}
               submitTransfer={submitTransfer}
               onCrossInvite={onCrossInvite} onCrossRemove={onCrossRemove}
               onBulkInviteGroup={onBulkInviteGroup} onBulkRemoveGroup={onBulkRemoveGroup}
               startBatchTaskPoll={startBatchTaskPoll}
             />
          ) : activeTab === "create" ? (
             <CreateTab
               accounts={accounts} isSubmitting={isSubmitting}
               form={form} setForm={setForm} onSubmit={submitCreateGroup} canManage={canManage}
             />
          ) : (
            <InventoryTab
              searchMode={searchMode} setSearchMode={setSearchMode}
              searchEmail={searchEmail} setSearchEmail={setSearchEmail}
              filterStatus={filterStatus} setFilterStatus={setFilterStatus}
              filterExtra={filterExtra} setFilterExtra={setFilterExtra}
              currentGroupPage={currentGroupPage} setCurrentGroupPage={setCurrentGroupPage}
              groups={groups} memberGroups={memberGroups}
              memberSearchLoading={memberSearchLoading} memberSearchDone={memberSearchDone}
              duplicateMembers={duplicateMembers} duplicateEmailSet={duplicateEmailSet}
              duplicateLoading={duplicateLoading} duplicateFetched={duplicateFetched}
              fetchGroupsByMember={fetchGroupsByMember} fetchDuplicateMembers={fetchDuplicateMembers}
              expandedGroupId={expandedGroupId} toggleMembers={toggleMembers}
              isLoadingDetail={isLoadingDetail} groupDetail={groupDetail}
              canManage={canManage} syncingGroupId={syncingGroupId}
              handleSync={handleSync} syncStatus={syncStatus}
              togglingGroupId={togglingGroupId} handleToggleAutoAssign={handleToggleAutoAssign}
              onUpdateAccount={onUpdateAccount}
              editingDateGroupId={editingDateGroupId} setEditingDateGroupId={setEditingDateGroupId}
              editingDateValue={editingDateValue} setEditingDateValue={setEditingDateValue}
              isUpdatingDate={isUpdatingDate} setIsUpdatingDate={setIsUpdatingDate}
              removingMemberId={removingMemberId} setRemovingMemberId={setRemovingMemberId}
              replacingMemberId={replacingMemberId} setReplacingMemberId={setReplacingMemberId}
              replaceEmail={replaceEmail} setReplaceEmail={setReplaceEmail}
              onRemoveMember={onRemoveMember} onReplaceMember={onReplaceMember}
              onMigrateMember={onMigrateMember} migratingMemberId={migratingMemberId}
              setMigratingMemberId={setMigratingMemberId}
              memberTaskMap={memberTaskMap} pollMemberTask={pollMemberTask}
              refreshGroupDetail={refreshGroupDetail}
              editingMemberId={editingMemberId} setEditingMemberId={setEditingMemberId}
              editJoinedAt={editJoinedAt} setEditJoinedAt={setEditJoinedAt}
              editExpiresAt={editExpiresAt} setEditExpiresAt={setEditExpiresAt}
              savingMemberDates={savingMemberDates} handleSaveMemberDates={handleSaveMemberDates}
              showToast={showToast}
              pageSize={20}
            />
          )}
      </div>
    </section>
  );
}
