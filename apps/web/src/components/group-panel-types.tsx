"use client";

import type { AccountSummary, FamilyGroupSummary } from "../lib/types";
import type {
  BulkGroupInviteResult,
  BulkGroupRemoveResult,
  CrossInviteResult,
  CrossRemoveResult,
  MigrateResult,
  TransferBatchResult,
  TransferStatusResult
} from "./console-app";

// --- Shared types ---

export type MemberInfo = {
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

export type ExpiredMemberInfo = {
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

export type GroupDetail = {
  members?: MemberInfo[];
  invites?: { id: string; email: string; status: string; createdAt: string }[];
};

export type DuplicateMemberInfo = {
  email: string;
  count: number;
  groups: Array<{ groupId: string; groupName: string; memberStatus: string; joinedAt: string | null }>;
};

export type GroupPanelProps = {
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
  onMigrateMember?: (groupId: string, memberEmail: string) => Promise<MigrateResult | null>;
};

// --- Shared utility functions ---

export function formatDate(dateStr?: string | null) {
  if (!dateStr) return "-";
  return new Date(dateStr).toLocaleDateString("zh-CN");
}

export function timeAgo(dateStr?: string | null): string {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

export function parseEmails(text: string): string[] {
  return text.split('\n').map(l => l.trim()).filter(Boolean);
}

// --- Shared helper sub-components for batch result display ---

export function ResultRow({ label, items, color }: { label: string; items: string[]; color?: string }) {
  if (!items.length) return null;
  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '0.875rem', padding: '6px 0', borderBottom: '1px solid var(--border, #e5e5e5)' }}>
      <span style={{ minWidth: 120, fontWeight: 600, color: color ?? 'inherit', flexShrink: 0 }}>{label} ({items.length})</span>
      <span style={{ fontFamily: 'monospace', fontSize: '0.8rem', color: 'var(--foreground-muted, #737373)', wordBreak: 'break-all' }}>{items.join(', ')}</span>
    </div>
  );
}

export function BatchResultTable({ result }: { result: CrossRemoveResult | BulkGroupRemoveResult }) {
  return (
    <div style={{ background: 'var(--surface-2, #f5f5f4)', borderRadius: '8px', padding: '10px 14px' }}>
      <ResultRow label="✅ 已入队" items={result.queued ?? []} color="#059669" />
      <ResultRow label="⚠️ 未找到" items={result.notFound ?? []} color="#d97706" />
      <ResultRow label="ℹ️ 已移除" items={result.alreadyRemoved ?? []} />
      <ResultRow label="❌ 入队失败" items={result.failed ?? []} color="#dc2626" />
    </div>
  );
}

export function BatchInviteResultTable({ result }: { result: BulkGroupInviteResult }) {
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
