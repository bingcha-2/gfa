"use client";

import { useState, useEffect, useCallback } from "react";
import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
import { toast } from "sonner";
import type { ConsolePlanOrderList, ConsolePlanOrder } from "@/lib/console/types";
import {
  fmtYuan, fmtDateTime, ORDER_STATUS_LABEL, PAY_CHANNEL_LABEL,
} from "@/lib/console/format";
import { orderAction } from "@/lib/console/order-action";

import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { RefreshCw, Search } from "lucide-react";

const PAGE_SIZE = 20;

const STATUS_ITEMS = [
  { label: "全部状态", value: "all" },
  { label: "待支付", value: "PENDING" },
  { label: "已支付", value: "PAID" },
  { label: "已退款", value: "REFUNDED" },
  { label: "已过期", value: "EXPIRED" },
  { label: "失败", value: "FAILED" },
];
const CHANNEL_ITEMS = [
  { label: "全部渠道", value: "all" },
  { label: "支付宝", value: "ALIPAY" },
  { label: "微信", value: "WXPAY" },
];

function selectionName(json: string | null): string {
  if (!json) return "—";
  try {
    const s = JSON.parse(json);
    if (!s || typeof s !== "object" || !("line" in s)) return "—";
    const line = s.line === "bind" ? "绑定" : "号池";
    const products = s.line === "bind"
      ? (s.items ?? []).map((i: { product: string }) => i.product)
      : s.products ?? [];
    return `${line} ${products.join("+") || "套餐"}`;
  } catch { return "—"; }
}

function orderStatusBadge(status: string) {
  if (status === "PAID") return <Badge className="bg-emerald-500 text-white">{ORDER_STATUS_LABEL[status]}</Badge>;
  if (status === "REFUNDED") return <Badge variant="destructive">{ORDER_STATUS_LABEL[status]}</Badge>;
  if (status === "PENDING") return <Badge className="bg-amber-500 text-white">{ORDER_STATUS_LABEL[status]}</Badge>;
  return <Badge variant="outline">{ORDER_STATUS_LABEL[status] ?? status}</Badge>;
}

export default function PlanOrdersPage() {
  const [data, setData] = useState<ConsolePlanOrderList | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("all");
  const [channel, setChannel] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await apiRequest<ConsolePlanOrderList>("plan-orders", {
        search: {
          page,
          pageSize: PAGE_SIZE,
          status: status === "all" ? undefined : status,
          payChannel: channel === "all" ? undefined : channel,
          search: search || undefined,
        },
      });
      setData(res);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [page, status, channel, search]);

  useEffect(() => { void load(); }, [load]);

  async function syncPayment(o: ConsolePlanOrder) {
    try {
      const res = await apiRequest<{ synced: boolean; message: string }>(`plan-orders/${o.id}/sync`, { method: "POST" });
      if (res.synced) {
        toast.success(res.message);
      } else {
        toast.info(res.message);
      }
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Card>
      <CardHeader>
        <CardTitle>客户订单</CardTitle>
        <CardDescription>付费订单流水：查询、筛选与退款（仅未使用可退，退款经支付网关原路退回并取消订阅、通知客户）</CardDescription>
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <div className="flex items-center gap-2">
            <Input
              placeholder="搜索单号 / 客户邮箱"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { setPage(1); setSearch(searchInput.trim()); } }}
              className="w-60"
            />
            <Button variant="outline" size="sm" onClick={() => { setPage(1); setSearch(searchInput.trim()); }}>
              <Search className="h-4 w-4 mr-1" />搜索
            </Button>
          </div>
          <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }} items={STATUS_ITEMS}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>{STATUS_ITEMS.map((s) => (<SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>))}</SelectGroup></SelectContent>
          </Select>
          <Select value={channel} onValueChange={(v) => { setChannel(v); setPage(1); }} items={CHANNEL_ITEMS}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>{CHANNEL_ITEMS.map((s) => (<SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>))}</SelectGroup></SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : !data || data.orders.length === 0 ? (
          <div className="text-sm text-muted-foreground py-10 text-center">没有符合条件的订单。</div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>单号</TableHead>
                  <TableHead>客户</TableHead>
                  <TableHead>套餐</TableHead>
                  <TableHead className="text-right">金额</TableHead>
                  <TableHead className="text-right">余额抵扣</TableHead>
                  <TableHead>渠道</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>已激活订阅</TableHead>
                  <TableHead>支付时间</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.orders.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="font-mono text-xs">{o.outTradeNo}</TableCell>
                    <TableCell>{o.customer?.email ?? "—"}</TableCell>
                    <TableCell>{selectionName(o.selection)}</TableCell>
                    <TableCell className="text-right">{fmtYuan(o.amountCents)}</TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {o.creditAppliedCents > 0 ? `-${fmtYuan(o.creditAppliedCents)}` : "—"}
                    </TableCell>
                    <TableCell>{PAY_CHANNEL_LABEL[o.payChannel] ?? o.payChannel}</TableCell>
                    <TableCell>{orderStatusBadge(o.status)}</TableCell>
                    <TableCell>
                      {o.subscriptionId
                        ? <a className="text-blue-600 hover:underline" href={`/console/subscriptions?sub=${o.subscriptionId}`}>查看 ↗</a>
                        : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{fmtDateTime(o.paidAt)}</TableCell>
                    <TableCell className="text-right flex items-center justify-end gap-1">
                      {(o.status === "PENDING" || o.status === "EXPIRED") && (
                        <Button variant="ghost" size="sm" onClick={() => void syncPayment(o)}>
                          <RefreshCw className="h-3.5 w-3.5 mr-1" />查询支付
                        </Button>
                      )}
                      {(() => {
                        const act = orderAction({ payChannel: o.payChannel, status: o.status });
                        if (act.kind === "none") return null;
                        const onConfirm = async () => {
                          try {
                            if (act.kind === "revoke" && o.subscriptionId) {
                              await apiRequest(`subscriptions/${o.subscriptionId}/revoke`, { method: "POST" });
                            } else {
                              await apiRequest(`plan-orders/${o.id}/refund`, { method: "POST" });
                            }
                            toast.success(`已${act.label}`);
                            await load();
                          } catch (err) { toast.error(getErrorMessage(err)); }
                        };
                        return (
                          <AlertDialog>
                            <AlertDialogTrigger render={<Button variant="ghost" size="sm" className="text-destructive" />}>
                              {act.label}
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>{act.label}？</AlertDialogTitle>
                                <AlertDialogDescription>
                                  {act.kind === "revoke"
                                    ? `订单 ${o.outTradeNo} 为管理员发放(¥0),将撤销授权并取消对应订阅、释放席位,不涉及退款。`
                                    : `确认对订单 ${o.outTradeNo}(${fmtYuan(o.amountCents)})退款？仅未使用的订单可退,原路退回并取消订阅。`}
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>取消</AlertDialogCancel>
                                <AlertDialogAction onClick={() => void onConfirm()}>确认{act.label}</AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        );
                      })()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="flex items-center justify-between pt-4">
              <div className="text-sm text-muted-foreground">共 {total} 笔 · 第 {data.page} / {totalPages} 页</div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</Button>
                <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>下一页</Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
