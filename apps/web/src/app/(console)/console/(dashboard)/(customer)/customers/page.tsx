"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
import { toast } from "sonner";
import type { ConsoleCustomerList, ConsoleCustomerListItem } from "@/lib/console/types";
import { fmtYuan, fmtDateTime } from "@/lib/console/format";

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
import { Search, Ban, CircleCheck, ExternalLink } from "lucide-react";

const PAGE_SIZE = 20;

const STATUS_ITEMS = [
  { label: "全部状态", value: "all" },
  { label: "正常", value: "ACTIVE" },
  { label: "已封禁", value: "DISABLED" },
];

export default function CustomersPage() {
  const [data, setData] = useState<ConsoleCustomerList | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await apiRequest<ConsoleCustomerList>("customers", {
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

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleBan(c: ConsoleCustomerListItem) {
    const next = c.status === "DISABLED" ? "ACTIVE" : "DISABLED";
    try {
      await apiRequest(`customers/${c.id}`, { method: "PATCH", body: { status: next } });
      toast.success(next === "DISABLED" ? `已封禁 ${c.email}` : `已解封 ${c.email}`);
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
        <CardTitle>客户账户</CardTitle>
        <CardDescription>管理付费客户：查看订阅与订单、封禁/解封、调整备注与额度</CardDescription>
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <div className="flex items-center gap-2">
            <Input
              placeholder="搜索邮箱 / 昵称 / 邀请码"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { setPage(1); setSearch(searchInput.trim()); } }}
              className="w-64"
            />
            <Button variant="outline" size="sm" onClick={() => { setPage(1); setSearch(searchInput.trim()); }}>
              <Search className="h-4 w-4 mr-1" />搜索
            </Button>
          </div>
          <Select
            value={status}
            onValueChange={(v) => { setStatus(v); setPage(1); }}
            items={STATUS_ITEMS}
          >
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {STATUS_ITEMS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : !data || data.customers.length === 0 ? (
          <div className="text-sm text-muted-foreground py-10 text-center">没有符合条件的客户。</div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>邮箱</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-center">订阅</TableHead>
                  <TableHead className="text-center">订单</TableHead>
                  <TableHead className="text-right">累计消费</TableHead>
                  <TableHead className="text-center">设备</TableHead>
                  <TableHead>注册时间</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.customers.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <div className="font-medium">{c.email}</div>
                      {c.displayName && <div className="text-xs text-muted-foreground">{c.displayName}</div>}
                    </TableCell>
                    <TableCell>
                      {c.status === "DISABLED" ? (
                        <Badge variant="destructive">已封禁</Badge>
                      ) : (
                        <Badge className="bg-emerald-500 text-white">正常</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-center">{c.activeSubscriptions}</TableCell>
                    <TableCell className="text-center">{c.orderCount}</TableCell>
                    <TableCell className="text-right">{fmtYuan(c.totalPaidCents)}</TableCell>
                    <TableCell className="text-center">{c.deviceCount}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{fmtDateTime(c.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" nativeButton={false} render={<Link href={`/console/customers/${c.id}`} />}>
                          <ExternalLink className="h-3.5 w-3.5 mr-1" />详情
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger
                            render={<Button variant="ghost" size="sm" className={c.status === "DISABLED" ? "text-emerald-600" : "text-destructive"} />}
                          >
                            {c.status === "DISABLED" ? <CircleCheck className="h-3.5 w-3.5" /> : <Ban className="h-3.5 w-3.5" />}
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>{c.status === "DISABLED" ? "解封客户？" : "封禁客户？"}</AlertDialogTitle>
                              <AlertDialogDescription>
                                {c.status === "DISABLED"
                                  ? `确认解封 ${c.email}？解封后该客户可重新登录。`
                                  : `确认封禁 ${c.email}？封禁会立即使其所有登录态失效（强制下线），但不影响已有订阅。`}
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>取消</AlertDialogCancel>
                              <AlertDialogAction onClick={() => void toggleBan(c)}>确认</AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="flex items-center justify-between pt-4">
              <div className="text-sm text-muted-foreground">
                共 {total} 位客户 · 第 {data.page} / {totalPages} 页
              </div>
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
