"use client";

import { useState, useEffect, useTransition } from "react";
import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
import type { OrderSummary } from "@/lib/console/types";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Clock, Zap, Loader2, AlertTriangle, Users, RefreshCw, Trash2, Save } from "lucide-react";

type ScanStatus = {
  pendingCount: number;
  expiredMemberCount: number;
  lastRunAt: string | null;
  lastRunCount: number;
};
type ScanConfig = {
  intervalMinutes: number;
  options: number[];
};
type ProcessedOrder = { orderId: string; orderNo: string; userEmail: string; familyGroupId: string | null };
type RunResult = { triggered: boolean; processedCount: number; orders: ProcessedOrder[] };

type ExpiredMember = {
  id: string;
  email: string;
  displayName: string | null;
  status: string;
  expiresAt: string;
  joinedAt: string | null;
  familyGroupId: string;
  familyGroup: {
    groupName: string;
    status: string;
    account: {
      id: string;
      name: string;
      loginEmail: string;
      status: string;
      subscriptionStatus: string | null;
      subscriptionExpiresAt: string | null;
    } | null;
  } | null;
  hasRemovalTask: boolean;
};

type BulkRemoveResult = {
  queued: string[];
  notFound: string[];
  alreadyRemoved: string[];
  failed: string[];
};

function fmtDate(iso: string | null | undefined) {
  return iso ? new Date(iso).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "medium" }) : "—";
}

function intervalLabel(minutes: number): string {
  if (minutes === 0) return "从不（已禁用）";
  if (minutes < 60) return `每 ${minutes} 分钟`;
  if (minutes === 60) return "每小时";
  if (minutes < 1440) return `每 ${minutes / 60} 小时`;
  return "每天";
}

function expiredAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);
  if (days > 0) return `已过期 ${days} 天`;
  if (hours > 0) return `已过期 ${hours} 小时`;
  return "刚刚过期";
}

export default function ExpirePage() {
  const [expiredMembers, setExpiredMembers] = useState<ExpiredMember[]>([]);
  const [expiredOrders, setExpiredOrders] = useState<OrderSummary[]>([]);
  const [isLoadingMembers, setIsLoadingMembers] = useState(true);
  const [isLoadingOrders, setIsLoadingOrders] = useState(true);
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isScanning, startScanTransition] = useTransition();
  const [activeTab, setActiveTab] = useState<"members" | "orders">("members");

  // Scan config state
  const [config, setConfig] = useState<ScanConfig | null>(null);
  const [selectedInterval, setSelectedInterval] = useState<number | null>(null);
  const [isSavingConfig, startConfigTransition] = useTransition();

  // Multi-select state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isRemoving, startRemoveTransition] = useTransition();

  async function loadExpiredMembers() {
    setIsLoadingMembers(true);
    try {
      const res = await apiRequest<ExpiredMember[]>("admin/expire-scan/expired-members");
      setExpiredMembers(res);
      setSelectedIds(new Set()); // clear selection on reload
    } catch { /* ignore */ }
    finally { setIsLoadingMembers(false); }
  }

  async function loadExpiredOrders() {
    setIsLoadingOrders(true);
    try {
      const res = await apiRequest<{ items: OrderSummary[]; total: number }>("orders?status=EXPIRED&pageSize=100");
      setExpiredOrders(res.items);
    } catch { /* ignore */ }
    finally { setIsLoadingOrders(false); }
  }

  async function loadStatus() {
    try {
      const data = await apiRequest<ScanStatus>("admin/expire-scan/status");
      setStatus(data);
      setError(null);
    } catch (err) { setError(getErrorMessage(err)); }
  }

  async function loadConfig() {
    try {
      const data = await apiRequest<ScanConfig>("admin/expire-scan/config");
      setConfig(data);
      setSelectedInterval(data.intervalMinutes);
    } catch { /* ignore */ }
  }

  function saveConfig() {
    if (selectedInterval === null) return;
    startConfigTransition(async () => {
      try {
        const data = await apiRequest<ScanConfig>("admin/expire-scan/config", {
          method: "POST",
          body: { intervalMinutes: selectedInterval },
        });
        setConfig(data);
        setSelectedInterval(data.intervalMinutes);
        toast.success("扫描频率已更新为：" + intervalLabel(data.intervalMinutes));
      } catch (err) {
        toast.error(getErrorMessage(err));
      }
    });
  }

  useEffect(() => {
    loadExpiredMembers();
    loadExpiredOrders();
    loadStatus();
    loadConfig();
  }, []);

  function triggerScan() {
    startScanTransition(async () => {
      try {
        const result = await apiRequest<RunResult>("admin/expire-scan/run", { method: "POST" });
        setRunResult(result);
        toast.success(`扫描完成，处理了 ${result.processedCount} 条`);
        const s = await apiRequest<ScanStatus>("admin/expire-scan/status");
        setStatus(s);
        setError(null);
        await loadExpiredMembers();
        await loadExpiredOrders();
      } catch (err) { setError(getErrorMessage(err)); }
    });
  }

  // Selection helpers
  const removableMembers = expiredMembers.filter((m) => !m.hasRemovalTask);
  const allSelected = removableMembers.length > 0 && removableMembers.every((m) => selectedIds.has(m.id));
  const someSelected = selectedIds.size > 0;

  function toggleSelectAll() {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(removableMembers.map((m) => m.id)));
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleBulkRemove() {
    const selectedEmails = expiredMembers
      .filter((m) => selectedIds.has(m.id))
      .map((m) => m.email);

    if (selectedEmails.length === 0) {
      toast.error("请先选择要移除的成员");
      return;
    }

    if (!confirm(`确认移除 ${selectedEmails.length} 个已到期成员？此操作将创建移除任务。`)) {
      return;
    }

    startRemoveTransition(async () => {
      try {
        const result = await apiRequest<BulkRemoveResult>("family-groups/cross-remove", {
          method: "POST",
          body: { memberEmails: selectedEmails },
        });

        const msgs: string[] = [];
        if (result.queued.length > 0) msgs.push(`${result.queued.length} 个已排队移除`);
        if (result.alreadyRemoved.length > 0) msgs.push(`${result.alreadyRemoved.length} 个已移除`);
        if (result.notFound.length > 0) msgs.push(`${result.notFound.length} 个未找到`);
        if (result.failed.length > 0) msgs.push(`${result.failed.length} 个失败`);

        if (result.queued.length > 0) {
          toast.success(msgs.join("，"));
        } else {
          toast.warning(msgs.join("，"));
        }

        // Refresh data
        setSelectedIds(new Set());
        await loadExpiredMembers();
        await loadStatus();
      } catch (err) {
        toast.error(getErrorMessage(err));
      }
    });
  }

  return (
    <div className="space-y-6">
      {error && <Card className="border-destructive"><CardContent className="pt-6 text-destructive text-sm">{error}</CardContent></Card>}

      {/* Top cards */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Expired member count */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Users className="h-5 w-5 text-amber-500" />已到期成员</CardTitle>
            <CardDescription>expiresAt 已过但仍在组内的成员，等待移除</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between py-2 border-b text-sm">
              <span className="text-muted-foreground">待移除成员</span>
              <span className="font-bold text-2xl text-amber-600">{status?.expiredMemberCount ?? "—"}</span>
            </div>
            <div className="flex items-center justify-between py-2 border-b text-sm">
              <span className="text-muted-foreground">待处理到期订单</span>
              <span className="font-bold text-lg">{status?.pendingCount ?? "—"}</span>
            </div>
            <div className="flex items-center justify-between py-2 text-sm">
              <span className="text-muted-foreground">上次扫描</span>
              <span className="font-mono text-sm">{fmtDate(status?.lastRunAt)}</span>
            </div>
          </CardContent>
        </Card>

        {/* Scan trigger */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Zap className="h-5 w-5" />扫描操作</CardTitle>
            <CardDescription>自动扫描到期订单和成员，也可手动立即触发</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => { loadStatus(); loadExpiredMembers(); }}>
                <RefreshCw className="h-4 w-4 mr-2" />刷新状态
              </Button>
              <Button onClick={triggerScan} disabled={isScanning}>
                {isScanning ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Zap className="h-4 w-4 mr-2" />}
                {isScanning ? "扫描中..." : "立即扫描"}
              </Button>
            </div>
            <div className="flex items-center justify-between py-2 border-b text-sm">
              <span className="text-muted-foreground">执行频率</span>
              <div className="flex items-center gap-2">
                {config ? (
                  <>
                    <Select
                      value={String(selectedInterval ?? config.intervalMinutes)}
                      onValueChange={(v) => setSelectedInterval(Number(v))}
                    >
                      <SelectTrigger className="w-[160px] h-8 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {config.options.map((opt) => (
                          <SelectItem key={opt} value={String(opt)}>
                            {intervalLabel(opt)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {selectedInterval !== null && selectedInterval !== config.intervalMinutes && (
                      <Button size="sm" variant="default" className="h-8" onClick={saveConfig} disabled={isSavingConfig}>
                        {isSavingConfig ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                      </Button>
                    )}
                  </>
                ) : (
                  <span className="font-mono text-sm text-muted-foreground">加载中...</span>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between py-2 border-b text-sm">
              <span className="text-muted-foreground">当前状态</span>
              <span className="font-mono font-medium">
                {config
                  ? config.intervalMinutes === 0
                    ? "⏸ 已禁用"
                    : `✅ ${intervalLabel(config.intervalMinutes)}`
                  : "—"}
              </span>
            </div>
            <div className="flex items-center justify-between py-2 text-sm">
              <span className="text-muted-foreground">上次处理</span><span className="font-bold">{status?.lastRunCount ?? "—"} 条</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Run result */}
      {runResult && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">本次扫描结果</CardTitle>
            <CardDescription>共处理 {runResult.processedCount} 条到期记录</CardDescription>
          </CardHeader>
          <CardContent>
            {runResult.orders.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>订单号</TableHead>
                      <TableHead>用户邮箱</TableHead>
                      <TableHead className="w-20">状态</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runResult.orders.map((o) => (
                      <TableRow key={o.orderId}>
                        <TableCell className="font-mono text-sm">{o.orderNo}</TableCell>
                        <TableCell className="text-sm">{o.userEmail}</TableCell>
                        <TableCell><Badge variant="destructive" className="text-xs">EXPIRED</Badge></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="text-center text-muted-foreground py-4">没有需要处理的到期记录</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Tab switcher */}
      <div className="flex gap-2 border-b pb-2">
        <Button
          variant={activeTab === "members" ? "default" : "ghost"}
          size="sm"
          onClick={() => setActiveTab("members")}
        >
          <Users className="h-4 w-4 mr-1" />
          已到期成员 {expiredMembers.length > 0 && <Badge variant="destructive" className="ml-1 text-xs">{expiredMembers.length}</Badge>}
        </Button>
        <Button
          variant={activeTab === "orders" ? "default" : "ghost"}
          size="sm"
          onClick={() => setActiveTab("orders")}
        >
          <Clock className="h-4 w-4 mr-1" />
          历史到期订单 {expiredOrders.length > 0 && <Badge variant="secondary" className="ml-1 text-xs">{expiredOrders.length}</Badge>}
        </Button>
      </div>

      {/* Expired Members Table */}
      {activeTab === "members" && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-amber-500" />已到期成员列表
                </CardTitle>
                <CardDescription className="mt-1.5">以下成员的到期时间已过，但仍在家庭组中，等待移除</CardDescription>
              </div>
              {removableMembers.length > 0 && (
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={!someSelected || isRemoving}
                  onClick={handleBulkRemove}
                >
                  {isRemoving ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : (
                    <Trash2 className="h-4 w-4 mr-2" />
                  )}
                  {isRemoving ? "移除中..." : `移除选中 (${selectedIds.size})`}
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {isLoadingMembers ? (
              <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : expiredMembers.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox
                          checked={allSelected}
                          onCheckedChange={toggleSelectAll}
                          aria-label="全选"
                        />
                      </TableHead>
                      <TableHead>邮箱</TableHead>
                      <TableHead>姓名</TableHead>
                      <TableHead>家庭组</TableHead>
                      <TableHead>母号</TableHead>
                      <TableHead>母号状态</TableHead>
                      <TableHead>到期时间</TableHead>
                      <TableHead>过期时长</TableHead>
                      <TableHead className="w-24">状态</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {expiredMembers.map((m) => {
                      const isRemovable = !m.hasRemovalTask;
                      const isSelected = selectedIds.has(m.id);
                      return (
                        <TableRow
                          key={m.id}
                          className={isSelected ? "bg-muted/50" : undefined}
                          data-state={isSelected ? "selected" : undefined}
                        >
                          <TableCell>
                            <Checkbox
                              checked={isSelected}
                              disabled={!isRemovable}
                              onCheckedChange={() => toggleSelect(m.id)}
                              aria-label={`选择 ${m.email}`}
                            />
                          </TableCell>
                          <TableCell className="font-mono text-sm">{m.email}</TableCell>
                          <TableCell className="text-sm">{m.displayName || "—"}</TableCell>
                          <TableCell className="text-sm">{m.familyGroup?.groupName ?? "—"}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">{m.familyGroup?.account?.name ?? "—"}</TableCell>
                          <TableCell>
                            <div className="flex flex-col gap-0.5">
                              {(() => {
                                const acctStatus = m.familyGroup?.account?.status;
                                const subStatus = m.familyGroup?.account?.subscriptionStatus;
                                const badges: React.ReactNode[] = [];
                                if (acctStatus && acctStatus !== "HEALTHY") {
                                  badges.push(
                                    <Badge key="acct" variant="destructive" className="text-xs">
                                      {acctStatus === "LOGIN_REQUIRED" ? "🔑需登录" : acctStatus === "RISKY" ? "⚠️风控" : acctStatus}
                                    </Badge>
                                  );
                                }
                                if (subStatus === "SUSPENDED") {
                                  badges.push(<Badge key="sub" variant="outline" className="text-xs text-orange-600 border-orange-300">⚠️订阅暂停</Badge>);
                                } else if (subStatus === "EXPIRED") {
                                  badges.push(<Badge key="sub" variant="destructive" className="text-xs">订阅过期</Badge>);
                                }
                                if (badges.length === 0) {
                                  badges.push(<Badge key="ok" variant="default" className="text-xs">✅正常</Badge>);
                                }
                                return badges;
                              })()}
                            </div>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">{fmtDate(m.expiresAt)}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-xs text-amber-600 border-amber-300">
                              {expiredAgo(m.expiresAt)}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {m.hasRemovalTask ? (
                              <Badge variant="secondary" className="text-xs">移除中</Badge>
                            ) : (
                              <Badge variant="destructive" className="text-xs">待移除</Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="text-center text-muted-foreground py-8">✅ 没有已到期的成员，一切正常</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Historical expired orders */}
      {activeTab === "orders" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Clock className="h-5 w-5" />历史到期订单</CardTitle>
            <CardDescription>所有已被标记为 EXPIRED 的订单</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingOrders ? (
              <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : expiredOrders.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>订单号</TableHead>
                      <TableHead>用户邮箱</TableHead>
                      <TableHead>更新时间</TableHead>
                      <TableHead className="w-20">状态</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {expiredOrders.map((o) => (
                      <TableRow key={o.id}>
                        <TableCell className="font-mono text-sm">{o.orderNo}</TableCell>
                        <TableCell className="text-sm">{o.userEmail}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{fmtDate(o.updatedAt)}</TableCell>
                        <TableCell><Badge variant="destructive" className="text-xs">EXPIRED</Badge></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="text-center text-muted-foreground py-8">还没有到期订单记录</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
