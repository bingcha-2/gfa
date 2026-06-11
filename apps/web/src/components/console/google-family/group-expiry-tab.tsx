"use client";

import React from "react";
import { ConfirmButton } from "./confirm-button";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "./status-badge";
import { BatchResultTable, ExpiredMemberInfo } from "./group-panel-types";
import type { CrossRemoveResult } from "./console-app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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
        <Select
          value={expiryFilter}
          onValueChange={(v) => { const val = v as "expired" | "expiring_soon" | "all"; setExpiryFilter(val); fetchExpiryMembers(1, { filter: val }); }}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部有到期时间</SelectItem>
            <SelectItem value="expired">🔴 已到期</SelectItem>
            <SelectItem value="expiring_soon">🟡 7天内到期</SelectItem>
          </SelectContent>
        </Select>
        <div style={{ position: 'relative', flex: '1 1 200px', minWidth: 160 }}>
          <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--foreground-muted, #a3a3a3)', fontSize: '0.9rem', pointerEvents: 'none', zIndex: 1 }}>🔍</span>
          <Input
            type="text"
            placeholder="搜索子号邮箱…"
            value={expirySearch}
            onChange={(e) => setExpirySearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && fetchExpiryMembers(1)}
            style={{ paddingLeft: 32 }}
          />
        </div>
        <Button variant="outline" size="sm" type="button" onClick={() => fetchExpiryMembers(1)}>
          查询
        </Button>
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead style={{ width: 30 }}>
                  <Checkbox
                    checked={expirySelected.size === expiryMembers.length && expiryMembers.length > 0}
                    onCheckedChange={(checked) => {
                      if (checked) setExpirySelected(new Set(expiryMembers.map(m => m.id)));
                      else setExpirySelected(new Set());
                    }}
                  />
                </TableHead>
                <TableHead>邮箱</TableHead>
                <TableHead>家庭组</TableHead>
                <TableHead>到期时间</TableHead>
                <TableHead>剩余天数</TableHead>
                <TableHead>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {expiryMembers.map(m => (
                <TableRow key={m.id} style={m.isExpired ? { background: 'rgba(239,68,68,0.05)' } : undefined}>
                  <TableCell>
                    <Checkbox
                      checked={expirySelected.has(m.id)}
                      onCheckedChange={(checked) => {
                        const next = new Set(expirySelected);
                        if (checked) next.add(m.id);
                        else next.delete(m.id);
                        setExpirySelected(next);
                      }}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs">{m.email}</TableCell>
                  <TableCell className="text-xs">{m.groupName}</TableCell>
                  <TableCell className="text-xs" style={{ color: m.isExpired ? '#dc2626' : m.daysRemaining !== null && m.daysRemaining <= 7 ? '#d97706' : undefined }}>
                    {m.expiresAt ? new Date(m.expiresAt).toLocaleDateString('zh-CN') : '-'}
                  </TableCell>
                  <TableCell className="text-xs font-semibold" style={{ color: m.isExpired ? '#dc2626' : m.daysRemaining !== null && m.daysRemaining <= 3 ? '#d97706' : '#059669' }}>
                    {m.daysRemaining !== null ? (m.daysRemaining <= 0 ? `已过期 ${Math.abs(m.daysRemaining)} 天` : `${m.daysRemaining} 天`) : '-'}
                  </TableCell>
                  <TableCell><StatusBadge value={m.status} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {/* Pagination */}
          {Math.ceil(expiryTotal / pageSize) > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px', padding: '8px 0' }}>
              <Button variant="outline" size="sm" disabled={expiryPage <= 1} onClick={() => fetchExpiryMembers(expiryPage - 1)} type="button">← 上页</Button>
              <span style={{ fontSize: '0.85rem' }}>{expiryPage} / {Math.ceil(expiryTotal / pageSize)}</span>
              <Button variant="outline" size="sm" disabled={expiryPage >= Math.ceil(expiryTotal / pageSize)} onClick={() => fetchExpiryMembers(expiryPage + 1)} type="button">下页 →</Button>
            </div>
          )}

          {/* Bulk actions */}
          <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
            <ConfirmButton
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
