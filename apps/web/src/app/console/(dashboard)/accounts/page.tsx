"use client";

import { useState, useEffect, useCallback } from "react";
import { useConsole } from "@/components/console-provider";
import { apiRequest, getErrorMessage } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";
import { canCreateAccount } from "@/lib/permissions";
import type { AccountSummary } from "@/lib/types";
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
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  Pagination, PaginationContent, PaginationItem, PaginationLink,
  PaginationNext, PaginationPrevious, PaginationEllipsis,
} from "@/components/ui/pagination";
import {
  RefreshCw, Plus, Upload, Pencil, Trash2, Loader2, CheckCircle2,
  ShieldCheck, KeyRound, RotateCcw,
} from "lucide-react";

const PAGE_SIZE = 20;

function statusBadgeVariant(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (s === "HEALTHY") return "default";
  if (s === "LOGIN_REQUIRED" || s === "VERIFICATION_REQUIRED" || s === "MANUAL_REVIEW" || s === "RISKY") return "outline";
  if (s === "DISABLED" || s === "MANUAL_ONLY") return "destructive";
  return "secondary";
}

function subBadgeVariant(s: string): "default" | "destructive" | "outline" {
  if (s === "ACTIVE") return "default";
  if (s === "EXPIRED" || s === "SUSPENDED") return "destructive";
  return "outline";
}

export default function AccountsPage() {
  const { user, refreshStats } = useConsole();
  const canManage = canCreateAccount(user.role);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Filters
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState("ALL");
  const [filterSub, setFilterSub] = useState("ALL");
  const [currentPage, setCurrentPage] = useState(1);

  // Edit sheet
  const [editAccount, setEditAccount] = useState<AccountSummary | null>(null);
  const [editForm, setEditForm] = useState({
    name: "", adspowerProfileId: "", loginPassword: "", totpSecret: "", notes: "",
    subscriptionExpiresAt: "", subscriptionPlan: "",
  });
  const [isEditSubmitting, setIsEditSubmitting] = useState(false);

  // Create form
  const [createForm, setCreateForm] = useState({
    name: "", loginEmail: "", adspowerProfileId: "", loginPassword: "", totpSecret: "", notes: "",
  });
  const [isCreateSubmitting, setIsCreateSubmitting] = useState(false);

  // Bulk import
  const [bulkText, setBulkText] = useState("");
  const [bulkExpiry, setBulkExpiry] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() + 1); return d.toISOString().split("T")[0];
  });
  const [isBulkSubmitting, setIsBulkSubmitting] = useState(false);
  const [bulkResult, setBulkResult] = useState<any>(null);

  const loadAccounts = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await apiRequest<AccountSummary[]>("accounts");
      setAccounts(data);
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally { setIsLoading(false); }
  }, []);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  // Filtered + paginated
  const filtered = accounts.filter((a) => {
    const q = searchTerm.toLowerCase();
    const matchSearch = !q || a.name.toLowerCase().includes(q) || a.loginEmail.toLowerCase().includes(q) || a.adspowerProfileId.toLowerCase().includes(q);
    let matchStatus = filterStatus === "ALL" || a.status === filterStatus;
    if (filterStatus === "PASSWORD_ERROR") matchStatus = (a as any).syncError === "PASSWORD_ERROR" || a.status === "MANUAL_ONLY";
    if (filterStatus === "CAPTCHA") matchStatus = (a as any).syncError === "CAPTCHA_REQUIRED" || a.status === "VERIFICATION_REQUIRED";
    const matchSub = filterSub === "ALL" || (a.subscriptionStatus ?? "未知") === filterSub;
    return matchSearch && matchStatus && matchSub;
  });
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  function startEdit(account: AccountSummary) {
    setEditAccount(account);
    let expiresDate = "";
    if (account.subscriptionExpiresAt) {
      try { expiresDate = new Date(account.subscriptionExpiresAt).toISOString().split("T")[0]; } catch {}
    }
    setEditForm({
      name: account.name, adspowerProfileId: account.adspowerProfileId,
      loginPassword: account.loginPassword ?? "", totpSecret: account.totpSecret ?? "",
      notes: (account as any).notes ?? "",
      subscriptionExpiresAt: expiresDate, subscriptionPlan: (account as any).subscriptionPlan ?? "",
    });
  }

  async function handleEditSave() {
    if (!editAccount) return;
    setIsEditSubmitting(true);
    try {
      await apiRequest(`accounts/${editAccount.id}`, {
        method: "PATCH", body: {
          name: editForm.name, adspowerProfileId: editForm.adspowerProfileId,
          loginPassword: editForm.loginPassword || undefined, totpSecret: editForm.totpSecret || undefined,
          notes: editForm.notes || undefined, subscriptionExpiresAt: editForm.subscriptionExpiresAt || "",
          subscriptionPlan: editForm.subscriptionPlan || "",
        },
      });
      toast.success("母号已更新"); setEditAccount(null); await loadAccounts();
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally { setIsEditSubmitting(false); }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setIsCreateSubmitting(true);
    try {
      await apiRequest("accounts", { method: "POST", body: createForm });
      toast.success("母号创建成功");
      setCreateForm({ name: "", loginEmail: "", adspowerProfileId: "", loginPassword: "", totpSecret: "", notes: "" });
      await loadAccounts(); await refreshStats();
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally { setIsCreateSubmitting(false); }
  }

  async function handleBulkImport() {
    setIsBulkSubmitting(true); setBulkResult(null);
    try {
      const lines = bulkText.split("\n").map((l) => l.trim()).filter(Boolean);
      const result = await apiRequest<any>("accounts/bulk-import", {
        method: "POST", body: { lines, subscriptionExpiresAt: bulkExpiry || undefined },
      });
      setBulkResult(result);
      if (result.created > 0) { toast.success(`成功导入 ${result.created} 个母号`); setBulkText(""); await loadAccounts(); await refreshStats(); }
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally { setIsBulkSubmitting(false); }
  }

  async function handleDelete(id: string) {
    try {
      await apiRequest(`accounts/${id}`, { method: "DELETE" });
      toast.success("母号已删除"); await loadAccounts(); await refreshStats();
    } catch (err) { toast.error(getErrorMessage(err)); }
  }

  async function handleConfirmLogin(id: string) {
    try {
      await apiRequest(`accounts/${id}/confirm-login`, { method: "POST" });
      toast.success("已确认登录"); await loadAccounts();
    } catch (err) { toast.error(getErrorMessage(err)); }
  }

  async function handleSync(id: string) {
    try {
      await apiRequest(`accounts/${id}/sync`, { method: "POST" });
      toast.success("同步任务已调度"); await loadAccounts();
    } catch (err) { toast.error(getErrorMessage(err)); }
  }

  function renderPagination() {
    if (totalPages <= 1) return null;
    const pages: (number | "e")[] = [];
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || (i >= currentPage - 2 && i <= currentPage + 2)) pages.push(i);
      else if (pages[pages.length - 1] !== "e") pages.push("e");
    }
    return (
      <Pagination className="mt-4">
        <PaginationContent>
          <PaginationItem><PaginationPrevious onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} className={currentPage <= 1 ? "pointer-events-none opacity-50" : "cursor-pointer"} /></PaginationItem>
          {pages.map((p, idx) => p === "e" ? <PaginationItem key={`e-${idx}`}><PaginationEllipsis /></PaginationItem> : (
            <PaginationItem key={p}><PaginationLink isActive={p === currentPage} onClick={() => setCurrentPage(p)} className="cursor-pointer">{p}</PaginationLink></PaginationItem>
          ))}
          <PaginationItem><PaginationNext onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} className={currentPage >= totalPages ? "pointer-events-none opacity-50" : "cursor-pointer"} /></PaginationItem>
        </PaginationContent>
      </Pagination>
    );
  }

  return (
    <>
      <Tabs defaultValue="list">
        {/* Header bar */}
        <div className="flex items-center justify-between mb-4">
          <TabsList>
            <TabsTrigger value="list">母号列表</TabsTrigger>
            {canManage && <TabsTrigger value="create">新增母号</TabsTrigger>}
            {canManage && <TabsTrigger value="bulk">批量导入</TabsTrigger>}
          </TabsList>
          <div className="flex items-center gap-2">
            <Input placeholder="搜索名称 / 邮箱 / Profile…" value={searchTerm} onChange={(e) => { setSearchTerm(e.target.value); setCurrentPage(1); }} className="w-56" />
            <Select value={filterStatus} onValueChange={(v) => { setFilterStatus(v); setCurrentPage(1); }} items={[
              { label: "全部状态", value: "ALL" },
              { label: "🟢 活跃", value: "HEALTHY" },
              { label: "🔑 需登录", value: "LOGIN_REQUIRED" },
              { label: "⚠️ 需验证", value: "VERIFICATION_REQUIRED" },
              { label: "⏸ 仅手动", value: "MANUAL_ONLY" },
              { label: "🚫 禁用", value: "DISABLED" },
              { label: "🔴 密码错", value: "PASSWORD_ERROR" },
              { label: "🤖 人机", value: "CAPTCHA" },
            ]}>
              <SelectTrigger className="w-32"><SelectValue placeholder="状态" /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="ALL">全部状态</SelectItem>
                  <SelectItem value="HEALTHY">🟢 活跃</SelectItem>
                  <SelectItem value="LOGIN_REQUIRED">🔑 需登录</SelectItem>
                  <SelectItem value="VERIFICATION_REQUIRED">⚠️ 需验证</SelectItem>
                  <SelectItem value="MANUAL_ONLY">⏸ 仅手动</SelectItem>
                  <SelectItem value="DISABLED">🚫 禁用</SelectItem>
                  <SelectItem value="PASSWORD_ERROR">🔴 密码错</SelectItem>
                  <SelectItem value="CAPTCHA">🤖 人机</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select value={filterSub} onValueChange={(v) => { setFilterSub(v); setCurrentPage(1); }} items={[
              { label: "全部订阅", value: "ALL" },
              { label: "活跃", value: "ACTIVE" },
              { label: "暂停", value: "SUSPENDED" },
              { label: "过期", value: "EXPIRED" },
            ]}>
              <SelectTrigger className="w-28"><SelectValue placeholder="订阅" /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="ALL">全部订阅</SelectItem>
                  <SelectItem value="ACTIVE">活跃</SelectItem>
                  <SelectItem value="SUSPENDED">暂停</SelectItem>
                  <SelectItem value="EXPIRED">过期</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={loadAccounts} disabled={isLoading}>
              <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        {/* List tab */}
        <TabsContent value="list">
          <Card>
            <CardHeader>
              <CardTitle>母号池</CardTitle>
              <CardDescription>{filtered.length} / {accounts.length} 条{totalPages > 0 && ` · 第 ${currentPage}/${totalPages} 页`}</CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="space-y-3">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
              ) : paginated.length === 0 ? (
                <p className="text-center text-muted-foreground py-12">{searchTerm ? "没有匹配的母号" : "还没有录入任何母号"}</p>
              ) : (
                <>
                  <div className="rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>名称</TableHead>
                          <TableHead>登录邮箱</TableHead>
                          <TableHead className="w-28">状态</TableHead>
                          <TableHead>统计</TableHead>
                          {canManage && <TableHead className="text-right">操作</TableHead>}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {paginated.map((a) => (
                          <TableRow key={a.id}>
                            <TableCell>
                              <div className="font-medium">{a.name}</div>
                              <div className="text-xs text-muted-foreground font-mono">{a.adspowerProfileId}</div>
                              {(a as any).notes && <div className="text-xs text-muted-foreground mt-0.5 bg-muted px-1.5 py-0.5 rounded inline-block">备注: {(a as any).notes}</div>}
                            </TableCell>
                            <TableCell className="text-sm">{a.loginEmail}</TableCell>
                            <TableCell>
                              <div className="flex flex-col gap-1">
                                <Badge variant={statusBadgeVariant(a.status)} className="text-xs w-fit">{a.status}</Badge>
                                <Badge variant={a.hasTotpSecret ? "default" : "outline"} className="text-xs w-fit">{a.hasTotpSecret ? "TOTP ✓" : "No TOTP"}</Badge>
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="text-sm">{a._count?.familyGroups ?? 0} 组 · {a._count?.tasks ?? 0} 任务</div>
                              <div className="text-xs text-muted-foreground">
                                登录 {formatDateTime(a.lastLoginAt)} · 到期 {a.subscriptionExpiresAt ? formatDateTime(a.subscriptionExpiresAt) : "未知"}
                              </div>
                              <Badge variant={subBadgeVariant(a.subscriptionStatus ?? "未知")} className="text-xs mt-1">{a.subscriptionStatus ?? "未知"}</Badge>
                            </TableCell>
                            {canManage && (
                              <TableCell className="text-right">
                                <div className="flex items-center justify-end gap-1 flex-wrap">
                                  <Button variant="ghost" size="sm" onClick={() => startEdit(a)}><Pencil className="h-3.5 w-3.5" /></Button>
                                  <AlertDialog>
                                    <AlertDialogTrigger render={<Button variant="ghost" size="sm" className="text-destructive" />}><Trash2 className="h-3.5 w-3.5" /></AlertDialogTrigger>
                                    <AlertDialogContent>
                                      <AlertDialogHeader><AlertDialogTitle>确认删除？</AlertDialogTitle><AlertDialogDescription>删除母号 {a.name}({a.loginEmail})？不可恢复。</AlertDialogDescription></AlertDialogHeader>
                                      <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => void handleDelete(a.id)}>确认</AlertDialogAction></AlertDialogFooter>
                                    </AlertDialogContent>
                                  </AlertDialog>
                                  <AlertDialog>
                                    <AlertDialogTrigger render={<Button variant="ghost" size="sm" className="text-emerald-500" />}><RotateCcw className="h-3.5 w-3.5" /></AlertDialogTrigger>
                                    <AlertDialogContent>
                                      <AlertDialogHeader><AlertDialogTitle>强制同步？</AlertDialogTitle><AlertDialogDescription>将为该母号所有组发起同步，无视冷却期。</AlertDialogDescription></AlertDialogHeader>
                                      <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => void handleSync(a.id)}>确认同步</AlertDialogAction></AlertDialogFooter>
                                    </AlertDialogContent>
                                  </AlertDialog>
                                  {(a.status === "MANUAL_REVIEW" || a.status === "VERIFICATION_REQUIRED" || a.status === "LOGIN_REQUIRED") && (
                                    <AlertDialog>
                                      <AlertDialogTrigger render={<Button variant="ghost" size="sm" className="text-amber-500" />}><ShieldCheck className="h-3.5 w-3.5" /></AlertDialogTrigger>
                                      <AlertDialogContent>
                                        <AlertDialogHeader><AlertDialogTitle>确认已登录？</AlertDialogTitle><AlertDialogDescription>确认已在 AdsPower 中手动登录该账号。</AlertDialogDescription></AlertDialogHeader>
                                        <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => void handleConfirmLogin(a.id)}>确认</AlertDialogAction></AlertDialogFooter>
                                      </AlertDialogContent>
                                    </AlertDialog>
                                  )}
                                </div>
                              </TableCell>
                            )}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  {renderPagination()}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Create tab */}
        {canManage && (
          <TabsContent value="create">
            <Card>
              <CardHeader><CardTitle>新增母号</CardTitle></CardHeader>
              <CardContent>
                <form className="space-y-4" onSubmit={handleCreate}>
                  <div className="grid grid-cols-2 gap-4">
                    <div><Label>母号名称</Label><Input required value={createForm.name} onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))} className="mt-1" /></div>
                    <div><Label>登录邮箱</Label><Input type="email" required value={createForm.loginEmail} onChange={(e) => setCreateForm((f) => ({ ...f, loginEmail: e.target.value.trim() }))} className="mt-1" /></div>
                    <div><Label>AdsPower Profile ID</Label><Input required value={createForm.adspowerProfileId} onChange={(e) => setCreateForm((f) => ({ ...f, adspowerProfileId: e.target.value.trim() }))} className="mt-1" /></div>
                    <div><Label>登录密码</Label><Input type="password" required value={createForm.loginPassword} onChange={(e) => setCreateForm((f) => ({ ...f, loginPassword: e.target.value }))} className="mt-1" /></div>
                    <div><Label>TOTP 密钥</Label><Input placeholder="Base32 格式" value={createForm.totpSecret} onChange={(e) => setCreateForm((f) => ({ ...f, totpSecret: e.target.value.replace(/\s/g, "").toUpperCase() }))} className="mt-1" /></div>
                  </div>
                  <div><Label>备注</Label><Textarea value={createForm.notes} onChange={(e) => setCreateForm((f) => ({ ...f, notes: e.target.value }))} className="mt-1" /></div>
                  <Button type="submit" disabled={isCreateSubmitting}>{isCreateSubmitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}新增母号</Button>
                </form>
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {/* Bulk import tab */}
        {canManage && (
          <TabsContent value="bulk">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Upload className="h-5 w-5" />批量导入</CardTitle>
                <CardDescription>每行一个账号，支持多种分隔格式</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="text-sm font-mono bg-muted rounded-lg p-3 space-y-1">
                  <div><strong>格式 1：</strong>邮箱---密码---辅助邮箱---2FA密钥</div>
                  <div><strong>格式 2：</strong>邮箱——密码——2FA密钥</div>
                  <div className="text-muted-foreground mt-1">字段 3、4 自动识别（含 @ 为辅助邮箱，否则为 2FA）</div>
                </div>
                <div><Label>预设到期时间</Label><Input type="date" value={bulkExpiry} onChange={(e) => setBulkExpiry(e.target.value)} className="mt-1 w-48" /></div>
                <div><Label>账号数据</Label><Textarea rows={8} placeholder={"邮箱----密码----辅助邮箱----2FA密钥\n邮箱——密码——2FA密钥"} value={bulkText} onChange={(e) => setBulkText(e.target.value)} className="mt-1 font-mono text-sm" /></div>
                <Button onClick={() => void handleBulkImport()} disabled={isBulkSubmitting || !bulkText.trim()}>
                  {isBulkSubmitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Upload className="h-4 w-4 mr-2" />}
                  导入 ({bulkText.split("\n").filter((l) => l.trim()).length} 行)
                </Button>
                {bulkResult && (
                  <div className="rounded-lg border p-4 space-y-2 text-sm">
                    <div className="flex gap-4 flex-wrap">
                      <span>总计: <strong>{bulkResult.total}</strong></span>
                      <span className="text-emerald-500">成功: <strong>{bulkResult.created}</strong></span>
                      <span className="text-amber-500">跳过: <strong>{bulkResult.skipped}</strong></span>
                      <span className="text-destructive">错误: <strong>{bulkResult.errorCount}</strong></span>
                    </div>
                    {bulkResult.errors?.length > 0 && (
                      <div className="bg-destructive/10 rounded p-3 max-h-40 overflow-y-auto">
                        {bulkResult.errors.map((e: string, i: number) => <div key={i} className="text-destructive text-xs">{e}</div>)}
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {/* Edit Sheet */}
      <Sheet open={!!editAccount} onOpenChange={(open) => !open && setEditAccount(null)}>
        <SheetContent className="sm:max-w-lg overflow-y-auto">
          {editAccount && (
            <>
              <SheetHeader>
                <SheetTitle>编辑母号</SheetTitle>
                <SheetDescription>{editAccount.loginEmail}</SheetDescription>
              </SheetHeader>
              <div className="mt-6 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div><Label>名称</Label><Input required value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} className="mt-1" /></div>
                  <div><Label>AdsPower Profile ID</Label><Input required value={editForm.adspowerProfileId} onChange={(e) => setEditForm((f) => ({ ...f, adspowerProfileId: e.target.value }))} className="mt-1" /></div>
                  <div><Label>登录密码</Label><Input placeholder="留空不更新" value={editForm.loginPassword} onChange={(e) => setEditForm((f) => ({ ...f, loginPassword: e.target.value }))} className="mt-1" /></div>
                  <div><Label>TOTP 密钥</Label><Input placeholder="留空不更新" value={editForm.totpSecret} onChange={(e) => setEditForm((f) => ({ ...f, totpSecret: e.target.value.replace(/\s/g, "").toUpperCase() }))} className="mt-1" /></div>
                  <div><Label>订阅到期</Label><Input type="date" value={editForm.subscriptionExpiresAt} onChange={(e) => setEditForm((f) => ({ ...f, subscriptionExpiresAt: e.target.value }))} className="mt-1" /></div>
                  <div><Label>订阅计划</Label><Input placeholder="如 AI Ultra 30TB" value={editForm.subscriptionPlan} onChange={(e) => setEditForm((f) => ({ ...f, subscriptionPlan: e.target.value }))} className="mt-1" /></div>
                </div>
                <div><Label>备注</Label><Textarea rows={3} value={editForm.notes} onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))} className="mt-1" /></div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setEditAccount(null)}>取消</Button>
                  <Button onClick={() => void handleEditSave()} disabled={isEditSubmitting}>
                    {isEditSubmitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}保存
                  </Button>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
