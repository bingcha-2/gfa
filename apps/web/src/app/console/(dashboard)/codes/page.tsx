"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useConsole } from "@/components/console-provider";
import { apiRequest, getErrorMessage } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";
import { canManageCodes } from "@/lib/permissions";
import type { RedeemCodeSummary } from "@/lib/types";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  Pagination, PaginationContent, PaginationItem, PaginationLink,
  PaginationNext, PaginationPrevious, PaginationEllipsis,
} from "@/components/ui/pagination";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  Ticket, Plus, Copy, Download, RefreshCw, Ban, Trash2, Loader2, CheckCircle2,
} from "lucide-react";

const PAGE_SIZE = 30;
const CODE_TYPE_LABELS: Record<string, string> = { JOIN_GROUP: "邀请码(JZ)", ACCOUNT_SWAP: "换号码(HH)", SUBSCRIPTION: "长效换号码(CX)" };

function statusVariant(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (s === "UNUSED") return "default";
  if (s === "REDEEMED") return "secondary";
  if (s === "DISABLED" || s === "EXPIRED") return "destructive";
  return "outline";
}

function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export default function CodesPage() {
  const { user } = useConsole();
  const canManage = canManageCodes(user.role);

  const [codes, setCodes] = useState<RedeemCodeSummary[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [stats, setStats] = useState({ unused: 0, types: { ALL: 0, JOIN_GROUP: 0, ACCOUNT_SWAP: 0, SUBSCRIPTION: 0 } });
  const [isLoading, setIsLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Create form
  const [form, setForm] = useState({
    count: "10", product: "GOOGLE_ONE",
    codeType: "JOIN_GROUP" as "JOIN_GROUP" | "ACCOUNT_SWAP" | "SUBSCRIPTION",
    validDays: "30", swapLimit: "2", swapWindowHours: "5",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      let url = `redeem-codes?page=${currentPage}&pageSize=${PAGE_SIZE}${typeFilter !== "ALL" ? `&codeType=${typeFilter}` : ""}`;
      if (searchTerm) url += `&search=${encodeURIComponent(searchTerm)}`;
      const res = await apiRequest<{ items: RedeemCodeSummary[]; total: number; stats: any }>(url);
      setCodes(res.items);
      setTotalItems(res.total);
      if (res.stats) setStats(res.stats);
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally { setIsLoading(false); }
  }, [currentPage, typeFilter, searchTerm]);

  useEffect(() => { loadData(); }, [loadData]);

  function handleSearchInput(value: string) {
    setSearchInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { setSearchTerm(value.trim()); setCurrentPage(1); }, 400);
  }

  async function handleCreate() {
    setIsSubmitting(true);
    try {
      const payload: any = {
        count: parseInt(form.count) || 10,
        codeType: form.codeType,
        product: form.product,
      };
      if (form.codeType === "SUBSCRIPTION") {
        payload.validDays = parseInt(form.validDays) || 30;
        payload.swapLimit = parseInt(form.swapLimit) || 2;
        payload.swapWindowHours = parseInt(form.swapWindowHours) || 5;
      }
      const created = await apiRequest<RedeemCodeSummary[]>("redeem-codes/batch-create", { method: "POST", body: payload });
      const generatedCodes = created.map((c) => c.code);
      setNewCodes(generatedCodes);
      toast.success(`成功生成 ${generatedCodes.length} 个卡密`);
      await loadData();
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally { setIsSubmitting(false); }
  }

  async function handleDisable(codeId: string) {
    try {
      await apiRequest(`redeem-codes/${codeId}/disable`, { method: "PATCH" });
      setCodes((prev) => prev.map((c) => c.id === codeId ? { ...c, status: "DISABLED" } : c));
      toast.success("卡密已禁用");
    } catch (err) { toast.error(getErrorMessage(err)); }
  }

  async function handleDelete(codeId: string) {
    try {
      await apiRequest(`redeem-codes/${codeId}`, { method: "DELETE" });
      setCodes((prev) => prev.filter((c) => c.id !== codeId));
      toast.success("卡密已删除");
    } catch (err) { toast.error(getErrorMessage(err)); }
  }

  async function copyText(text: string) {
    try { await navigator.clipboard.writeText(text); toast.success("已复制到剪贴板"); }
    catch { toast.error("复制失败"); }
  }

  const totalPages = Math.ceil(totalItems / PAGE_SIZE);

  function renderPagination() {
    if (totalPages <= 1) return null;
    const pages: (number | "ellipsis")[] = [];
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || (i >= currentPage - 2 && i <= currentPage + 2)) pages.push(i);
      else if (pages[pages.length - 1] !== "ellipsis") pages.push("ellipsis");
    }
    return (
      <Pagination className="mt-4">
        <PaginationContent>
          <PaginationItem><PaginationPrevious onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} className={currentPage <= 1 ? "pointer-events-none opacity-50" : "cursor-pointer"} /></PaginationItem>
          {pages.map((p, idx) => p === "ellipsis" ? <PaginationItem key={`e-${idx}`}><PaginationEllipsis /></PaginationItem> : (
            <PaginationItem key={p}><PaginationLink isActive={p === currentPage} onClick={() => setCurrentPage(p)} className="cursor-pointer">{p}</PaginationLink></PaginationItem>
          ))}
          <PaginationItem><PaginationNext onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} className={currentPage >= totalPages ? "pointer-events-none opacity-50" : "cursor-pointer"} /></PaginationItem>
        </PaginationContent>
      </Pagination>
    );
  }

  return (
    <>
      {/* Stats row */}
      <div className="grid gap-4 mb-6 md:grid-cols-4">
        {[
          { label: "全部", count: stats.types.ALL, active: typeFilter === "ALL", onClick: () => { setTypeFilter("ALL"); setCurrentPage(1); } },
          { label: "邀请码(JZ)", count: stats.types.JOIN_GROUP, active: typeFilter === "JOIN_GROUP", onClick: () => { setTypeFilter("JOIN_GROUP"); setCurrentPage(1); } },
          { label: "换号码(HH)", count: stats.types.ACCOUNT_SWAP, active: typeFilter === "ACCOUNT_SWAP", onClick: () => { setTypeFilter("ACCOUNT_SWAP"); setCurrentPage(1); } },
          { label: "长效换号码(CX)", count: stats.types.SUBSCRIPTION, active: typeFilter === "SUBSCRIPTION", onClick: () => { setTypeFilter("SUBSCRIPTION"); setCurrentPage(1); } },
        ].map((s) => (
          <Card key={s.label} className={`cursor-pointer transition-colors ${s.active ? "border-primary" : "hover:border-muted-foreground/30"}`} onClick={s.onClick}>
            <CardHeader className="pb-2"><CardDescription>{s.label}</CardDescription></CardHeader>
            <CardContent><div className="text-2xl font-bold tabular-nums">{s.count}</div></CardContent>
          </Card>
        ))}
      </div>

      <Tabs defaultValue="inventory">
        <div className="flex items-center justify-between mb-4">
          <TabsList>
            <TabsTrigger value="inventory">卡密列表</TabsTrigger>
            {canManage && <TabsTrigger value="create">批量生成</TabsTrigger>}
          </TabsList>
          <div className="flex items-center gap-2">
            <Input placeholder="搜索卡密码 / 邮箱…" value={searchInput} onChange={(e) => handleSearchInput(e.target.value)} className="w-64" />
            <Button variant="outline" size="sm" onClick={loadData} disabled={isLoading}>
              <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        <TabsContent value="inventory">
          <Card>
            <CardHeader>
              <CardTitle>卡密列表</CardTitle>
              <CardDescription>共 {totalItems} 条 · 未使用 {stats.unused}</CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="space-y-3">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
              ) : codes.length === 0 ? (
                <p className="text-center text-muted-foreground py-12">没有匹配的卡密</p>
              ) : (
                <>
                  <div className="rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>卡密码</TableHead>
                          <TableHead className="w-20">类型</TableHead>
                          <TableHead className="w-20">状态</TableHead>
                          <TableHead>绑定邮箱</TableHead>
                          <TableHead className="w-36">创建时间</TableHead>
                          {canManage && <TableHead className="w-28 text-right">操作</TableHead>}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {codes.map((code) => (
                          <TableRow key={code.id}>
                            <TableCell>
                              <div className="flex items-center gap-1.5">
                                <code className="text-sm font-mono">{code.code}</code>
                                <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => void copyText(code.code)}>
                                  <Copy className="h-3 w-3" />
                                </Button>
                              </div>
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className="text-xs">{CODE_TYPE_LABELS[code.codeType] ?? code.codeType}</Badge>
                            </TableCell>
                            <TableCell>
                              <Badge variant={statusVariant(code.status)} className="text-xs">{code.status}</Badge>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">{code.redeemedBy ?? "—"}</TableCell>
                            <TableCell className="text-sm text-muted-foreground whitespace-nowrap">{formatDateTime(code.createdAt)}</TableCell>
                            {canManage && (
                              <TableCell className="text-right">
                                <div className="flex items-center justify-end gap-1">
                                  {code.status === "UNUSED" && (
                                    <AlertDialog>
                                      <AlertDialogTrigger render={<Button variant="ghost" size="sm" className="h-7" />}>
                                        <Ban className="h-3 w-3" />
                                      </AlertDialogTrigger>
                                      <AlertDialogContent>
                                        <AlertDialogHeader><AlertDialogTitle>禁用卡密？</AlertDialogTitle><AlertDialogDescription>卡密 {code.code} 将无法被使用。</AlertDialogDescription></AlertDialogHeader>
                                        <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => void handleDisable(code.id)}>确认禁用</AlertDialogAction></AlertDialogFooter>
                                      </AlertDialogContent>
                                    </AlertDialog>
                                  )}
                                  <AlertDialog>
                                    <AlertDialogTrigger render={<Button variant="ghost" size="sm" className="h-7 text-destructive" />}>
                                      <Trash2 className="h-3 w-3" />
                                    </AlertDialogTrigger>
                                    <AlertDialogContent>
                                      <AlertDialogHeader><AlertDialogTitle>删除卡密？</AlertDialogTitle><AlertDialogDescription>不可恢复。</AlertDialogDescription></AlertDialogHeader>
                                      <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => void handleDelete(code.id)}>确认删除</AlertDialogAction></AlertDialogFooter>
                                    </AlertDialogContent>
                                  </AlertDialog>
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

        {canManage && (
          <TabsContent value="create">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Ticket className="h-5 w-5" />批量生成卡密</CardTitle>
                <CardDescription>生成指定数量和类型的兑换码</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  <div>
                    <Label>卡密类型</Label>
                    <Select value={form.codeType} onValueChange={(v) => setForm((f) => ({ ...f, codeType: v as any }))} items={[
                      { label: "邀请码(JZ)", value: "JOIN_GROUP" },
                      { label: "换号码(HH)", value: "ACCOUNT_SWAP" },
                      { label: "长效换号码(CX)", value: "SUBSCRIPTION" },
                    ]}>
                      <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="JOIN_GROUP">邀请码(JZ)</SelectItem>
                          <SelectItem value="ACCOUNT_SWAP">换号码(HH)</SelectItem>
                          <SelectItem value="SUBSCRIPTION">长效换号码(CX)</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                  <div><Label>数量</Label><Input type="number" min={1} max={200} value={form.count} onChange={(e) => setForm((f) => ({ ...f, count: e.target.value }))} className="mt-1" /></div>
                  <div><Label>产品线</Label><Input value={form.product} onChange={(e) => setForm((f) => ({ ...f, product: e.target.value }))} className="mt-1" /></div>
                  {form.codeType === "SUBSCRIPTION" && (
                    <>
                      <div><Label>有效期(天)</Label><Input type="number" min={1} value={form.validDays} onChange={(e) => setForm((f) => ({ ...f, validDays: e.target.value }))} className="mt-1" /></div>
                      <div><Label>换号上限(次/窗口)</Label><Input type="number" min={1} value={form.swapLimit} onChange={(e) => setForm((f) => ({ ...f, swapLimit: e.target.value }))} className="mt-1" /></div>
                      <div><Label>换号窗口(小时)</Label><Input type="number" min={1} value={form.swapWindowHours} onChange={(e) => setForm((f) => ({ ...f, swapWindowHours: e.target.value }))} className="mt-1" /></div>
                    </>
                  )}
                </div>
                <Button onClick={() => void handleCreate()} disabled={isSubmitting} className="w-full">
                  {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
                  生成 {form.count} 个卡密
                </Button>
              </CardContent>
            </Card>

            {/* Generated codes dialog */}
            <Dialog open={!!newCodes} onOpenChange={() => setNewCodes(null)}>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2"><CheckCircle2 className="h-5 w-5 text-emerald-500" />生成成功</DialogTitle>
                  <DialogDescription>共 {newCodes?.length ?? 0} 个卡密</DialogDescription>
                </DialogHeader>
                <div className="space-y-3 py-4">
                  <div className="max-h-[300px] overflow-y-auto rounded border p-3">
                    <pre className="text-sm font-mono whitespace-pre-wrap break-all">{newCodes?.join("\n")}</pre>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" className="flex-1" onClick={() => void copyText(newCodes?.join("\n") ?? "")}>
                      <Copy className="h-4 w-4 mr-2" />复制全部
                    </Button>
                    <Button variant="outline" className="flex-1" onClick={() => downloadText(`codes-${Date.now()}.txt`, newCodes?.join("\n") ?? "")}>
                      <Download className="h-4 w-4 mr-2" />下载 TXT
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </TabsContent>
        )}
      </Tabs>
    </>
  );
}
