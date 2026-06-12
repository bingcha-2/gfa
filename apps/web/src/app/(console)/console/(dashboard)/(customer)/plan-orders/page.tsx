"use client";

import { useState, useEffect, useCallback } from "react";
import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
import { toast } from "sonner";
import type { ConsolePlanOrderList, ConsolePlanOrder } from "@/lib/console/types";
import {
  fmtYuan, fmtDateTime, ORDER_STATUS_LABEL, PAY_CHANNEL_LABEL,
} from "@/lib/console/format";

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
import { Search, Undo2 } from "lucide-react";

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

  async function refund(o: ConsolePlanOrder) {
    try {
      await apiRequest(`plan-orders/${o.id}/refund`, { method: "POST" });
      toast.success(`订单 ${o.outTradeNo} 已退款`);
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
        <CardDescription>付费订单流水：查询、筛选与退款（退款会同步取消对应订阅并通知客户）</CardDescription>
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
                  <TableHead>渠道</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>支付时间</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.orders.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="font-mono text-xs">{o.outTradeNo}</TableCell>
                    <TableCell>{o.customer?.email ?? "—"}</TableCell>
                    <TableCell>{o.plan?.name ?? "—"}</TableCell>
                    <TableCell className="text-right">{fmtYuan(o.amountCents)}</TableCell>
                    <TableCell>{PAY_CHANNEL_LABEL[o.payChannel] ?? o.payChannel}</TableCell>
                    <TableCell>{orderStatusBadge(o.status)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{fmtDateTime(o.paidAt)}</TableCell>
                    <TableCell className="text-right">
                      {o.status === "PAID" && (
                        <AlertDialog>
                          <AlertDialogTrigger render={<Button variant="ghost" size="sm" className="text-destructive" />}>
                            <Undo2 className="h-3.5 w-3.5 mr-1" />退款
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>退款？</AlertDialogTitle>
                              <AlertDialogDescription>
                                确认对订单 {o.outTradeNo}（{fmtYuan(o.amountCents)}）退款？这会把订单置为已退款、取消其激活的订阅并通知客户。打款需另在支付商户后台操作。
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>取消</AlertDialogCancel>
                              <AlertDialogAction onClick={() => void refund(o)}>确认退款</AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
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
