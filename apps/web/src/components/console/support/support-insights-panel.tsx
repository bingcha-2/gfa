"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

interface Stats {
  conversations: { total: number; escalated: number; deflected: number; escalationRate: number };
  knowledge: { total: number; published: number; draft: number; mergeSuggested: number };
  topKnowledge: { question: string; usageCount: number }[];
}
interface ConvRow {
  id: string; status: string; ticketId: string | null;
  customerEmail: string | null; messageCount: number; updatedAt: string;
}
interface ConvDetail {
  id: string; status: string; ticketId: string | null; customerEmail: string | null;
  messages: { role: string; content: string; name: string | null; createdAt: string }[];
}

const CONV_STATUS = [
  { value: "all", label: "全部" },
  { value: "OPEN", label: "进行中" },
  { value: "CLOSED", label: "已结束" },
];

function StatCard({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="text-2xl font-semibold">{value}</div>
        <div className="text-sm text-muted-foreground">{label}</div>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

export function SupportInsightsPanel() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [status, setStatus] = useState("all");
  const [convs, setConvs] = useState<ConvRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<ConvDetail | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, c] = await Promise.all([
        apiRequest<Stats>("support/stats"),
        apiRequest<{ conversations: ConvRow[] }>("support/conversations", {
          search: { status: status === "all" ? undefined : status },
        }),
      ]);
      setStats(s);
      setConvs(c.conversations);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { void load(); }, [load]);

  async function openDetail(id: string) {
    try {
      setDetail(await apiRequest<ConvDetail>(`support/conversations/${id}`));
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {loading || !stats ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)
        ) : (
          <>
            <StatCard label="会话总数" value={stats.conversations.total} />
            <StatCard
              label="转人工率"
              value={`${stats.conversations.escalationRate}%`}
              hint={`已自助 ${stats.conversations.deflected} · 转人工 ${stats.conversations.escalated}`}
            />
            <StatCard label="已发布知识" value={stats.knowledge.published} />
            <StatCard
              label="待审知识"
              value={stats.knowledge.draft + stats.knowledge.mergeSuggested}
              hint={`草稿 ${stats.knowledge.draft} · 合并建议 ${stats.knowledge.mergeSuggested}`}
            />
          </>
        )}
      </div>

      {stats && stats.topKnowledge.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">高频命中知识</CardTitle>
            <CardDescription>被 AI 客服引用最多的条目</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            {stats.topKnowledge.map((k, i) => (
              <div key={i} className="flex justify-between text-sm">
                <span className="truncate">{k.question}</span>
                <span className="text-muted-foreground">{k.usageCount} 次</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">客服会话</CardTitle>
          <CardDescription>回看 AI 客服与客户的对话,核对回答质量与转人工情况</CardDescription>
          <div className="pt-2">
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CONV_STATUS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : convs.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">暂无会话。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>客户</TableHead>
                  <TableHead className="w-28">状态</TableHead>
                  <TableHead className="w-20 text-center">消息</TableHead>
                  <TableHead className="w-44">更新时间</TableHead>
                  <TableHead className="w-20 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {convs.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>{c.customerEmail ?? "—"}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Badge variant="secondary">
                          {c.status === "OPEN" ? "进行中" : "已结束"}
                        </Badge>
                        {c.ticketId && <Badge>已转人工</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="text-center">{c.messageCount}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(c.updatedAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => openDetail(c.id)}>查看</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              会话详情 {detail?.customerEmail ? `· ${detail.customerEmail}` : ""}
            </DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="max-h-[60vh] space-y-2 overflow-y-auto">
              {detail.messages.map((m, i) => (
                <div
                  key={i}
                  className={
                    m.role === "USER"
                      ? "ml-8 rounded-md bg-primary/10 p-2 text-sm"
                      : m.role === "TOOL"
                        ? "rounded-md bg-muted p-2 font-mono text-xs text-muted-foreground"
                        : "mr-8 rounded-md border p-2 text-sm"
                  }
                >
                  <div className="mb-0.5 text-xs font-medium text-muted-foreground">
                    {m.role === "USER" ? "客户" : m.role === "TOOL" ? `🔧 ${m.name ?? "工具"}` : "客服AI"}
                  </div>
                  <div className="whitespace-pre-wrap break-words">{m.content}</div>
                </div>
              ))}
              {detail.ticketId && (
                <div className="rounded-md bg-amber-500/10 p-2 text-xs">
                  已转人工工单:{detail.ticketId}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
