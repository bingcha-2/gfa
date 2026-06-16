"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
import { toast } from "sonner";
import type { ConsoleTicketList } from "@/lib/console/types";
import { fmtDateTime, TICKET_STATUS_LABEL } from "@/lib/console/format";

import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Search, MessageSquare, Flame, Bot } from "lucide-react";

const PAGE_SIZE = 20;

const STATUS_ITEMS = [
  { label: "全部状态", value: "all" },
  { label: "待处理", value: "OPEN" },
  { label: "已回复", value: "ANSWERED" },
  { label: "已关闭", value: "CLOSED" },
];

function ticketStatusBadge(status: string) {
  if (status === "OPEN") return <Badge className="bg-amber-500 text-white">{TICKET_STATUS_LABEL[status]}</Badge>;
  if (status === "ANSWERED") return <Badge className="bg-emerald-500 text-white">{TICKET_STATUS_LABEL[status]}</Badge>;
  return <Badge variant="outline">{TICKET_STATUS_LABEL[status] ?? status}</Badge>;
}

export default function TicketsPage() {
  const [data, setData] = useState<ConsoleTicketList | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [urgentOnly, setUrgentOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [distilling, setDistilling] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await apiRequest<ConsoleTicketList>("tickets", {
        search: {
          page,
          pageSize: PAGE_SIZE,
          status: status === "all" ? undefined : status,
          search: search || undefined,
          urgent: urgentOnly ? "true" : undefined,
        },
      });
      setData(res);
      setSelected(new Set());
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [page, status, search, urgentOnly]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function distillSelected() {
    const ticketIds = [...selected].slice(0, 20);
    if (ticketIds.length === 0) return;
    setDistilling(true);
    try {
      const res = await apiRequest<{ processed: number; results: { outcome: string }[] }>(
        "support-knowledge/distill",
        { method: "POST", body: { ticketIds } },
      );
      const made = res.results.filter(
        (r) => r.outcome === "draft" || r.outcome === "merge_suggested",
      ).length;
      toast.success(`已处理 ${res.processed} 个工单,生成 ${made} 条草稿/合并建议,请到「客服知识」审核`);
      setSelected(new Set());
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setDistilling(false);
    }
  }

  useEffect(() => { void load(); }, [load]);

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Card>
      <CardHeader>
        <CardTitle>工单</CardTitle>
        <CardDescription>客户提交的工单：查看、回复与关闭</CardDescription>
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
          <Button
            variant={urgentOnly ? "default" : "outline"}
            size="sm"
            className={urgentOnly ? "bg-red-500 hover:bg-red-600 text-white" : "text-red-600 border-red-300 hover:bg-red-50"}
            onClick={() => { setUrgentOnly((v) => !v); setPage(1); }}
          >
            <Flame className="h-4 w-4 mr-1" />仅看加急
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={selected.size === 0 || distilling}
            onClick={distillSelected}
          >
            <Bot className="h-4 w-4 mr-1" />
            {distilling ? "提炼中…" : `提炼知识${selected.size ? `(${selected.size})` : ""}`}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : !data || data.tickets.length === 0 ? (
          <div className="text-sm text-muted-foreground py-10 text-center">没有符合条件的工单。</div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>客户</TableHead>
                  <TableHead>主题</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-center">消息</TableHead>
                  <TableHead>更新时间</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.tickets.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>
                      <Checkbox
                        checked={selected.has(t.id)}
                        onCheckedChange={() => toggle(t.id)}
                      />
                    </TableCell>
                    <TableCell>{t.customer?.email ?? "—"}</TableCell>
                    <TableCell className="font-medium max-w-xs truncate">
                      {t.urgent && (
                        <Badge className="bg-red-500 text-white mr-1.5 align-middle">
                          <Flame className="h-3 w-3 mr-0.5" />加急
                        </Badge>
                      )}
                      {t.subject}
                    </TableCell>
                    <TableCell>{ticketStatusBadge(t.status)}</TableCell>
                    <TableCell className="text-center">{t._count.messages}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{fmtDateTime(t.updatedAt)}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" nativeButton={false} render={<Link href={`/console/tickets/${t.id}`} />}>
                        <MessageSquare className="h-3.5 w-3.5 mr-1" />查看
                      </Button>
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
