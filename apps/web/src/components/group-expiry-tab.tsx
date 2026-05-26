"use client";

import React from "react";
import { ConfirmButton } from "./confirm-button";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "./status-badge";
import { BatchResultTable, ExpiredMemberInfo } from "./group-panel-types";
import type { CrossRemoveResult } from "./console-app";

type ExpiryTabProps = {
  expiryFilter: "expired" | "expiring_soon" | "all";
  setExpiryFilter: (filter: "expired" | "expiring_soon" | "all") => void;
  expirySearch: string;
  setExpirySearch: (search: string) => void;
  expiryMembers: ExpiredMemberInfo[];
  expiryTotal: number;
  expiryPage: number;
  expiryLoading: boolean;
  expirySelected: Set<string>;
  setExpirySelected: (selected: Set<string>) => void;
  expiryRemoving: boolean;
  expiryRemoveResult: CrossRemoveResult | null;
  fetchExpiryMembers: (page?: number, overrides?: { filter?: string }) => Promise<void>;
  handleBulkRemoveExpired: () => Promise<void>;
  pageSize: number;
};

export function ExpiryTab({
  expiryFilter,
  setExpiryFilter,
  expirySearch,
  setExpirySearch,
  expiryMembers,
  expiryTotal,
  expiryPage,
  expiryLoading,
  expirySelected,
  setExpirySelected,
  expiryRemoving,
  expiryRemoveResult,
  fetchExpiryMembers,
  handleBulkRemoveExpired,
  pageSize
}: ExpiryTabProps) {
  return (
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
            共 {expiryTotal} 条 · 第 {expiryPage}/{Math.ceil(expiryTotal / pageSize)} 页 · 已选 {expirySelected.size} 个
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
          {Math.ceil(expiryTotal / pageSize) > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px', padding: '8px 0' }}>
              <button className="button secondary small" disabled={expiryPage <= 1} onClick={() => fetchExpiryMembers(expiryPage - 1)} type="button">← 上页</button>
              <span style={{ fontSize: '0.85rem' }}>{expiryPage} / {Math.ceil(expiryTotal / pageSize)}</span>
              <button className="button secondary small" disabled={expiryPage >= Math.ceil(expiryTotal / pageSize)} onClick={() => fetchExpiryMembers(expiryPage + 1)} type="button">下页 →</button>
            </div>
          )}

          {/* Bulk actions */}
          <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
            <ConfirmButton
              className="button danger small"
              disabled={expirySelected.size === 0 || expiryRemoving}
              confirmLabel={`确定踢出 ${expirySelected.size} 个？`}
              loadingLabel={<><Spinner size={14} color="currentColor" /> 踢出中...</>}
              onConfirm={handleBulkRemoveExpired}
            >
              批量踢出 ({expirySelected.size})
            </ConfirmButton>
          </div>

          {expiryRemoveResult && <BatchResultTable result={expiryRemoveResult} />}
        </>
      )}
    </div>
  );
}
