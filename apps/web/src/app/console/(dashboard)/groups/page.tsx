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
  RotateCcw, ToggleLeft, ToggleRight, Users, Search,
} from "lucide-react";

type MemberInfo = { id: string; email: string; displayName?: string | null; role: string; status: string; isInGroup?: boolean; joinedAt?: string | null; expiresAt?: string | null; googleMemberId?: string | null };
type GroupDetail = { members?: MemberInfo[]; invites?: { id: string; email: string; status: string; createdAt: string }[] };

function fmtDate(d?: string | null) { return d ? new Date(d).toLocaleDateString("zh-CN") : "—"; }
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
  const [currentGroupPage, setCurrentGroupPage] = useState(1);

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

  // Create form
  const [createForm, setCreateForm] = useState({ accountId: "", groupName: "", maxMembers: "5" });

  // Batch operations
  const [batchMode, setBatchMode] = useState<"cross-invite" | "cross-remove" | "group-invite" | "group-remove">("cross-invite");
  const [batchText, setBatchText] = useState("");
  const [batchGroupId, setBatchGroupId] = useState("");
  const [batchValidDays, setBatchValidDays] = useState(30);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchResult, setBatchResult] = useState<any>(null);

  const loadData = useCallback(async () => {
    try {
      const [acc, grp] = await Promise.all([
        apiRequest<AccountSummary[]>("accounts"),
        apiRequest<FamilyGroupSummary[]>("family-groups"),
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
    const matchSearch = !q || g.groupName.toLowerCase().includes(q) || g.account?.loginEmail?.toLowerCase().includes(q);
    const matchStatus = filterStatus === "ALL" || g.syncStatus === filterStatus;
    return matchSearch && matchStatus;
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
            <Input placeholder="搜索组名 / 母号…" value={searchTerm} onChange={(e) => { setSearchTerm(e.target.value); setCurrentGroupPage(1); }} className="w-56" />
            <Select value={filterStatus} onValueChange={(v) => { setFilterStatus(v); setCurrentGroupPage(1); }} items={[
              { label: "全部", value: "ALL" },
              { label: "已同步", value: "SYNCED" },
              { label: "未同步", value: "NEVER_SYNCED" },
              { label: "异常", value: "ERROR" },
            ]}>
              <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="ALL">全部</SelectItem>
                  <SelectItem value="SYNCED">已同步</SelectItem>
                  <SelectItem value="NEVER_SYNCED">未同步</SelectItem>
                  <SelectItem value="ERROR">异常</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={loadData} disabled={loading}><RefreshCw className="h-4 w-4" /></Button>
          </div>
        </div>

        {/* ── Inventory ── */}
        <TabsContent value="inventory">
          <Card>
            <CardHeader>
              <CardTitle>家庭组库存</CardTitle>
              <CardDescription>{filtered.length} / {groups.length} 组{totalGroupPages > 0 && ` · 第 ${currentGroupPage}/${totalGroupPages} 页`}</CardDescription>
            </CardHeader>
            <CardContent>
              {paginated.length === 0 ? (
                <p className="text-center text-muted-foreground py-12">没有匹配的家庭组</p>
              ) : (
                <div className="space-y-2">
                  {paginated.map((g) => {
                    const isExpanded = expandedGroupId === g.id;
                    const isSyncing = syncingGroupId === g.id;
                    return (
                      <Collapsible key={g.id} open={isExpanded} onOpenChange={() => toggleGroupDetail(g.id)}>
                        <div className="rounded-lg border p-3">
                          <CollapsibleTrigger nativeButton={false} render={<div className="flex items-center justify-between cursor-pointer" />}>
                              <div className="flex items-center gap-3">
                                {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                                <div>
                                  <div className="font-medium">{g.groupName}</div>
                                  <div className="text-xs text-muted-foreground">{g.account?.loginEmail ?? "—"} · {g.account?.name}</div>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <div className="text-right mr-2">
                                  <div className="text-sm font-semibold tabular-nums">{g.memberCount}/{g.maxMembers}</div>
                                  <div className="text-xs text-muted-foreground">{g.availableSlots} 空位</div>
                                </div>
                                <Badge variant={statusVar(g.syncStatus ?? "NEVER_SYNCED")} className="text-xs">{g.syncStatus ?? "NEVER_SYNCED"}</Badge>
                                <Badge variant={g.autoAssignEnabled ? "default" : "outline"} className="text-xs">{g.autoAssignEnabled ? "自动分配" : "手动"}</Badge>
                              </div>
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            <div className="mt-3 pt-3 border-t space-y-3">
                              {/* Action buttons */}
                              <div className="flex gap-2 flex-wrap">
                                <AlertDialog>
                                  <AlertDialogTrigger render={<Button variant="outline" size="sm" disabled={isSyncing} />}>
                                    {isSyncing ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <RotateCcw className="h-3.5 w-3.5 mr-1" />}同步
                                  </AlertDialogTrigger>
                                  <AlertDialogContent>
                                    <AlertDialogHeader><AlertDialogTitle>同步 {g.groupName}？</AlertDialogTitle></AlertDialogHeader>
                                    <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => void handleSync(g.id)}>确认</AlertDialogAction></AlertDialogFooter>
                                  </AlertDialogContent>
                                </AlertDialog>
                                <Button variant="outline" size="sm" onClick={() => void handleToggleAutoAssign(g.id)}>
                                  {g.autoAssignEnabled ? <ToggleRight className="h-3.5 w-3.5 mr-1" /> : <ToggleLeft className="h-3.5 w-3.5 mr-1" />}
                                  {g.autoAssignEnabled ? "关闭自动分配" : "开启自动分配"}
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
                                            <TableHead className="w-24">加入</TableHead>
                                            <TableHead className="w-24">到期</TableHead>
                                            {canManage && <TableHead className="w-24 text-right">操作</TableHead>}
                                          </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                          {groupDetail.members!.map((m) => (
                                            <TableRow key={m.id}>
                                              <TableCell className="text-sm">{m.email}{m.displayName && <span className="text-muted-foreground ml-1">({m.displayName})</span>}</TableCell>
                                              <TableCell><Badge variant="outline" className="text-xs">{m.role === "OWNER" ? "管理" : "成员"}</Badge></TableCell>
                                              <TableCell><Badge variant={statusVar(m.status)} className="text-xs">{m.status}</Badge></TableCell>
                                              <TableCell className="text-xs text-muted-foreground">{fmtDate(m.joinedAt)}</TableCell>
                                              <TableCell className={`text-xs ${m.expiresAt && new Date(m.expiresAt) < new Date() ? "text-destructive font-medium" : "text-muted-foreground"}`}>{fmtDate(m.expiresAt)}</TableCell>
                                              {canManage && m.role !== "OWNER" && (
                                                <TableCell className="text-right">
                                                  <div className="flex items-center justify-end gap-1">
                                                    <Button variant="ghost" size="sm" className="h-7 text-destructive" onClick={() => { setRemoveGroupId(g.id); setRemoveEmail(m.email); setRemoveDialogOpen(true); }}>
                                                      <UserMinus className="h-3 w-3" />
                                                    </Button>
                                                    <Button variant="ghost" size="sm" className="h-7" onClick={() => { setReplaceGroupId(g.id); setReplaceTargetEmail(m.email); setReplaceNewEmail(""); setReplaceDialogOpen(true); }}>
                                                      <ArrowLeftRight className="h-3 w-3" />
                                                    </Button>
                                                  </div>
                                                </TableCell>
                                              )}
                                              {canManage && m.role === "OWNER" && <TableCell />}
                                            </TableRow>
                                          ))}
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
    </>
  );
}
