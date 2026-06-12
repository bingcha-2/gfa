"use client";

import { useState, useEffect, useCallback } from "react";
import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
import { toast } from "sonner";
import type { ConsoleReferralRewardList } from "@/lib/console/types";
import { fmtYuan, fmtDateTime, REFERRAL_STATUS_LABEL } from "@/lib/console/format";

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
import { Search } from "lucide-react";

const PAGE_SIZE = 20;

const STATUS_ITEMS = [
  { label: "全部状态", value: "all" },
  { label: "待发放", value: "PENDING" },
  { label: "已发放", value: "GRANTED" },
  { label: "已撤销", value: "REVOKED" },
];

function rewardStatusBadge(status: string) {
  if (status === "GRANTED") return <Badge className="bg-emerald-500 text-white">{REFERRAL_STATUS_LABEL[status]}</Badge>;
  if (status === "PENDING") return <Badge className="bg-amber-500 text-white">{REFERRAL_STATUS_LABEL[status]}</Badge>;
  return <Badge variant="destructive">{REFERRAL_STATUS_LABEL[status] ?? status}</Badge>;
}

export default function ReferralsPage() {
  const [data, setData] = useState<ConsoleReferralRewardList | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await apiRequest<ConsoleReferralRewardList>("referral-rewards", {
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

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Card>
      <CardHeader>
        <CardTitle>返佣</CardTitle>
        <CardDescription>邀请返佣记录：邀请人、被邀请人、关联订单与发放状态</CardDescription>
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <div className="flex items-center gap-2">
            <Input
              placeholder="搜索邀请人邮箱"
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
        ) : !data || data.rewards.length === 0 ? (
          <div className="text-sm text-muted-foreground py-10 text-center">暂无返佣记录。</div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>邀请人</TableHead>
                  <TableHead>被邀请人</TableHead>
                  <TableHead>关联单号</TableHead>
                  <TableHead className="text-right">返佣金额</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rewards.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{r.referrerEmail ?? r.referrerId}</TableCell>
                    <TableCell>{r.inviteeEmail ?? r.inviteeId}</TableCell>
                    <TableCell className="font-mono text-xs">{r.outTradeNo ?? "—"}</TableCell>
                    <TableCell className="text-right">{fmtYuan(r.amountCents)}</TableCell>
                    <TableCell>{rewardStatusBadge(r.status)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{fmtDateTime(r.createdAt)}</TableCell>
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
