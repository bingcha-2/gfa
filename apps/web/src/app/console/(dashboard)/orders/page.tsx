"use client";

import { useState, useEffect, useCallback } from "react";
import { useConsole } from "@/components/console-provider";
import { apiRequest, getErrorMessage } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";
import { canReplaceMember } from "@/lib/permissions";
import type { OrderSummary } from "@/lib/types";
import { toast } from "sonner";
import Link from "next/link";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import {
  Pagination, PaginationContent, PaginationItem,
  PaginationLink, PaginationNext, PaginationPrevious, PaginationEllipsis,
} from "@/components/ui/pagination";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Label } from "@/components/ui/label";
import { RefreshCw, Eye, ExternalLink, ArrowLeftRight, RotateCcw } from "lucide-react";

const ORDER_TYPE_LABEL: Record<string, string> = { JOIN: "上车", SWAP: "换号", SUBSCRIPTION: "订阅" };
const PAGE_SIZE = 50;

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "COMPLETED": case "INVITE_SENT": case "SUCCESS": return "default";
    case "PENDING": case "QUEUED": case "RUNNING": return "secondary";
    case "FAILED": case "FAILED_FINAL": case "CANCELLED": return "destructive";
    default: return "outline";
  }
}

function isSchedulerCancelled(order: OrderSummary): boolean {
  if (order.status !== "FAILED" || !order.resultMessage) return false;
  return order.resultMessage.startsWith("重复取消") || order.resultMessage.startsWith("定时取消");
}

export default function OrdersPage() {
  const { user } = useConsole();
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [filter, setFilter] = useState("");
  const [activeTab, setActiveTab] = useState<"all" | "active" | "manual">("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [detailOrder, setDetailOrder] = useState<OrderSummary | null>(null);

  // Replace dialog
  const [replaceDialogOpen, setReplaceDialogOpen] = useState(false);
  const [replaceOrderId, setReplaceOrderId] = useState("");
  const [replaceTarget, setReplaceTarget] = useState("");
  const [replaceNew, setReplaceNew] = useState("");

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("page", String(currentPage));
      params.set("pageSize", String(PAGE_SIZE));
      if (activeTab === "manual") params.set("status", "MANUAL_REVIEW");
      const res = await apiRequest<{ items: OrderSummary[]; total: number }>(`orders?${params}`);
      setOrders(res.items);
      setTotalItems(res.total);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  }, [currentPage, activeTab]);

  useEffect(() => { loadData(); }, [loadData]);

  const totalPages = Math.ceil(totalItems / PAGE_SIZE);

  const displayOrders = orders.filter((order) => {
    if (activeTab === "active" && ["INVITE_SENT", "COMPLETED", "FAILED"].includes(order.status)) return false;
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return (
      order.orderNo.toLowerCase().includes(q) ||
      order.userEmail.toLowerCase().includes(q) ||
      order.status.toLowerCase().includes(q) ||
      order.familyGroup?.groupName?.toLowerCase().includes(q)
    );
  });

  async function handleRetry(orderId: string) {
    try {
      await apiRequest(`orders/${orderId}/retry`, { method: "POST" });
      toast.success("订单重试已提交");
      await loadData();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  async function handleReplace() {
    if (!replaceTarget || !replaceNew) return;
    try {
      await apiRequest(`orders/${replaceOrderId}/replace-member`, {
        method: "POST",
        body: { targetMemberEmail: replaceTarget, newUserEmail: replaceNew },
      });
      toast.success("替换任务已提交");
      setReplaceDialogOpen(false);
      setReplaceTarget("");
      setReplaceNew("");
      await loadData();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  function renderPagination() {
    if (totalPages <= 1) return null;
    const pages: (number | "ellipsis")[] = [];
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || (i >= currentPage - 2 && i <= currentPage + 2)) {
        pages.push(i);
      } else if (pages[pages.length - 1] !== "ellipsis") {
        pages.push("ellipsis");
      }
    }
    return (
      <Pagination className="mt-4">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              className={currentPage <= 1 ? "pointer-events-none opacity-50" : "cursor-pointer"}
            />
          </PaginationItem>
          {pages.map((p, idx) =>
            p === "ellipsis" ? (
              <PaginationItem key={`e-${idx}`}><PaginationEllipsis /></PaginationItem>
            ) : (
              <PaginationItem key={p}>
                <PaginationLink
                  isActive={p === currentPage}
                  onClick={() => setCurrentPage(p)}
                  className="cursor-pointer"
                >
                  {p}
                </PaginationLink>
              </PaginationItem>
            )
          )}
          <PaginationItem>
            <PaginationNext
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              className={currentPage >= totalPages ? "pointer-events-none opacity-50" : "cursor-pointer"}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>订单流水</CardTitle>
              <CardDescription>
                共 {totalItems} 条{totalPages > 0 && ` · 第 ${currentPage}/${totalPages} 页`}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Input
                placeholder="搜索订单号 / 邮箱 / 状态…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="w-64"
              />
              <Button variant="outline" size="sm" onClick={loadData} disabled={isLoading}>
                <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
              </Button>
            </div>
          </div>
          <Tabs value={activeTab} onValueChange={(v) => { setActiveTab(v as typeof activeTab); setCurrentPage(1); }} className="mt-2">
            <TabsList>
              <TabsTrigger value="all">全部订单</TabsTrigger>
              <TabsTrigger value="active">处理中</TabsTrigger>
              <TabsTrigger value="manual">待人工</TabsTrigger>
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : displayOrders.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <p className="text-lg">没有匹配的订单</p>
            </div>
          ) : (
            <>
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>订单号</TableHead>
                      <TableHead className="w-16">类型</TableHead>
                      <TableHead>用户邮箱</TableHead>
                      <TableHead className="w-24">状态</TableHead>
                      <TableHead>家庭组</TableHead>
                      <TableHead className="w-40">创建时间</TableHead>
                      <TableHead className="w-44 text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {displayOrders.map((order) => (
                      <TableRow key={order.id}>
                        <TableCell>
                          <div className="font-mono text-sm font-medium">{order.orderNo}</div>
                          <div className="text-xs text-muted-foreground">{order._count?.tasks ?? 0} 个任务</div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {(order.orderType && ORDER_TYPE_LABEL[order.orderType]) ?? order.orderType ?? "–"}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-48 truncate text-sm">{order.userEmail}</TableCell>
                        <TableCell>
                          {isSchedulerCancelled(order) ? (
                            <Badge variant="secondary" className="text-xs">
                              {order.resultMessage!.startsWith("重复取消") ? "重复清理" : "定时清理"}
                            </Badge>
                          ) : (
                            <Badge variant={statusVariant(order.status)} className="text-xs">
                              {order.status}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">{order.familyGroup?.groupName ?? "–"}</TableCell>
                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                          {formatDateTime(order.createdAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Tooltip>
                              <TooltipTrigger render={<Button variant="ghost" size="sm" className="text-blue-600 hover:text-blue-700 hover:bg-blue-50" onClick={() => setDetailOrder(order)} />}>
                                <Eye className="h-3.5 w-3.5" />
                              </TooltipTrigger>
                              <TooltipContent>查看订单详情</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger render={<Button variant="ghost" size="sm" className="text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50" nativeButton={false} render={<Link href={`/status/${order.orderNo}`} target="_blank" />} />}>
                                <ExternalLink className="h-3.5 w-3.5" />
                              </TooltipTrigger>
                              <TooltipContent>在新标签查看状态</TooltipContent>
                            </Tooltip>
                            {canReplaceMember(user.role) && order.familyGroup && (
                              <Tooltip>
                                <TooltipTrigger render={
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-violet-600 hover:text-violet-700 hover:bg-violet-50"
                                    onClick={() => {
                                      setReplaceOrderId(order.id);
                                      setReplaceDialogOpen(true);
                                    }}
                                  />
                                }>
                                  <ArrowLeftRight className="h-3.5 w-3.5" />
                                </TooltipTrigger>
                                <TooltipContent>替换成员</TooltipContent>
                              </Tooltip>
                            )}
                            {(order.status === "MANUAL_REVIEW" || order.status === "FAILED") && (
                              <AlertDialog>
                                <Tooltip>
                                  <TooltipTrigger render={<AlertDialogTrigger render={<Button variant="ghost" size="sm" className="text-orange-500 hover:text-orange-600 hover:bg-orange-50" />} />}>
                                    <RotateCcw className="h-3.5 w-3.5" />
                                  </TooltipTrigger>
                                  <TooltipContent>重试订单</TooltipContent>
                                </Tooltip>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>确认重试订单？</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      将重新执行订单 {order.orderNo} 的处理流程。
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>取消</AlertDialogCancel>
                                    <AlertDialogAction onClick={() => void handleRetry(order.id)}>
                                      确认重试
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            )}
                          </div>
                        </TableCell>
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

      {/* Order detail sheet */}
      <Sheet open={!!detailOrder} onOpenChange={(open) => !open && setDetailOrder(null)}>
        <SheetContent className="sm:max-w-lg overflow-y-auto">
          {detailOrder && (
            <>
              <SheetHeader>
                <SheetTitle>订单详情</SheetTitle>
                <SheetDescription className="font-mono">{detailOrder.orderNo}</SheetDescription>
              </SheetHeader>
              <div className="mt-6 space-y-6">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground mb-1">订单 ID</p>
                    <p className="font-mono text-xs break-all">{detailOrder.id}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground mb-1">类型</p>
                    <Badge variant="outline">
                      {(detailOrder.orderType && ORDER_TYPE_LABEL[detailOrder.orderType]) ?? detailOrder.orderType ?? "–"}
                    </Badge>
                  </div>
                  <div>
                    <p className="text-muted-foreground mb-1">用户邮箱</p>
                    <p className="break-all">{detailOrder.userEmail}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground mb-1">状态</p>
                    <Badge variant={statusVariant(detailOrder.status)}>{detailOrder.status}</Badge>
                  </div>
                  <div>
                    <p className="text-muted-foreground mb-1">家庭组</p>
                    <p>{detailOrder.familyGroup?.groupName ?? "–"}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground mb-1">关联任务</p>
                    <p>{detailOrder._count?.tasks ?? 0} 个</p>
                  </div>
                  <div className="col-span-2">
                    <p className="text-muted-foreground mb-1">卡密</p>
                    <p className="font-mono text-xs">{detailOrder.redeemCode?.code ?? "–"}</p>
                  </div>
                  {detailOrder.resultMessage && (
                    <div className="col-span-2">
                      <p className="text-muted-foreground mb-1">结果消息</p>
                      <p className="text-sm">{detailOrder.resultMessage}</p>
                    </div>
                  )}
                </div>

                {/* Swap records */}
                {(detailOrder.orderType === "SWAP" || detailOrder.orderType === "SUBSCRIPTION") && (
                  <div>
                    <h4 className="text-sm font-semibold mb-3">换号记录 ({detailOrder.swapRecords?.length ?? 0} 次)</h4>
                    {detailOrder.swapRecords?.length ? (
                      <div className="space-y-2">
                        {detailOrder.swapRecords.map((swap, idx) => (
                          <div key={swap.id} className="rounded-lg border p-3 text-sm">
                            <div className="flex items-center gap-2 mb-1">
                              <Badge variant="outline" className="text-xs">#{detailOrder.swapRecords!.length - idx}</Badge>
                              <Badge variant={statusVariant(swap.status)} className="text-xs">{swap.status}</Badge>
                              <span className="text-xs text-muted-foreground ml-auto">{formatDateTime(swap.createdAt)}</span>
                            </div>
                            <div className="font-mono text-xs mt-1">
                              {swap.oldEmail} <span className="text-muted-foreground mx-1">→</span> {swap.newEmail}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">暂无换号记录</p>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Replace member dialog */}
      <Dialog open={replaceDialogOpen} onOpenChange={setReplaceDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>替换成员</DialogTitle>
            <DialogDescription>移除旧成员并邀请新成员加入家庭组。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>要移除的成员邮箱</Label>
              <Input
                placeholder="old-member@gmail.com"
                value={replaceTarget}
                onChange={(e) => setReplaceTarget(e.target.value.trim().toLowerCase())}
              />
            </div>
            <div className="space-y-2">
              <Label>新用户邮箱</Label>
              <Input
                placeholder="new-member@gmail.com"
                value={replaceNew}
                onChange={(e) => setReplaceNew(e.target.value.trim().toLowerCase())}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReplaceDialogOpen(false)}>取消</Button>
            <Button onClick={() => void handleReplace()} disabled={!replaceTarget || !replaceNew}>
              确认替换
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
