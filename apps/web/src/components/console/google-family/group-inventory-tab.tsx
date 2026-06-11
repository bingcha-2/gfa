"use client";

import React, { Fragment, useState, useEffect } from "react";
import { ConfirmButton } from "./confirm-button";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "./status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { 
  formatDate, 
  timeAgo, 
  GroupDetail, 
  DuplicateMemberInfo 
} from "./group-panel-types";
import type { FamilyGroupSummary } from "@/lib/console/types";
import type { MigrateResult } from "./console-app";
import { MemberTimeline } from "./member-timeline";

type InventoryTabProps = {
  searchMode: "parent" | "member";
  setSearchMode: (mode: "parent" | "member") => void;
  searchEmail: string;
  setSearchEmail: (email: string) => void;
  filterStatus: string;
  setFilterStatus: (status: string) => void;
  filterExtra: string;
  setFilterExtra: (extra: string) => void;
  currentGroupPage: number;
  setCurrentGroupPage: React.Dispatch<React.SetStateAction<number>>;
  groups: FamilyGroupSummary[];
  memberGroups: FamilyGroupSummary[];
  memberSearchLoading: boolean;
  memberSearchDone: boolean;
  duplicateMembers: DuplicateMemberInfo[];
  duplicateEmailSet: Set<string>;
  duplicateLoading: boolean;
  duplicateFetched: boolean;
  fetchGroupsByMember: () => Promise<void>;
  fetchDuplicateMembers: () => Promise<void>;
  expandedGroupId: string | null;
  toggleMembers: (groupId: string) => Promise<void>;
  isLoadingDetail: boolean;
  groupDetail: GroupDetail | null;
  canManage: boolean;
  syncingGroupId: string | null;
  handleSync: (groupId: string) => Promise<void>;
  syncStatus: { groupId: string; taskId: string; status: string; message: string } | null;
  togglingGroupId: string | null;
  handleToggleAutoAssign: (groupId: string) => Promise<void>;
  onUpdateAccount?: (accountId: string, payload: Record<string, string | undefined>) => Promise<boolean>;
  editingDateGroupId: string | null;
  setEditingDateGroupId: (id: string | null) => void;
  editingDateValue: string;
  setEditingDateValue: (val: string) => void;
  isUpdatingDate: boolean;
  setIsUpdatingDate: (val: boolean) => void;
  removingMemberId: string | null;
  setRemovingMemberId: (id: string | null) => void;
  replacingMemberId: string | null;
  setReplacingMemberId: (id: string | null) => void;
  replaceEmail: string;
  setReplaceEmail: (email: string) => void;
  onRemoveMember: (groupId: string, memberEmail: string) => Promise<{ taskId: string } | null>;
  onReplaceMember: (groupId: string, targetEmail: string, newEmail: string) => Promise<{ taskId: string } | null>;
  onMigrateMember?: (groupId: string, memberEmail: string) => Promise<MigrateResult | null>;
  migratingMemberId: string | null;
  setMigratingMemberId: (id: string | null) => void;
  memberTaskMap: Record<string, { taskId: string; type: string; status: string; message: string }>;
  pollMemberTask: (memberId: string, taskId: string, type: 'remove' | 'replace' | 'cancel-invite', groupId: string) => void;
  refreshGroupDetail: (gid: string) => Promise<void>;
  editingMemberId: string | null;
  setEditingMemberId: (id: string | null) => void;
  editJoinedAt: string;
  setEditJoinedAt: (val: string) => void;
  editExpiresAt: string;
  setEditExpiresAt: (val: string) => void;
  savingMemberDates: boolean;
  handleSaveMemberDates: (memberId: string, groupId: string) => Promise<void>;
  showToast: (type: 'success' | 'error', msg: string) => void;
  pageSize: number;
};

export function InventoryTab({
  searchMode,
  setSearchMode,
  searchEmail,
  setSearchEmail,
  filterStatus,
  setFilterStatus,
  filterExtra,
  setFilterExtra,
  currentGroupPage,
  setCurrentGroupPage,
  groups,
  memberGroups,
  memberSearchLoading,
  memberSearchDone,
  duplicateMembers,
  duplicateEmailSet,
  duplicateLoading,
  duplicateFetched,
  fetchGroupsByMember,
  fetchDuplicateMembers,
  expandedGroupId,
  toggleMembers,
  isLoadingDetail,
  groupDetail,
  canManage,
  syncingGroupId,
  handleSync,
  syncStatus,
  togglingGroupId,
  handleToggleAutoAssign,
  onUpdateAccount,
  editingDateGroupId,
  setEditingDateGroupId,
  editingDateValue,
  setEditingDateValue,
  isUpdatingDate,
  setIsUpdatingDate,
  removingMemberId,
  setRemovingMemberId,
  replacingMemberId,
  setReplacingMemberId,
  replaceEmail,
  setReplaceEmail,
  onRemoveMember,
  onReplaceMember,
  onMigrateMember,
  migratingMemberId,
  setMigratingMemberId,
  memberTaskMap,
  pollMemberTask,
  refreshGroupDetail,
  editingMemberId,
  setEditingMemberId,
  editJoinedAt,
  setEditJoinedAt,
  editExpiresAt,
  setEditExpiresAt,
  savingMemberDates,
  handleSaveMemberDates,
  showToast,
  pageSize
}: InventoryTabProps) {
  const [selectedMembers, setSelectedMembers] = useState<Set<string>>(new Set());

  // Clear selection when switching groups
  useEffect(() => { setSelectedMembers(new Set()); }, [expandedGroupId]);

  return (
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
            onClick={() => { setSearchMode("parent"); setSearchEmail(""); setCurrentGroupPage(1); }}
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
            onClick={() => { setSearchMode("member"); setSearchEmail(""); setCurrentGroupPage(1); }}
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
          <Input
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
            style={{ paddingLeft: 34 }}
          />
        </div>
        {searchMode === "member" && (
          <Button
            size="sm"
            type="button"
            onClick={() => fetchGroupsByMember()}
            disabled={memberSearchLoading || searchEmail.trim().length < 2}
          >
            {memberSearchLoading ? '…' : '查询'}
          </Button>
        )}
        {searchMode === "parent" && (<>
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
          <select
            id="group-filter-extra"
            value={filterExtra}
            onChange={(e) => {
              const v = e.target.value;
              setFilterExtra(v);
              setCurrentGroupPage(1);
              if (v === 'HAS_DUPLICATES' && !duplicateFetched) fetchDuplicateMembers();
            }}
            style={{ flex: '0 0 auto', minWidth: 120, height: '36px', borderRadius: '8px', border: '1px solid var(--border, #e5e5e5)', fontSize: '0.875rem' }}
          >
            <option value="ALL">全部筛选</option>
            <option value="HAS_PENDING">⏳ 有待接受</option>
            <option value="HAS_SLOTS">🟢 有空位</option>
            <option value="FULL">🔴 满员</option>
            <option value="NEVER_SYNCED">⚠️ 未同步</option>
            <option value="HAS_DUPLICATES">🔁 重复成员</option>
            <option value="PASSWORD_ERROR">🔴 密码错误</option>
            <option value="CAPTCHA_REQUIRED">🤖 人机验证</option>
            <option value="INVITE_COOLDOWN">🚫 邀请受限</option>
            <option value="ACCT_RISKY">🔶 风控母号</option>
            <option value="SUBSCRIPTION_SUSPENDED">⚠️ 订阅暂停</option>
          </select>
        </>)}
        {(searchEmail || filterStatus !== 'ALL' || filterExtra !== 'ALL') && (
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => { setSearchEmail(''); setFilterStatus('ALL'); setFilterExtra('ALL'); setCurrentGroupPage(1); }}
          >
            清除
          </Button>
        )}
      </div>

      {/* ----- Unified group table (both 母号 and 子号 modes) ----- */}
      {(() => {
        if (searchMode === "member") {
          if (memberSearchLoading) return <div style={{ padding: '24px', textAlign: 'center' }}><Spinner size={20} /> 搜索中...</div>;
          if (!memberSearchDone) return <div className="muted" style={{ padding: '24px', textAlign: 'center', fontSize: '0.875rem' }}>输入子号邮箱后点击查询</div>;
        }

        const source = searchMode === "member" ? memberGroups : groups;
        const q = searchEmail.trim().toLowerCase();
        const filtered = searchMode === "parent"
          ? source.filter((g) => {
              const matchEmail = !q || (g.account?.loginEmail ?? '').toLowerCase().includes(q);
              const matchStatus = filterStatus === 'ALL' || g.status === filterStatus;
              let matchExtra = true;
              if (filterExtra === 'HAS_PENDING') matchExtra = (g.pendingMemberCount ?? 0) > 0;
              else if (filterExtra === 'HAS_SLOTS') matchExtra = g.availableSlots > 0;
              else if (filterExtra === 'FULL') matchExtra = g.availableSlots === 0;
              else if (filterExtra === 'NEVER_SYNCED') matchExtra = !g.lastSyncedAt;
              else if (filterExtra === 'HAS_DUPLICATES') {
                matchExtra = duplicateMembers.some((d) =>
                  d.groups.some((dg) => dg.groupId === g.id)
                );
              }
              else if (filterExtra === 'PASSWORD_ERROR') matchExtra = g.account?.syncError === 'PASSWORD_ERROR';
              else if (filterExtra === 'CAPTCHA_REQUIRED') matchExtra = g.account?.syncError === 'CAPTCHA_REQUIRED';
              else if (filterExtra === 'INVITE_COOLDOWN') matchExtra = g.account?.syncError === 'INVITE_COOLDOWN';
              else if (filterExtra === 'ACCT_RISKY') matchExtra = g.account?.status === 'RISKY';
              else if (filterExtra === 'SUBSCRIPTION_SUSPENDED') matchExtra = g.account?.subscriptionStatus === 'SUSPENDED' || g.account?.syncError === 'SUBSCRIPTION_SUSPENDED';
              return matchEmail && matchStatus && matchExtra;
            })
          : source;
        const totalGroupPages = Math.ceil(filtered.length / pageSize);
        const displayed = filtered.slice((currentGroupPage - 1) * pageSize, currentGroupPage * pageSize);

        return (
          <>
            {/* Stats bar */}
            <div style={{ fontSize: '0.875rem', color: 'var(--foreground-muted, #737373)', marginBottom: '6px' }}>
              {searchMode === "member"
                ? `找到 ${filtered.length} 个家庭组`
                : `共 ${groups.length} 组${filtered.length < groups.length ? ` · 筛选 ${filtered.length} 条` : ''}`}
              {totalGroupPages > 0 && ` · 第 ${currentGroupPage}/${totalGroupPages} 页`}
            </div>

            {/* Member timeline (shown when searching by member email) */}
            {searchMode === "member" && memberSearchDone && searchEmail.trim() && (
              <MemberTimeline email={searchEmail.trim()} autoLoad />
            )}

            {filterExtra === 'HAS_DUPLICATES' && (
              <div style={{
                padding: '8px 14px',
                marginBottom: '8px',
                borderRadius: '8px',
                background: 'rgba(251,191,36,0.08)',
                border: '1px solid rgba(251,191,36,0.2)',
                fontSize: '0.875rem',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                flexWrap: 'wrap',
              }}>
                {duplicateLoading ? (
                  <><Spinner size={14} /> 正在检测重复成员...</>
                ) : duplicateMembers.length === 0 ? (
                  <span style={{ color: '#059669' }}>✅ 未发现重复成员</span>
                ) : (
                  <>
                    <span style={{ fontWeight: 600, color: '#92400e' }}>
                      🔁 发现 {duplicateMembers.length} 个邮箱出现在多个组中
                    </span>
                    <span className="muted" style={{ fontSize: '0.8rem' }}>
                      ({duplicateMembers.map(d => d.email).join(', ')})
                    </span>
                  </>
                )}
              </div>
            )}

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
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span className="strong">{group.groupName}</span>
                          </div>
                          <div className="muted">
                            {group.memberCount ?? group._count?.members ?? 0} members ·{" "}
                            {group.pendingMemberCount ?? 0} 待接受
                          </div>
                        </td>
                        <td>
                          <div>{group.availableSlots} slots left</div>
                          <div className="muted">risk {group.riskScore}</div>
                        </td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <StatusBadge value={group.status} />
                            {(() => {
                              const syncErr = group.account?.syncError;
                              if (syncErr === 'PASSWORD_ERROR') {
                                return <span style={{ background: 'rgba(239,68,68,0.12)', color: '#dc2626', fontSize: '0.7rem', fontWeight: 600, padding: '1px 6px', borderRadius: '4px' }} title="密码错误或验证阻断">⚠️ 密码错误</span>;
                              }
                              if (syncErr === 'CAPTCHA_REQUIRED') {
                                return <span style={{ background: 'rgba(245,158,11,0.12)', color: '#d97706', fontSize: '0.7rem', fontWeight: 600, padding: '1px 6px', borderRadius: '4px' }} title="需要处理人机验证 (CAPTCHA)">⚠️ 人机验证</span>;
                              }
                              if (syncErr === 'INVITE_COOLDOWN') {
                                return <span style={{ background: 'rgba(239,68,68,0.12)', color: '#dc2626', fontSize: '0.7rem', fontWeight: 600, padding: '1px 6px', borderRadius: '4px' }} title="该母号邀请频率受限，24小时后自动解除">🚫 邀请受限</span>;
                              }
                              if (syncErr === 'SUBSCRIPTION_SUSPENDED' || group.account?.subscriptionStatus === 'SUSPENDED') {
                                return <span style={{ background: 'rgba(239,68,68,0.12)', color: '#dc2626', fontSize: '0.7rem', fontWeight: 600, padding: '1px 6px', borderRadius: '4px' }} title="订阅已暂停">⚠️ 订阅暂停</span>;
                              }
                              if (syncErr && syncErr.trim() !== '') {
                                return <span style={{ background: 'rgba(239,68,68,0.12)', color: '#dc2626', fontSize: '0.7rem', fontWeight: 600, padding: '1px 6px', borderRadius: '4px' }} title="其它异常">⚠️ {syncErr}</span>;
                              }
                              if (!group.lastSyncedAt) {
                                return <span style={{ background: 'rgba(239,68,68,0.12)', color: '#dc2626', fontSize: '0.7rem', fontWeight: 600, padding: '1px 6px', borderRadius: '4px' }} title="该组尚未同步">⚠️ 未同步</span>;
                              }
                              return null;
                            })()}
                          </div>
                          {group.lastSyncedAt && (
                            <div className="muted" style={{ fontSize: '0.75rem', marginTop: '2px' }}
                              title={new Date(group.lastSyncedAt).toLocaleString('zh-CN')}
                            >
                              🔄 {timeAgo(group.lastSyncedAt)}
                            </div>
                          )}
                        </td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <div>{group.account?.name ?? "-"}</div>
                            {(group.pendingMemberCount ?? 0) > 0 && (
                              <span style={{
                                fontSize: '0.7rem',
                                fontWeight: 600,
                                padding: '1px 6px',
                                borderRadius: '4px',
                                background: 'rgba(245,158,11,0.12)',
                                color: '#d97706',
                                whiteSpace: 'nowrap',
                              }}
                                title={`${group.pendingMemberCount} 个成员同步后待接受`}
                              >
                                ⏳ {group.pendingMemberCount}待接受
                              </span>
                            )}
                          </div>
                          {group.account?.loginEmail && (
                            <div className="muted" style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                              {group.account.loginEmail}
                            </div>
                          )}
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
                            {group.account?.subscriptionStatus === 'SUSPENDED' && group.account.subscriptionStatusUpdatedAt && (
                              <span className="muted" style={{ fontSize: '0.75rem', display: 'flex', alignItems: 'center', marginLeft: '4px' }}>
                                (暂停于 {formatDate(group.account.subscriptionStatusUpdatedAt)})
                              </span>
                            )}
                            {(group.account as any)?.notes && (
                              <div className="muted" style={{ width: '100%', fontSize: '0.75rem', marginTop: '2px', backgroundColor: 'var(--surface-2, #f5f5f4)', padding: '2px 6px', borderRadius: '4px', display: 'inline-block' }}>
                                备注: {(group.account as any).notes}
                              </div>
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
                                      编辑
                                    </button>
                                  )}
                                </>
                              )}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                            <Button variant="outline" size="sm" onClick={() => void toggleMembers(group.id)} type="button">
                              {expandedGroupId === group.id ? "收起" : "查看成员"}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={syncingGroupId === group.id}
                              onClick={() => void handleSync(group.id)}
                              type="button"
                            >
                              {syncingGroupId === group.id ? <><Spinner size={12} color="currentColor" /> 同步中...</> : '同步'}
                            </Button>
                            {syncStatus?.groupId === group.id && (
                              <span style={{
                                fontSize: '0.8rem',
                                fontWeight: 500,
                                padding: '2px 8px',
                                borderRadius: '4px',
                                whiteSpace: 'nowrap',
                                background: syncStatus.status === 'SUCCESS' ? 'rgba(16,185,129,0.12)' : syncStatus.status === 'FAILED' || syncStatus.status === 'MANUAL_REVIEW' ? 'rgba(239,68,68,0.12)' : 'rgba(59,130,246,0.12)',
                                color: syncStatus.status === 'SUCCESS' ? '#059669' : syncStatus.status === 'FAILED' || syncStatus.status === 'MANUAL_REVIEW' ? '#dc2626' : '#2563eb',
                              }}>
                                {syncStatus.status === 'RUNNING' && <Spinner size={10} color="currentColor" />}
                                {' '}{syncStatus.message}
                              </span>
                            )}
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={togglingGroupId === group.id || group.status === 'DISABLED'}
                              onClick={() => void handleToggleAutoAssign(group.id)}
                              type="button"
                              style={{
                                color: group.status === 'ACTIVE' ? '#059669' : group.status === 'MANUAL_ONLY' ? '#92400e' : undefined,
                                borderColor: group.status === 'ACTIVE' ? '#059669' : group.status === 'MANUAL_ONLY' ? '#d97706' : undefined,
                                opacity: group.status === 'DISABLED' ? 0.5 : 1
                              }}
                            >
                              {togglingGroupId === group.id ? <Spinner size={12} color="currentColor" /> : group.status === 'ACTIVE' ? '🟢 自动 ON' : group.status === 'MANUAL_ONLY' ? '⏸ 自动 OFF' : '🚫 已停用'}
                            </Button>
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
                                  <div style={{ marginBottom: '12px' }}>
                                    <div style={{ fontWeight: 600, fontSize: '0.875rem', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                                      <span>成员列表 ({groupDetail?.members?.length ?? 0})</span>
                                      {selectedMembers.size > 0 && (
                                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem', fontWeight: 500 }}>
                                          <span className="muted">已选 <strong>{selectedMembers.size}</strong> 个</span>
                                          <Button
                                            variant="outline"
                                            size="sm"
                                            type="button"
                                            onClick={() => {
                                              const emails = (groupDetail?.members ?? []).filter(m => selectedMembers.has(m.id)).map(m => m.email);
                                              navigator.clipboard.writeText(emails.join('\n'));
                                              showToast('success', `已复制 ${emails.length} 个邮箱`);
                                            }}
                                          >
                                            📋 复制邮箱
                                          </Button>
                                          <Button
                                            variant="outline"
                                            size="sm"
                                            type="button"
                                            onClick={() => setSelectedMembers(new Set())}
                                          >
                                            取消选择
                                          </Button>
                                        </span>
                                      )}
                                    </div>
                                    {groupDetail?.members?.length ? (
                                      <table className="data-table" style={{ fontSize: '0.875rem' }}>
                                        <thead>
                                          <tr>
                                            <th style={{ width: 32 }}>
                                              <input
                                                type="checkbox"
                                                checked={selectedMembers.size === (groupDetail?.members?.length ?? 0) && (groupDetail?.members?.length ?? 0) > 0}
                                                onChange={() => {
                                                  if (selectedMembers.size === (groupDetail?.members?.length ?? 0)) {
                                                    setSelectedMembers(new Set());
                                                  } else {
                                                    setSelectedMembers(new Set((groupDetail?.members ?? []).map(m => m.id)));
                                                  }
                                                }}
                                                style={{ accentColor: 'var(--accent, #2563eb)', cursor: 'pointer' }}
                                              />
                                            </th>
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
                                            const isDuplicate = duplicateEmailSet.has(m.email.toLowerCase());
                                            const dupInfo = isDuplicate ? duplicateMembers.find((d) => d.email === m.email.toLowerCase()) : null;
                                            return (
                                              <Fragment key={m.id}>
                                                <tr style={isOwner ? { background: 'rgba(56,189,248,0.06)' } : isDuplicate ? { background: 'rgba(251,191,36,0.08)' } : selectedMembers.has(m.id) ? { background: 'rgba(37,99,235,0.06)' } : undefined}>
                                                  <td>
                                                    <input
                                                      type="checkbox"
                                                      checked={selectedMembers.has(m.id)}
                                                      onChange={() => {
                                                        setSelectedMembers(prev => {
                                                          const next = new Set(prev);
                                                          if (next.has(m.id)) next.delete(m.id);
                                                          else next.add(m.id);
                                                          return next;
                                                        });
                                                      }}
                                                      style={{ accentColor: 'var(--accent, #2563eb)', cursor: 'pointer' }}
                                                    />
                                                  </td>
                                                  <td style={{ fontFamily: 'monospace' }}>
                                                    {m.email}
                                                    {isOwner && (
                                                      <span style={{ marginLeft: '6px', fontSize: '0.75rem', padding: '1px 6px', borderRadius: '4px', background: 'rgba(56,189,248,0.15)', color: '#0284c7', fontWeight: 600, fontFamily: 'inherit' }}>👑 母号</span>
                                                    )}
                                                    {isDuplicate && (
                                                      <span title={dupInfo ? `出现在 ${dupInfo.count} 个组: ${dupInfo.groups.map(g => g.groupName).join(', ')}` : '重复成员'} style={{ marginLeft: '6px', fontSize: '0.7rem', padding: '1px 6px', borderRadius: '4px', background: 'rgba(251,191,36,0.18)', color: '#92400e', fontWeight: 600, fontFamily: 'inherit', cursor: 'help' }}>🔁 {dupInfo?.count ?? '?'}组</span>
                                                    )}
                                                    <span title={m.googleMemberId ? `GaiaID: ${m.googleMemberId}` : '未同步 GaiaID'} style={{ marginLeft: '4px', fontSize: '0.7rem', cursor: 'help', opacity: m.googleMemberId ? 0.6 : 0.4 }}>{m.googleMemberId ? '🔗' : '⚠️'}</span>
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
                                                        style={{ marginLeft: '6px', fontSize: '0.7rem', padding: '2px 8px', borderRadius: '4px', border: '1px solid var(--border, #e5e5e5)', background: 'var(--surface-2, #fafaf9)', color: 'var(--foreground-muted, #737373)', cursor: 'pointer', transition: 'all 0.15s', verticalAlign: 'middle' }}
                                                      >
                                                        编辑
                                                      </button>
                                                    )}
                                                  </td>
                                                  {canManage && (
                                                    <td>
                                                      {!isOwner && (
                                                        <>
                                                          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' }}>
                                                            {m.status === 'PENDING' ? (
                                                              <ConfirmButton
                                                                className="button small"
                                                                style={{ background: 'rgba(249,115,22,0.12)', color: '#f97316', border: '1px solid rgba(249,115,22,0.2)' }}
                                                                disabled={removingMemberId === m.id || !!memberTaskMap[m.id]}
                                                                confirmLabel="确定取消？"
                                                                loadingLabel="提交中..."
                                                                onConfirm={async () => {
                                                                  setRemovingMemberId(m.id);
                                                                  try {
                                                                    const result = await onRemoveMember(group.id, m.email);
                                                                    if (result?.taskId) {
                                                                      pollMemberTask(m.id, result.taskId, 'cancel-invite', group.id);
                                                                    }
                                                                  } finally {
                                                                    setRemovingMemberId(null);
                                                                  }
                                                                }}
                                                              >
                                                                取消邀请
                                                              </ConfirmButton>
                                                            ) : (
                                                              <ConfirmButton
                                                                className="button danger small"
                                                                disabled={removingMemberId === m.id || replacingMemberId !== null || migratingMemberId !== null || !!memberTaskMap[m.id]}
                                                                confirmLabel={(() => {
                                                                  if (m.expiresAt && new Date(m.expiresAt) > new Date()) {
                                                                    const days = Math.ceil((new Date(m.expiresAt).getTime() - Date.now()) / 86400000);
                                                                    return `⚠️ 该成员还有 ${days} 天到期！确定移除 ${m.email}？`;
                                                                  }
                                                                  return `确定移除 ${m.email}？`;
                                                                })()}
                                                                confirmStyle={m.expiresAt && new Date(m.expiresAt) > new Date() ? {
                                                                  background: '#dc2626', color: '#fff', fontWeight: 700, border: '2px solid #b91c1c',
                                                                  animation: 'pulse 1.5s infinite',
                                                                } : undefined}
                                                                loadingLabel="提交中..."
                                                                onConfirm={async () => {
                                                                  if (m.expiresAt && new Date(m.expiresAt) > new Date()) {
                                                                    const days = Math.ceil((new Date(m.expiresAt).getTime() - Date.now()) / 86400000);
                                                                    if (!window.confirm(`⚠️ 严重警告！\n\n该成员 ${m.email} 的权益还有 ${days} 天才到期 (${new Date(m.expiresAt).toLocaleDateString('zh-CN')})!\n\n移除后用户将无法使用 Ultra 权益。确定要移除吗？`)) {
                                                                      return;
                                                                    }
                                                                  }
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
                                                              >
                                                                移除
                                                              </ConfirmButton>
                                                            )}
                                                            <Button
                                                              variant="outline"
                                                              size="sm"
                                                              disabled={removingMemberId !== null || (replacingMemberId !== null && replacingMemberId !== m.id) || !!memberTaskMap[m.id]}
                                                              onClick={() => { setReplacingMemberId(replacingMemberId === m.id ? null : m.id); setReplaceEmail(''); }}
                                                              type="button"
                                                            >
                                                              替换
                                                            </Button>
                                                            {onMigrateMember && (
                                                              <ConfirmButton
                                                                className="button small"
                                                                style={{ background: 'rgba(139,92,246,0.15)', color: '#7c3aed', border: '1px solid rgba(139,92,246,0.3)', borderRadius: '4px', cursor: 'pointer', whiteSpace: 'nowrap' }}
                                                                disabled={migratingMemberId === m.id || removingMemberId !== null || replacingMemberId !== null || !!memberTaskMap[m.id]}
                                                                confirmLabel={`确定迁移 ${m.email}？将从当前组移除并邀请到新组`}
                                                                loadingLabel={<><Spinner size={12} color="currentColor" /> 迁移中</>}
                                                                onConfirm={async () => {
                                                                  setMigratingMemberId(m.id);
                                                                  try {
                                                                    const result = await onMigrateMember(group.id, m.email);
                                                                    if (result) {
                                                                      if (result.inviteResult?.taskId) {
                                                                        showToast('success', `已从 ${result.removedFromGroupName} 移除，邀请任务已发送至 ${result.inviteResult.targetGroupName}`);
                                                                        pollMemberTask(m.id, result.inviteResult.taskId, 'remove', group.id);
                                                                      }
                                                                      refreshGroupDetail(group.id);
                                                                    }
                                                                  } finally {
                                                                    setMigratingMemberId(null);
                                                                  }
                                                                }}
                                                              >
                                                                🔀 迁移
                                                              </ConfirmButton>
                                                            )}
                                                            {memberTaskMap[m.id] && (() => {
                                                              const ts = memberTaskMap[m.id];
                                                              const isOk = ts.status === 'SUCCESS' || ts.status === 'REPLACED_AND_INVITE_SENT';
                                                              const isFail = ts.status === 'FAILED' || ts.status === 'MANUAL_REVIEW' || ts.status === 'TIMEOUT';
                                                              return (
                                                                <span style={{ fontSize: '0.78rem', fontWeight: 500, padding: '2px 8px', borderRadius: '4px', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: '4px', background: isOk ? 'rgba(16,185,129,0.12)' : isFail ? 'rgba(239,68,68,0.12)' : 'rgba(59,130,246,0.12)', color: isOk ? '#059669' : isFail ? '#dc2626' : '#2563eb' }}>
                                                                  {ts.status === 'RUNNING' && <Spinner size={10} color="currentColor" />}
                                                                  {ts.message}
                                                                </span>
                                                              );
                                                            })()}
                                                          </div>
                                                          {replacingMemberId === m.id && (
                                                            <div style={{ display: 'flex', gap: '4px', alignItems: 'center', marginTop: '4px' }}>
                                                              <Input type="email" placeholder="新邮箱" value={replaceEmail} onChange={(e) => setReplaceEmail(e.target.value)} style={{ fontSize: '0.8rem', padding: '3px 6px', width: '180px' }} autoFocus />
                                                              <ConfirmButton className="button" style={{ fontSize: '0.75rem', padding: '3px 8px', background: 'rgba(139,92,246,0.2)', color: '#a78bfa', border: '1px solid rgba(139,92,246,0.4)', borderRadius: '4px', cursor: 'pointer' }} disabled={!replaceEmail.trim() || removingMemberId !== null}
                                                                confirmLabel={`确定将 ${m.email} 替换为 ${replaceEmail.trim() || '...'}？`}
                                                                loadingLabel="提交中..."
                                                                onConfirm={async () => {
                                                                  const newE = replaceEmail.trim().toLowerCase();
                                                                  if (!newE) return;
                                                                  if (m.expiresAt && new Date(m.expiresAt) > new Date()) {
                                                                    const days = Math.ceil((new Date(m.expiresAt).getTime() - Date.now()) / 86400000);
                                                                    if (!window.confirm(`该成员 ${m.email} 权益还有 ${days} 天到期。\n替换后 ${newE} 将继承该到期时间。\n\n确定替换？`)) {
                                                                      return;
                                                                    }
                                                                  }
                                                                  setRemovingMemberId(m.id);
                                                                  try {
                                                                    const result = await onReplaceMember(group.id, m.email, newE);
                                                                    setReplacingMemberId(null); setReplaceEmail('');
                                                                    if (result?.taskId) pollMemberTask(m.id, result.taskId, 'replace', group.id);
                                                                  } finally { setRemovingMemberId(null); }
                                                                }}
                                                              >确认</ConfirmButton>
                                                              <Button variant="outline" size="sm" onClick={() => { setReplacingMemberId(null); setReplaceEmail(''); }} type="button">取消</Button>
                                                            </div>
                                                          )}
                                                        </>
                                                      )}
                                                    </td>
                                                  )}
                                                </tr>
                                                {editingMemberId === m.id && (
                                                  <tr style={{ background: 'rgba(37,99,235,0.04)' }}>
                                                    <td colSpan={canManage ? 8 : 7} style={{ padding: '10px 16px' }}>
                                                      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap', fontSize: '0.8rem' }}>
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                          <label style={{ fontWeight: 600, color: 'var(--foreground-muted, #737373)', whiteSpace: 'nowrap' }}>加入时间</label>
                                                          <Input type="datetime-local" value={editJoinedAt} onChange={e => setEditJoinedAt(e.target.value)} style={{ fontSize: '0.8rem', height: '32px' }} />
                                                        </div>
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                          <label style={{ fontWeight: 600, color: 'var(--foreground-muted, #737373)', whiteSpace: 'nowrap' }}>到期时间</label>
                                                          <Input type="datetime-local" value={editExpiresAt} onChange={e => setEditExpiresAt(e.target.value)} style={{ fontSize: '0.8rem', height: '32px' }} />
                                                        </div>
                                                        <div style={{ display: 'flex', gap: '6px', marginLeft: 'auto' }}>
                                                          <Button size="sm" type="button" disabled={savingMemberDates} onClick={() => handleSaveMemberDates(m.id, group.id)}>{savingMemberDates ? '保存中...' : '保存'}</Button>
                                                          <Button variant="outline" size="sm" type="button" onClick={() => setEditingMemberId(null)}>取消</Button>
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
                        {searchEmail || filterStatus !== 'ALL' || filterExtra !== 'ALL'
                          ? `没有符合条件的家庭组。`
                          : '还没有家庭组库存。'}
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            {totalGroupPages > 1 && (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '4px', padding: '12px 0 4px', flexWrap: 'wrap' }}>
                <Button variant="outline" size="sm" disabled={currentGroupPage <= 1} onClick={() => setCurrentGroupPage(p => Math.max(1, p - 1))} type="button">← 上页</Button>
                {(() => {
                  const pages: (number | string)[] = [];
                  const delta = 2;
                  for (let i = 1; i <= totalGroupPages; i++) {
                    if (i === 1 || i === totalGroupPages || (i >= currentGroupPage - delta && i <= currentGroupPage + delta)) {
                      pages.push(i);
                    } else if (pages.length > 0 && pages[pages.length - 1] !== '...') {
                      pages.push('...');
                    }
                  }
                  return pages.map((p, idx) =>
                    p === '...' ? (
                      <span key={`ellipsis-${idx}`} style={{ padding: '0 4px', color: 'var(--foreground-muted, #a3a3a3)', fontSize: '0.85rem' }}>…</span>
                    ) : (
                      <Button
                        key={p}
                        variant={p === currentGroupPage ? "default" : "outline"}
                        size="sm"
                        onClick={() => setCurrentGroupPage(p as number)}
                        type="button"
                        style={{ minWidth: 32 }}
                      >
                        {p}
                      </Button>
                    )
                  );
                })()}
                <Button variant="outline" size="sm" disabled={currentGroupPage >= totalGroupPages} onClick={() => setCurrentGroupPage(p => Math.min(totalGroupPages, p + 1))} type="button">下页 →</Button>
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
}
