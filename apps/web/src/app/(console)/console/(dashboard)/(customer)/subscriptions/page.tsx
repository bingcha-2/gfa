"use client";

import { useState, useEffect, useCallback } from "react";
import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
import { toast } from "sonner";
import type { ConsoleSubscriptionList, ConsoleSubscription } from "@/lib/console/types";
import { fmtDateTime, SUB_STATUS_LABEL } from "@/lib/console/format";

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
import { Search, Ban } from "lucide-react";

const PAGE_SIZE = 20;

const STATUS_ITEMS = [
  { label: "全部状态", value: "all" },
  { label: "生效中", value: "ACTIVE" },
  { label: "已过期", value: "EXPIRED" },
  { label: "已取消", value: "CANCELLED" },
];

function parseProducts(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function subStatusBadge(status: string) {
  if (status === "ACTIVE") return <Badge className="bg-emerald-500 text-white">{SUB_STATUS_LABEL[status]}</Badge>;
  if (status === "CANCELLED") return <Badge variant="destructive">{SUB_STATUS_LABEL[status]}</Badge>;
  return <Badge variant="outline">{SUB_STATUS_LABEL[status] ?? status}</Badge>;
}

export default function SubscriptionsPage() {
  const [data, setData] = useState<ConsoleSubscriptionList | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await apiRequest<ConsoleSubscriptionList>("subscriptions", {
        search: {
          page,
          pageSize: PAGE_SIZE,
          status: status === "all" ? undefined : status,
          search: search || undefined,
        },
      });
      setData(res);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [page, status, search]);

  useEffect(() => { void load(); }, [load]);

  async function revoke(s: ConsoleSubscription) {
    try {
      await apiRequest(`subscriptions/${s.id}/revoke`, { method: "POST" });
      toast.success("订阅已取消");
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
        <CardTitle>订阅</CardTitle>
        <CardDescription>客户订阅总览：查询、筛选与撤销（撤销会释放席位并通知客户）</CardDescription>
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <div className="flex items-center gap-2">
            <Input
              placeholder="搜索客户邮箱"
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
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : !data || data.subscriptions.length === 0 ? (
          <div className="text-sm text-muted-foreground py-10 text-center">没有符合条件的订阅。</div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>客户</TableHead>
                  <TableHead>套餐</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>产品</TableHead>
                  <TableHead>到期</TableHead>
                  <TableHead className="text-center">权重</TableHead>
                  <TableHead className="text-center">设备</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.subscriptions.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>{s.customer?.email ?? "—"}</TableCell>
                    <TableCell className="font-medium">{s.plan?.name ?? "—"}</TableCell>
                    <TableCell>{subStatusBadge(s.status)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {parseProducts(s.productEntitlements).map((p) => (
                          <Badge key={p} variant="secondary" className="text-xs">{p}</Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{fmtDateTime(s.expiresAt)}</TableCell>
                    <TableCell className="text-center">{s.weight}</TableCell>
                    <TableCell className="text-center">{s.deviceLimit}</TableCell>
                    <TableCell className="text-right">
                      {s.status === "ACTIVE" && (
                        <AlertDialog>
                          <AlertDialogTrigger render={<Button variant="ghost" size="sm" className="text-destructive" />}>
                            <Ban className="h-3.5 w-3.5 mr-1" />撤销
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>撤销订阅？</AlertDialogTitle>
                              <AlertDialogDescription>确认撤销 {s.customer?.email ?? ""} 的订阅「{s.plan?.name ?? s.id}」？席位将被释放，客户会收到通知。</AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>返回</AlertDialogCancel>
                              <AlertDialogAction onClick={() => void revoke(s)}>确认撤销</AlertDialogAction>
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
              <div className="text-sm text-muted-foreground">共 {total} 条 · 第 {data.page} / {totalPages} 页</div>
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
