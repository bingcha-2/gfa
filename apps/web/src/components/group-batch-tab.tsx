"use client";

import React from "react";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "./status-badge";
import { SearchableSelect } from "./searchable-select";
import {
  BatchInviteResultTable,
  BatchResultTable,
  parseEmails
} from "./group-panel-types";
import type { FamilyGroupSummary } from "../lib/types";
import type {
  BulkGroupInviteResult,
  BulkGroupRemoveResult,
  CrossInviteResult,
  CrossRemoveResult,
  TransferBatchResult,
  TransferStatusResult
} from "./console-app";

type BatchTabProps = {
  batchSubTab: "cross-invite" | "cross-remove" | "group-invite" | "group-remove" | "transfer";
  switchBatchSubTab: (tab: "cross-invite" | "cross-remove" | "group-invite" | "group-remove" | "transfer") => void;
  groups: FamilyGroupSummary[];
  batchValidDays: number;
  setBatchValidDays: (days: number) => void;
  batchGroupId: string;
  setBatchGroupId: (id: string) => void;
  batchText: string;
  setBatchText: (text: string) => void;
  batchLoading: boolean;
  batchResult: CrossInviteResult | CrossRemoveResult | BulkGroupInviteResult | BulkGroupRemoveResult | null;
  setBatchResult: (res: any) => void;
  batchEmailStatuses: Array<{ email: string; status: string; errorMessage?: string }>;
  batchPollActive: boolean;
  transferSourceId: string;
  setTransferSourceId: (id: string) => void;
  transferTargetId: string;
  setTransferTargetId: (id: string) => void;
  transferEmails: string;
  setTransferEmails: (emails: string) => void;
  transferLoading: boolean;
  transferStatus: TransferStatusResult | null;
  submitTransfer: () => Promise<void>;
  onCrossInvite: (emails: string[], validDays?: number) => Promise<CrossInviteResult | null>;
  onCrossRemove: (memberEmails: string[]) => Promise<CrossRemoveResult | null>;
  onBulkInviteGroup: (groupId: string, emails: string[], validDays?: number) => Promise<BulkGroupInviteResult | null>;
  onBulkRemoveGroup: (groupId: string, memberEmails: string[]) => Promise<BulkGroupRemoveResult | null>;
  startBatchTaskPoll: (emails: string[]) => void;
  setBatchLoading: (loading: boolean) => void;
};

export function BatchTab({
  batchSubTab,
  switchBatchSubTab,
  groups,
  batchValidDays,
  setBatchValidDays,
  batchGroupId,
  setBatchGroupId,
  batchText,
  setBatchText,
  batchLoading,
  batchResult,
  setBatchResult,
  batchEmailStatuses,
  batchPollActive,
  transferSourceId,
  setTransferSourceId,
  transferTargetId,
  setTransferTargetId,
  transferEmails,
  setTransferEmails,
  transferLoading,
  transferStatus,
  submitTransfer,
  onCrossInvite,
  onCrossRemove,
  onBulkInviteGroup,
  onBulkRemoveGroup,
  startBatchTaskPoll,
  setBatchLoading
}: BatchTabProps) {
  return (
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
              {transferLoading ? <><Spinner size={14} color="currentColor" /> 提交中...</> : '开始迁移'}
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
                  if (result) {
                    setBatchResult(result);
                    setBatchText("");
                    // Start polling task status for invite operations
                    if (batchSubTab === "cross-invite") {
                      const allQueued = (result as CrossInviteResult).allocated?.flatMap(a => a.queued) ?? [];
                      if (allQueued.length > 0) startBatchTaskPoll(allQueued);
                    } else if (batchSubTab === "group-invite") {
                      const queued = (result as BulkGroupInviteResult).queued ?? [];
                      if (queued.length > 0) startBatchTaskPoll(queued);
                    }
                  }
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
                          <div style={{ fontWeight: 600, marginBottom: '6px' }}>✅ 已分配到 <strong>{groupName}</strong>（{alloc.queued.length} 个）</div>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                            <thead>
                              <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                                <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600 }}>邮箱</th>
                                <th style={{ textAlign: 'center', padding: '4px 8px', fontWeight: 600, width: 80 }}>状态</th>
                              </tr>
                            </thead>
                            <tbody>
                              {alloc.queued.map(email => {
                                const s = batchEmailStatuses.find(b => b.email.toLowerCase() === email.toLowerCase());
                                const taskStatus = s?.status ?? 'QUEUED';
                                return (
                                  <tr key={email} style={{ borderBottom: '1px solid #f3f4f6' }}>
                                    <td style={{ padding: '4px 8px', fontFamily: 'monospace', wordBreak: 'break-all' }}>{email}</td>
                                    <td style={{ textAlign: 'center', padding: '4px 8px' }}>
                                      <StatusBadge value={taskStatus} />
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                          {batchPollActive && (
                            <div style={{ marginTop: '6px', fontSize: '0.75rem', color: 'var(--foreground-muted, #737373)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <Spinner size={10} /> 每 5 秒刷新任务状态…
                            </div>
                          )}
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
  );
}
