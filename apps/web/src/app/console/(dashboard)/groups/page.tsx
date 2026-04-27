"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useConsole } from "@/components/console-provider";
import { apiRequest, getErrorMessage } from "@/lib/client-api";
import type { AccountSummary, FamilyGroupSummary } from "@/lib/types";
import type {
  CrossInviteResult, CrossRemoveResult, BulkGroupInviteResult, BulkGroupRemoveResult,
  TransferBatchResult, TransferStatusResult, MigrateResult,
} from "@/components/console-app";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Pagination, PaginationContent, PaginationItem, PaginationLink,
  PaginationNext, PaginationPrevious, PaginationEllipsis,
} from "@/components/ui/pagination";
import {
  RefreshCw, Plus, ChevronDown, ChevronRight, UserMinus, ArrowLeftRight, Loader2,
  RotateCcw, ToggleLeft, ToggleRight, Users, Search, Calendar, AlertTriangle, Copy, ArrowUpDown,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type LatestTask = { type: string; status: string; createdAt: string };
type MemberInfo = { id: string; email: string; displayName?: string | null; role: string; status: string; isInGroup?: boolean; joinedAt?: string | null; expiresAt?: string | null; googleMemberId?: string | null; latestTask?: LatestTask | null };
type GroupDetail = { members?: MemberInfo[]; invites?: { id: string; email: string; status: string; createdAt: string }[] };
type DuplicateMember = { email: string; count: number; groups: { groupId: string; groupName: string; memberStatus: string; joinedAt: string | null }[] };

const TASK_TYPE_LABELS: Record<string, string> = {
  INVITE_MEMBER: "邀请", REMOVE_MEMBER: "移除", REPLACE_MEMBER: "替换",
  SYNC_FAMILY_GROUP: "同步", ACCEPT_INVITE: "接受邀请",
  HEALTH_CHECK_ACCOUNT: "健康检查", OAUTH_AUTHORIZE: "OAuth",
};

function fmtDate(d?: string | null) { return d ? new Date(d).toLocaleDateString("zh-CN") : "—"; }
function fmtRelative(d?: string | null) {
  if (!d) return "";
  const diff = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
  if (diff <= 0) return "今天";
  if (diff === 1) return "1天前";
  return `${diff}天前`;
}
function parseEmails(text: string) { return text.split("\n").map((l) => l.trim()).filter(Boolean); }
function statusVar(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (["HEALTHY", "ACTIVE", "SYNCED"].includes(s)) return "default";
  if (["PENDING", "RUNNING", "QUEUED", "NEVER_SYNCED"].includes(s)) return "secondary";
  if (["ERROR", "DISABLED", "FAILED", "UNSYNCED"].includes(s)) return "destructive";
  return "outline";
}

const GROUP_PAGE_SIZE = 20;

export default function GroupsPage() {
  const { user, refreshStats } = useConsole();
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [groups, setGroups] = useState<FamilyGroupSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const canManage = user.role === "SUPER_ADMIN" || user.role === "ADMIN";

  // Inventory state
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState("ALL");
  const [filterSubStatus, setFilterSubStatus] = useState("ALL");
  const [filterSlots, setFilterSlots] = useState("ALL");
  const [currentGroupPage, setCurrentGroupPage] = useState(1);
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());
  const lastMemberEmailSearchRef = useRef<string | undefined>(undefined);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Expanded group detail
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const [groupDetail, setGroupDetail] = useState<GroupDetail | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);

  // Sync state
  const [syncingGroupId, setSyncingGroupId] = useState<string | null>(null);

  // Member actions
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [removeGroupId, setRemoveGroupId] = useState("");
  const [removeEmail, setRemoveEmail] = useState("");
  const [replaceDialogOpen, setReplaceDialogOpen] = useState(false);
  const [replaceGroupId, setReplaceGroupId] = useState("");
  const [replaceTargetEmail, setReplaceTargetEmail] = useState("");
  const [replaceNewEmail, setReplaceNewEmail] = useState("");

  // Edit member expiry
  const [editExpiryOpen, setEditExpiryOpen] = useState(false);
  const [editExpiryGroupId, setEditExpiryGroupId] = useState("");
  const [editExpiryMemberId, setEditExpiryMemberId] = useState("");
  const [editExpiryEmail, setEditExpiryEmail] = useState("");
  const [editExpiryValue, setEditExpiryValue] = useState("");

  // Duplicate members
  const [duplicateDialogOpen, setDuplicateDialogOpen] = useState(false);
  const [duplicateMembers, setDuplicateMembers] = useState<DuplicateMember[]>([]);
  const [duplicateLoading, setDuplicateLoading] = useState(false);

  // Migrate member
  const [migrateDialogOpen, setMigrateDialogOpen] = useState(false);
  const [migrateGroupId, setMigrateGroupId] = useState("");
  const [migrateEmail, setMigrateEmail] = useState("");
  const [migrateLoading, setMigrateLoading] = useState(false);

  // Create form
  const [createForm, setCreateForm] = useState({ accountId: "", groupName: "", maxMembers: "5" });

  // Batch operations
  const [batchMode, setBatchMode] = useState<"cross-invite" | "cross-remove" | "group-invite" | "group-remove">("cross-invite");
  const [batchText, setBatchText] = useState("");
  const [batchGroupId, setBatchGroupId] = useState("");
  const [batchValidDays, setBatchValidDays] = useState(30);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchResult, setBatchResult] = useState<any>(null);

  const loadData = useCallback(async (memberEmailSearch?: string, resetSearch = false) => {
    try {
      // If resetSearch, clear the saved search; otherwise use provided or last search
      if (resetSearch) {
        lastMemberEmailSearchRef.current = undefined;
      } else if (memberEmailSearch !== undefined) {
        lastMemberEmailSearchRef.current = memberEmailSearch || undefined;
      }
      const effectiveSearch = lastMemberEmailSearchRef.current;
      const search: Record<string, string> = {};
      if (effectiveSearch) search.memberEmail = effectiveSearch;
      const [acc, grp] = await Promise.all([
        apiRequest<AccountSummary[]>("accounts"),
        apiRequest<FamilyGroupSummary[]>("family-groups", { search }),
      ]);
      setAccounts(acc); setGroups(grp);
      if (!createForm.accountId && acc[0]?.id) setCreateForm((f) => ({ ...f, accountId: acc[0]!.id }));
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Filter + paginate groups
  const filtered = groups.filter((g) => {
    const q = searchTerm.toLowerCase();
    // When searching by member email (contains @), the backend already filtered
    // the groups correctly — skip local name matching to avoid discarding results
    const isBackendSearch = q.includes('@') && q.length >= 3;
    const matchSearch = !q || isBackendSearch || g.groupName.toLowerCase().includes(q) || g.account?.loginEmail?.toLowerCase().includes(q) || g.account?.name?.toLowerCase().includes(q);
    const matchStatus = filterStatus === "ALL"
      || (filterStatus === "SYNCED" && g.lastSyncedAt)
      || (filterStatus === "NEVER_SYNCED" && !g.lastSyncedAt)
      || (filterStatus === "ACTIVE" && g.status === "ACTIVE")
      || (filterStatus === "MANUAL_ONLY" && g.status === "MANUAL_ONLY")
      || (filterStatus === "DISABLED" && g.status === "DISABLED")
      || (filterStatus === "HAS_PENDING" && (g.pendingMemberCount ?? 0) > 0)
      || (filterStatus === "PENDING_OVER_3D" && (g.pendingOver3DaysCount ?? 0) > 0)
      || (filterStatus === "ACCT_LOGIN_REQUIRED" && g.account?.status === "LOGIN_REQUIRED")
      || (filterStatus === "ACCT_RISKY" && g.account?.status === "RISKY")
      || (filterStatus === "ACCT_DISABLED" && g.account?.status === "DISABLED");
    const matchSub = filterSubStatus === "ALL"
      || (filterSubStatus === "ACTIVE" && g.account?.subscriptionStatus === "ACTIVE")
      || (filterSubStatus === "SUSPENDED" && g.account?.subscriptionStatus === "SUSPENDED")
      || (filterSubStatus === "EXPIRED" && g.account?.subscriptionExpiresAt && new Date(g.account.subscriptionExpiresAt) < new Date())
      || (filterSubStatus === "UNKNOWN" && !g.account?.subscriptionStatus);
    const matchSlots = filterSlots === "ALL"
      || (filterSlots === "HAS_SLOTS" && g.availableSlots > 0)
      || (filterSlots === "FULL" && g.availableSlots === 0);
    return matchSearch && matchStatus && matchSub && matchSlots;
  });
  const totalGroupPages = Math.ceil(filtered.length / GROUP_PAGE_SIZE);
  const paginated = filtered.slice((currentGroupPage - 1) * GROUP_PAGE_SIZE, currentGroupPage * GROUP_PAGE_SIZE);

  async function toggleGroupDetail(groupId: string) {
    if (expandedGroupId === groupId) { setExpandedGroupId(null); setGroupDetail(null); return; }
    setExpandedGroupId(groupId); setIsLoadingDetail(true); setGroupDetail(null);
    try {
      const detail = await apiRequest<GroupDetail>(`family-groups/${groupId}`);
      setGroupDetail(detail);
    } catch { setGroupDetail({ members: [], invites: [] }); }
    finally { setIsLoadingDetail(false); }
  }

  async function refreshGroupDetail(groupId: string) {
    try { const detail = await apiRequest<GroupDetail>(`family-groups/${groupId}`); setGroupDetail(detail); } catch {}
  }

  async function handleSync(groupId: string) {
    setSyncingGroupId(groupId);
    try {
      const result = await apiRequest<{ queued: boolean; taskId: string }>(`family-groups/${groupId}/sync`, { method: "POST" });
      toast.success("同步任务已创建");
      await loadData();
      if (expandedGroupId === groupId) await refreshGroupDetail(groupId);
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally { setSyncingGroupId(null); }
  }

  async function handleRemoveMember() {
    try {
      await apiRequest(`family-groups/${removeGroupId}/remove-member`, { method: "POST", body: { memberEmail: removeEmail } });
      toast.success(`已提交移除任务: ${removeEmail}`);
      setRemoveDialogOpen(false);
      if (expandedGroupId === removeGroupId) await refreshGroupDetail(removeGroupId);
    } catch (err) { toast.error(getErrorMessage(err)); }
  }

  async function handleReplaceMember() {
    try {
      await apiRequest(`family-groups/${replaceGroupId}/replace-member`, { method: "POST", body: { targetMemberEmail: replaceTargetEmail, newUserEmail: replaceNewEmail } });
      toast.success("替换任务已提交");
      setReplaceDialogOpen(false);
      if (expandedGroupId === replaceGroupId) await refreshGroupDetail(replaceGroupId);
    } catch (err) { toast.error(getErrorMessage(err)); }
  }

  async function handleToggleAutoAssign(groupId: string) {
    try {
      await apiRequest(`family-groups/${groupId}/toggle-auto-assign`, { method: "POST" });
      toast.success("自动分配已切换"); await loadData();
    } catch (err) { toast.error(getErrorMessage(err)); }
  }

  async function handleEditExpiry() {
    try {
      await apiRequest(`family-groups/${editExpiryGroupId}/members/${editExpiryMemberId}/dates`, {
        method: "PATCH", body: { expiresAt: editExpiryValue || null },
      });
      toast.success(`已更新 ${editExpiryEmail} 到期时间`);
      setEditExpiryOpen(false);
      if (expandedGroupId === editExpiryGroupId) await refreshGroupDetail(editExpiryGroupId);
    } catch (err) { toast.error(getErrorMessage(err)); }
  }

  async function handleLoadDuplicates() {
    setDuplicateLoading(true);
    try {
      const data = await apiRequest<DuplicateMember[]>("family-groups/duplicate-members");
      setDuplicateMembers(data);
      setDuplicateDialogOpen(true);
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally { setDuplicateLoading(false); }
  }

  async function handleMigrateMember() {
    setMigrateLoading(true);
    try {
      const result = await apiRequest<{ removedFromGroupName: string; inviteResult: { targetGroupName: string } | null; error?: string }>(
        `family-groups/${migrateGroupId}/migrate-member`, { method: "POST", body: { memberEmail: migrateEmail } }
      );
      if (result.inviteResult) {
        toast.success(`已从 ${result.removedFromGroupName} 移除，正在邀请到 ${result.inviteResult.targetGroupName}`);
      } else {
        toast.warning(result.error ?? "已移除但未找到可用组");
      }
      setMigrateDialogOpen(false);
      await loadData();
      if (expandedGroupId === migrateGroupId) await refreshGroupDetail(migrateGroupId);
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally { setMigrateLoading(false); }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiRequest("family-groups", { method: "POST", body: { accountId: createForm.accountId, groupName: createForm.groupName, maxMembers: Number(createForm.maxMembers) } });
      toast.success("家庭组创建成功");
      setCreateForm((f) => ({ ...f, groupName: "", maxMembers: "5" }));
      await loadData(); await refreshStats();
    } catch (err) { toast.error(getErrorMessage(err)); }
  }

  async function runBatch() {
    setBatchLoading(true); setBatchResult(null);
    const emails = parseEmails(batchText);
    if (!emails.length) { toast.error("请输入邮箱"); setBatchLoading(false); return; }
    try {
      let result: any;
      switch (batchMode) {
        case "cross-invite": result = await apiRequest("family-groups/cross-invite", { method: "POST", body: { emails, validDays: batchValidDays } }); break;
        case "cross-remove": result = await apiRequest("family-groups/cross-remove", { method: "POST", body: { memberEmails: emails } }); break;
        case "group-invite":
          if (!batchGroupId) { toast.error("请选择家庭组"); setBatchLoading(false); return; }
          result = await apiRequest(`family-groups/${batchGroupId}/bulk-invite`, { method: "POST", body: { emails, validDays: batchValidDays } }); break;
        case "group-remove":
          if (!batchGroupId) { toast.error("请选择家庭组"); setBatchLoading(false); return; }
          result = await apiRequest(`family-groups/${batchGroupId}/bulk-remove`, { method: "POST", body: { memberEmails: emails } }); break;
      }
      setBatchResult(result);
      toast.success("操作已执行"); await loadData();
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally { setBatchLoading(false); }
  }

  if (loading) return <div className="space-y-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}</div>;

  return (
    <>
      <Tabs defaultValue="inventory">
        <div className="flex items-center justify-between mb-4">
          <TabsList>
            <TabsTrigger value="inventory">库存列表</TabsTrigger>
            <TabsTrigger value="batch">批量操作</TabsTrigger>
            {canManage && <TabsTrigger value="create">新增家庭组</TabsTrigger>}
          </TabsList>
          <div className="flex items-center gap-2">
            <Input placeholder="搜索组名 / 母号 / 子号邮箱…" value={searchTerm} onChange={(e) => {
              const v = e.target.value;
              setSearchTerm(v); setCurrentGroupPage(1);
              // Debounced member email search
              if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
              if (v.includes('@') && v.length >= 3) {
                searchTimerRef.current = setTimeout(() => { loadData(v.trim()); }, 500);
              } else if (!v) {
                loadData(undefined, true);
              }
            }} className="w-64" />
            <Select value={filterStatus} onValueChange={(v) => { setFilterStatus(v); setCurrentGroupPage(1); }} items={[
              { label: "全部状态", value: "ALL" },
              { label: "✅ 自动分配", value: "ACTIVE" },
              { label: "⏸ 仅手动", value: "MANUAL_ONLY" },
              { label: "🚫 已禁用", value: "DISABLED" },
              { label: "✅ 已同步", value: "SYNCED" },
              { label: "⚠️ 未同步", value: "NEVER_SYNCED" },
              { label: "⏳ 有待进组", value: "HAS_PENDING" },
              { label: "🚨 3天以上未进组", value: "PENDING_OVER_3D" },
              { label: "🔑 母号需登录", value: "ACCT_LOGIN_REQUIRED" },
              { label: "⚠️ 母号风控", value: "ACCT_RISKY" },
              { label: "🚫 母号禁用", value: "ACCT_DISABLED" },
            ]}>
              <SelectTrigger className="w-32"><SelectValue placeholder="状态" /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="ALL">全部状态</SelectItem>
                  <SelectItem value="ACTIVE">✅ 自动分配</SelectItem>
                  <SelectItem value="MANUAL_ONLY">⏸ 仅手动</SelectItem>
                  <SelectItem value="DISABLED">🚫 已禁用</SelectItem>
                  <SelectItem value="SYNCED">✅ 已同步</SelectItem>
                  <SelectItem value="NEVER_SYNCED">⚠️ 未同步</SelectItem>
                  <SelectItem value="HAS_PENDING">⏳ 有待进组</SelectItem>
                  <SelectItem value="PENDING_OVER_3D">🚨 3天以上未进组</SelectItem>
                  <SelectItem value="ACCT_LOGIN_REQUIRED">🔑 母号需登录</SelectItem>
                  <SelectItem value="ACCT_RISKY">⚠️ 母号风控</SelectItem>
                  <SelectItem value="ACCT_DISABLED">🚫 母号禁用</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select value={filterSubStatus} onValueChange={(v) => { setFilterSubStatus(v); setCurrentGroupPage(1); }} items={[
              { label: "全部订阅", value: "ALL" },
              { label: "活跃", value: "ACTIVE" },
              { label: "暂停", value: "SUSPENDED" },
              { label: "过期", value: "EXPIRED" },
              { label: "未知", value: "UNKNOWN" },
            ]}>
              <SelectTrigger className="w-28"><SelectValue placeholder="订阅" /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="ALL">全部订阅</SelectItem>
                  <SelectItem value="ACTIVE">活跃</SelectItem>
                  <SelectItem value="SUSPENDED">暂停</SelectItem>
                  <SelectItem value="EXPIRED">过期</SelectItem>
                  <SelectItem value="UNKNOWN">未知</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select value={filterSlots} onValueChange={(v) => { setFilterSlots(v); setCurrentGroupPage(1); }} items={[
              { label: "全部", value: "ALL" },
              { label: "有空位", value: "HAS_SLOTS" },
              { label: "已满", value: "FULL" },
            ]}>
              <SelectTrigger className="w-24"><SelectValue placeholder="空位" /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="ALL">全部</SelectItem>
                  <SelectItem value="HAS_SLOTS">有空位</SelectItem>
                  <SelectItem value="FULL">已满</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => loadData()} disabled={loading}><RefreshCw className="h-4 w-4" /></Button>
            <Button variant="outline" size="sm" onClick={() => void handleLoadDuplicates()} disabled={duplicateLoading}>
              {duplicateLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlertTriangle className="h-4 w-4" />}
              <span className="ml-1">查重复</span>
            </Button>
          </div>
        </div>

        {/* ── Inventory ── */}
        <TabsContent value="inventory">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>家庭组库存</CardTitle>
                  <CardDescription>{filtered.length} / {groups.length} 组{totalGroupPages > 0 && ` · 第 ${currentGroupPage}/${totalGroupPages} 页`}{selectedGroupIds.size > 0 && ` · 已选 ${selectedGroupIds.size} 个`}</CardDescription>
                </div>
                {selectedGroupIds.size > 0 && (
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => {
                      const lines = filtered.filter((g) => selectedGroupIds.has(g.id)).map((g) => {
                        const email = g.account?.loginEmail ?? '—';
                        const subStatus = g.account?.subscriptionStatus;
                        const suspendedAt = g.account?.subscriptionStatusUpdatedAt;
                        const expiresAt = g.account?.subscriptionExpiresAt;
                        let info = email;
                        if (subStatus === 'SUSPENDED' && suspendedAt) {
                          info += `\t暂停于 ${new Date(suspendedAt).toLocaleDateString('zh-CN')}`;
                        } else if (expiresAt) {
                          info += `\t到期 ${new Date(expiresAt).toLocaleDateString('zh-CN')}`;
                        }
                        return info;
                      });
                      navigator.clipboard.writeText(lines.join('\n'));
                      toast.success(`已复制 ${lines.length} 个母号信息`);
                    }}>
                      <Copy className="h-3.5 w-3.5 mr-1" />复制邮箱+订阅
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => {
                      const emails = filtered.filter((g) => selectedGroupIds.has(g.id)).map((g) => g.account?.loginEmail ?? '').filter(Boolean);
                      navigator.clipboard.writeText(emails.join('\n'));
                      toast.success(`已复制 ${emails.length} 个邮箱`);
                    }}>
                      <Copy className="h-3.5 w-3.5 mr-1" />仅邮箱
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setSelectedGroupIds(new Set())}>
                      取消选择
                    </Button>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {paginated.length > 0 && (
                <div className="flex items-center gap-2 mb-3">
                  <Checkbox
                    checked={paginated.length > 0 && paginated.every((g) => selectedGroupIds.has(g.id))}
                    onCheckedChange={(checked) => {
                      setSelectedGroupIds((prev) => {
                        const next = new Set(prev);
                        if (checked) { paginated.forEach((g) => next.add(g.id)); }
                        else { paginated.forEach((g) => next.delete(g.id)); }
                        return next;
                      });
                    }}
                  />
                  <span className="text-sm text-muted-foreground">全选当页</span>
                  {filtered.length > paginated.length && (
                    <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => {
                      setSelectedGroupIds(new Set(filtered.map((g) => g.id)));
                    }}>全选所有 {filtered.length} 个</Button>
                  )}
                </div>
              )}
              {paginated.length === 0 ? (
                <p className="text-center text-muted-foreground py-12">没有匹配的家庭组</p>
              ) : (
                <div className="space-y-2">
                  {paginated.map((g) => {
                    const isExpanded = expandedGroupId === g.id;
                    const isSyncing = syncingGroupId === g.id;
                    return (
                      <Collapsible key={g.id} open={isExpanded} onOpenChange={() => toggleGroupDetail(g.id)}>
                        <div className={`rounded-lg border p-3 ${selectedGroupIds.has(g.id) ? 'ring-2 ring-primary/30 bg-primary/5' : ''}`}>
                          <CollapsibleTrigger nativeButton={false} render={<div className="flex items-center justify-between cursor-pointer" />}>
                              <div className="flex items-center gap-3">
                                <Checkbox
                                  checked={selectedGroupIds.has(g.id)}
                                  onCheckedChange={(checked) => {
                                    setSelectedGroupIds((prev) => {
                                      const next = new Set(prev);
                                      if (checked) next.add(g.id); else next.delete(g.id);
                                      return next;
                                    });
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                  className="shrink-0"
                                />
                                {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                                <div>
                                  <div className="font-medium">{g.groupName}</div>
                                  <div className="text-xs text-muted-foreground">{g.account?.loginEmail ?? "—"}{g.account?.name && g.account.name !== g.account.loginEmail && g.account.name !== g.account.loginEmail.split('@')[0] ? ` · ${g.account.name}` : ""}</div>
                                  {(g.account?.subscriptionStatus || g.account?.subscriptionExpiresAt) && (
                                    <div className="text-xs text-muted-foreground">
                                      {g.account.subscriptionStatus && (
                                        <span>
                                          {g.account.subscriptionStatus === "ACTIVE" ? "✅" : g.account.subscriptionStatus === "SUSPENDED" ? "⚠️" : "❓"}
                                          {g.account.subscriptionStatus === "SUSPENDED" ? "订阅暂停" : g.account.subscriptionStatus}
                                        </span>
                                      )}
                                      {g.account.subscriptionStatus === "SUSPENDED" && g.account.subscriptionStatusUpdatedAt && (
                                        <span className="text-orange-500 font-medium ml-1">
                                          (暂停于 {new Date(g.account.subscriptionStatusUpdatedAt).toLocaleDateString("zh-CN")})
                                        </span>
                                      )}
                                      {g.account.subscriptionExpiresAt && (
                                        <span>
                                          {g.account.subscriptionStatus ? " · " : ""}订阅到期: <span className={(() => {
                                            const d = new Date(g.account.subscriptionExpiresAt);
                                            const diff = Math.floor((d.getTime() - Date.now()) / 86400000);
                                            if (diff < 0) return "text-destructive font-semibold";
                                            if (diff <= 30) return "text-orange-500 font-semibold";
                                            return "";
                                          })()}>
                                            {new Date(g.account.subscriptionExpiresAt).toLocaleDateString("zh-CN")}
                                            {(() => {
                                              const diff = Math.floor((new Date(g.account.subscriptionExpiresAt).getTime() - Date.now()) / 86400000);
                                              if (diff < 0) return ` (已过期${Math.abs(diff)}天)`;
                                              if (diff <= 30) return ` (剩${diff}天)`;
                                              return "";
                                            })()}
                                          </span>
                                        </span>
                                      )}
                                      {g.account.subscriptionPlan && <> · {g.account.subscriptionPlan}</>}
                                    </div>
                                  )}
                                  {g.account?.notes && (
                                    <div className="text-xs text-orange-500">📝 {g.account.notes}</div>
                                  )}
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <div className="text-right mr-2">
                                  <div className="text-sm font-semibold tabular-nums">{g.memberCount}/{g.maxMembers}</div>
                                  <div className="text-xs text-muted-foreground">{g.availableSlots} 空位</div>
                                </div>
                                <Badge variant={g.lastSyncedAt ? "default" : "secondary"} className="text-xs">{g.lastSyncedAt ? `已同步 ${fmtDate(g.lastSyncedAt)}` : "未同步"}</Badge>
                                <Badge variant={g.status === "ACTIVE" ? "default" : g.status === "MANUAL_ONLY" ? "outline" : "destructive"} className="text-xs">{g.status === "ACTIVE" ? "自动分配" : g.status === "MANUAL_ONLY" ? "手动" : "已禁用"}</Badge>
                                <Button variant="outline" size="sm" className="h-7 px-2" disabled={isSyncing} onClick={(e) => { e.stopPropagation(); void handleSync(g.id); }}>
                                  {isSyncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                                </Button>
                              </div>
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            <div className="mt-3 pt-3 border-t space-y-3">
                              {/* Action buttons */}
                              <div className="flex gap-2 flex-wrap">
                                <Button variant="outline" size="sm" onClick={() => void handleToggleAutoAssign(g.id)}>
                                  {g.status === "ACTIVE" ? <ToggleRight className="h-3.5 w-3.5 mr-1" /> : <ToggleLeft className="h-3.5 w-3.5 mr-1" />}
                                  {g.status === "ACTIVE" ? "关闭自动分配" : "开启自动分配"}
                                </Button>
                              </div>
                              {/* Members table */}
                              {isLoadingDetail ? (
                                <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
                              ) : groupDetail ? (
                                <>
                                  {(groupDetail.members?.length ?? 0) > 0 && (
                                    <div className="rounded-md border">
                                      <Table>
                                        <TableHeader>
                                          <TableRow>
                                            <TableHead>邮箱</TableHead>
                                            <TableHead className="w-16">角色</TableHead>
                                            <TableHead className="w-20">状态</TableHead>
                                            <TableHead className="w-28">最近任务</TableHead>
                                            <TableHead className="w-24">加入</TableHead>
                                            <TableHead className="w-24">到期</TableHead>
                                            {canManage && <TableHead className="w-28 text-right">操作</TableHead>}
                                          </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                          {groupDetail.members!.map((m) => {
                                            const taskLabel = m.latestTask ? (TASK_TYPE_LABELS[m.latestTask.type] ?? m.latestTask.type) : null;
                                            const taskTime = m.latestTask ? fmtRelative(m.latestTask.createdAt) : null;
                                            const taskDays = m.latestTask ? Math.floor((Date.now() - new Date(m.latestTask.createdAt).getTime()) / 86400000) : 0;
                                            const isPendingTooLong = m.status === "PENDING" && taskDays >= 3;
                                            return (
                                            <TableRow key={m.id} className={isPendingTooLong ? "bg-orange-50 dark:bg-orange-950/20" : ""}>
                                              <TableCell className="text-sm">{m.email}{m.displayName && <span className="text-muted-foreground ml-1">({m.displayName})</span>}</TableCell>
                                              <TableCell><Badge variant="outline" className="text-xs">{m.role === "OWNER" ? "管理" : "成员"}</Badge></TableCell>
                                              <TableCell><Badge variant={statusVar(m.status)} className="text-xs">{m.status}</Badge></TableCell>
                                              <TableCell className="text-xs">
                                                {taskLabel ? (
                                                  <span className={isPendingTooLong ? "text-orange-600 font-medium" : "text-muted-foreground"}>
                                                    {taskLabel} {taskTime}
                                                  </span>
                                                ) : <span className="text-muted-foreground">—</span>}
                                              </TableCell>
                                              <TableCell className="text-xs text-muted-foreground">{fmtDate(m.joinedAt)}</TableCell>
                                              <TableCell className={`text-xs ${m.expiresAt && new Date(m.expiresAt) < new Date() ? "text-destructive font-medium" : "text-muted-foreground"}`}>{fmtDate(m.expiresAt)}</TableCell>
                                              {canManage && m.role !== "OWNER" && (
                                                <TableCell className="text-right">
                                                  <div className="flex items-center justify-end gap-1">
                                                    <Tooltip>
                                                      <TooltipTrigger render={<Button variant="ghost" size="sm" className="h-7" onClick={() => {
                                                        setEditExpiryGroupId(g.id); setEditExpiryMemberId(m.id); setEditExpiryEmail(m.email);
                                                        setEditExpiryValue(m.expiresAt ? new Date(m.expiresAt).toISOString().split("T")[0] : "");
                                                        setEditExpiryOpen(true);
                                                      }} />}>
                                                        <Calendar className="h-3 w-3" />
                                                      </TooltipTrigger>
                                                      <TooltipContent>编辑到期时间</TooltipContent>
                                                    </Tooltip>
                                                    <Tooltip>
                                                      <TooltipTrigger render={<Button variant="ghost" size="sm" className="h-7 text-destructive hover:bg-destructive/10" onClick={() => { setRemoveGroupId(g.id); setRemoveEmail(m.email); setRemoveDialogOpen(true); }} />}>
                                                        <UserMinus className="h-3 w-3" />
                                                      </TooltipTrigger>
                                                      <TooltipContent>移除成员</TooltipContent>
                                                    </Tooltip>
                                                    <Tooltip>
                                                      <TooltipTrigger render={<Button variant="ghost" size="sm" className="h-7 text-violet-600 hover:text-violet-700 hover:bg-violet-50" onClick={() => { setReplaceGroupId(g.id); setReplaceTargetEmail(m.email); setReplaceNewEmail(""); setReplaceDialogOpen(true); }} />}>
                                                        <ArrowLeftRight className="h-3 w-3" />
                                                      </TooltipTrigger>
                                                      <TooltipContent>替换成员</TooltipContent>
                                                    </Tooltip>
                                                    <Tooltip>
                                                      <TooltipTrigger render={<Button variant="ghost" size="sm" className="h-7 text-blue-600 hover:text-blue-700 hover:bg-blue-50" onClick={() => { setMigrateGroupId(g.id); setMigrateEmail(m.email); setMigrateDialogOpen(true); }} />}>
                                                        <ArrowUpDown className="h-3 w-3" />
                                                      </TooltipTrigger>
                                                      <TooltipContent>迁移成员</TooltipContent>
                                                    </Tooltip>
                                                  </div>
                                                </TableCell>
                                              )}
                                              {canManage && m.role === "OWNER" && <TableCell />}
                                            </TableRow>
                                            );
                                          })}
                                        </TableBody>
                                      </Table>
                                    </div>
                                  )}
                                  {(groupDetail.invites?.length ?? 0) > 0 && (
                                    <div>
                                      <p className="text-sm font-medium mb-2">待接受邀请 ({groupDetail.invites!.length})</p>
                                      <div className="flex flex-wrap gap-2">
                                        {groupDetail.invites!.map((inv) => (
                                          <Badge key={inv.id} variant="secondary" className="text-xs">{inv.email}<span className="ml-1 text-muted-foreground">{inv.status}</span></Badge>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                  {(groupDetail.members?.length ?? 0) === 0 && (groupDetail.invites?.length ?? 0) === 0 && (
                                    <p className="text-sm text-muted-foreground text-center py-4">暂无成员和邀请</p>
                                  )}
                                </>
                              ) : null}
                            </div>
                          </CollapsibleContent>
                        </div>
                      </Collapsible>
                    );
                  })}
                  {totalGroupPages > 1 && (
                    <Pagination className="mt-4">
                      <PaginationContent>
                        <PaginationItem><PaginationPrevious onClick={() => setCurrentGroupPage((p) => Math.max(1, p - 1))} className={currentGroupPage <= 1 ? "pointer-events-none opacity-50" : "cursor-pointer"} /></PaginationItem>
                        {Array.from({ length: Math.min(totalGroupPages, 7) }, (_, i) => i + 1).map((p) => (
                          <PaginationItem key={p}><PaginationLink isActive={p === currentGroupPage} onClick={() => setCurrentGroupPage(p)} className="cursor-pointer">{p}</PaginationLink></PaginationItem>
                        ))}
                        {totalGroupPages > 7 && <PaginationItem><PaginationEllipsis /></PaginationItem>}
                        <PaginationItem><PaginationNext onClick={() => setCurrentGroupPage((p) => Math.min(totalGroupPages, p + 1))} className={currentGroupPage >= totalGroupPages ? "pointer-events-none opacity-50" : "cursor-pointer"} /></PaginationItem>
                      </PaginationContent>
                    </Pagination>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Batch ── */}
        <TabsContent value="batch">
          <Card>
            <CardHeader>
              <CardTitle>批量操作</CardTitle>
              <CardDescription>跨组邀请/移除，或针对指定组批量操作</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2">
                <Select value={batchMode} onValueChange={(v) => { setBatchMode(v as any); setBatchResult(null); setBatchText(""); }} items={[
                  { label: "跨组邀请", value: "cross-invite" },
                  { label: "跨组移除", value: "cross-remove" },
                  { label: "指定组邀请", value: "group-invite" },
                  { label: "指定组移除", value: "group-remove" },
                ]}>
                  <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="cross-invite">跨组邀请</SelectItem>
                      <SelectItem value="cross-remove">跨组移除</SelectItem>
                      <SelectItem value="group-invite">指定组邀请</SelectItem>
                      <SelectItem value="group-remove">指定组移除</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {(batchMode === "cross-invite" || batchMode === "group-invite") && (
                  <div className="flex items-center gap-1.5">
                    <Label className="text-sm whitespace-nowrap">有效天数</Label>
                    <Input type="number" min={1} value={batchValidDays} onChange={(e) => setBatchValidDays(parseInt(e.target.value) || 30)} className="w-20" />
                  </div>
                )}
                {(batchMode === "group-invite" || batchMode === "group-remove") && (
                  <Select value={batchGroupId} onValueChange={setBatchGroupId} items={groups.map((g) => ({ label: `${g.groupName} (${g.account?.loginEmail})`, value: g.id }))}>
                    <SelectTrigger className="w-64"><SelectValue placeholder="选择家庭组" /></SelectTrigger>
                    <SelectContent><SelectGroup>{groups.map((g) => <SelectItem key={g.id} value={g.id}>{g.groupName} ({g.account?.loginEmail})</SelectItem>)}</SelectGroup></SelectContent>
                  </Select>
                )}
              </div>
              <Textarea rows={6} placeholder="每行一个邮箱" value={batchText} onChange={(e) => setBatchText(e.target.value)} className="font-mono text-sm" />
              <Button onClick={() => void runBatch()} disabled={batchLoading || !batchText.trim()}>
                {batchLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Users className="h-4 w-4 mr-2" />}
                执行 ({parseEmails(batchText).length} 个邮箱)
              </Button>
              {batchResult && (
                <div className="rounded-lg border p-4 space-y-2 text-sm">
                  {batchResult.queued && <div className="text-emerald-500">✅ 已入队：{batchResult.queued.length} 个</div>}
                  {batchResult.notFound?.length > 0 && <div className="text-amber-500">⚠️ 未找到：{batchResult.notFound.join(", ")}</div>}
                  {batchResult.alreadyActive?.length > 0 && <div className="text-muted-foreground">ℹ️ 已在组内：{batchResult.alreadyActive.join(", ")}</div>}
                  {batchResult.alreadyRemoved?.length > 0 && <div className="text-muted-foreground">ℹ️ 已移除：{batchResult.alreadyRemoved.join(", ")}</div>}
                  {batchResult.unplaceable?.length > 0 && <div className="text-destructive">❌ 无法分配：{batchResult.unplaceable.join(", ")}</div>}
                  {batchResult.rejected?.length > 0 && <div className="text-destructive">❌ 被拒绝：{batchResult.rejected.join(", ")}</div>}
                  {batchResult.failed?.length > 0 && <div className="text-destructive">❌ 失败：{batchResult.failed.join(", ")}</div>}
                  {batchResult.reason && <div className="text-destructive">原因：{batchResult.reason}</div>}
                  {batchResult.allocated?.length > 0 && (
                    <div className="space-y-1">
                      {batchResult.allocated.map((a: any, i: number) => (
                        <div key={i} className="text-xs text-muted-foreground">组 {a.groupId.slice(0, 8)}: {a.queued.join(", ")}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Create ── */}
        {canManage && (
          <TabsContent value="create">
            <Card>
              <CardHeader><CardTitle>新增家庭组</CardTitle></CardHeader>
              <CardContent>
                <form className="space-y-4" onSubmit={handleCreate}>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <Label>所属母号</Label>
                      <Select value={createForm.accountId} onValueChange={(v) => setCreateForm((f) => ({ ...f, accountId: v }))} items={accounts.map((a) => ({ label: `${a.name} (${a.loginEmail})`, value: a.id }))}>
                        <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectGroup>{accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name} ({a.loginEmail})</SelectItem>)}</SelectGroup></SelectContent>
                      </Select>
                    </div>
                    <div><Label>组名称</Label><Input required value={createForm.groupName} onChange={(e) => setCreateForm((f) => ({ ...f, groupName: e.target.value }))} className="mt-1" /></div>
                    <div><Label>最大成员数</Label><Input type="number" min={1} max={6} value={createForm.maxMembers} onChange={(e) => setCreateForm((f) => ({ ...f, maxMembers: e.target.value }))} className="mt-1" /></div>
                  </div>
                  <Button type="submit"><Plus className="h-4 w-4 mr-2" />创建家庭组</Button>
                </form>
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {/* ── Remove member dialog ── */}
      <Dialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>移除成员</DialogTitle><DialogDescription>从家庭组中移除 {removeEmail}</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="outline" onClick={() => setRemoveDialogOpen(false)}>取消</Button><Button variant="destructive" onClick={() => void handleRemoveMember()}>确认移除</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Replace member dialog ── */}
      <Dialog open={replaceDialogOpen} onOpenChange={setReplaceDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>替换成员</DialogTitle><DialogDescription>移除 {replaceTargetEmail} 并邀请新成员</DialogDescription></DialogHeader>
          <div className="py-4"><Label>新成员邮箱</Label><Input type="email" placeholder="new-member@gmail.com" value={replaceNewEmail} onChange={(e) => setReplaceNewEmail(e.target.value.trim().toLowerCase())} className="mt-2" /></div>
          <DialogFooter><Button variant="outline" onClick={() => setReplaceDialogOpen(false)}>取消</Button><Button onClick={() => void handleReplaceMember()} disabled={!replaceNewEmail}>确认替换</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Edit expiry dialog ── */}
      <Dialog open={editExpiryOpen} onOpenChange={setEditExpiryOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>编辑到期时间</DialogTitle><DialogDescription>{editExpiryEmail}</DialogDescription></DialogHeader>
          <div className="py-4">
            <Label>到期日期</Label>
            <Input type="date" value={editExpiryValue} onChange={(e) => setEditExpiryValue(e.target.value)} className="mt-2" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditExpiryOpen(false)}>取消</Button>
            <Button variant="outline" onClick={() => { setEditExpiryValue(""); }}>清除到期</Button>
            <Button onClick={() => void handleEditExpiry()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Duplicate members dialog ── */}
      <Dialog open={duplicateDialogOpen} onOpenChange={setDuplicateDialogOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-orange-500" />重复成员检测</DialogTitle>
            <DialogDescription>以下成员出现在多个自动分配的家庭组中（仅 ACTIVE 组）</DialogDescription>
          </DialogHeader>
          {duplicateMembers.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">没有发现重复成员 ✅</p>
          ) : (
            <div className="space-y-4 py-4">
              {duplicateMembers.map((dup) => (
                <div key={dup.email} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-medium text-sm">{dup.email}</div>
                    <Badge variant="destructive" className="text-xs">出现 {dup.count} 次</Badge>
                  </div>
                  <div className="space-y-1">
                    {dup.groups.map((g) => (
                      <div key={g.groupId} className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-medium">{g.groupName}</span>
                        <Badge variant="outline" className="text-xs">{g.memberStatus}</Badge>
                        {g.joinedAt && <span>{fmtDate(g.joinedAt)}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Migrate member dialog ── */}
      <Dialog open={migrateDialogOpen} onOpenChange={setMigrateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>迁移成员</DialogTitle>
            <DialogDescription>
              将 <span className="font-medium">{migrateEmail}</span> 从当前组中移除（数据库直接操作），然后自动邀请到其他有空位的组
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMigrateDialogOpen(false)}>取消</Button>
            <Button onClick={() => void handleMigrateMember()} disabled={migrateLoading}>
              {migrateLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <ArrowUpDown className="h-4 w-4 mr-2" />}
              确认迁移
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
