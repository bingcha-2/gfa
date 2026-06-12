"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
import { toast } from "sonner";
import type { ConsoleTicketDetail } from "@/lib/console/types";
import { fmtDateTime, TICKET_STATUS_LABEL } from "@/lib/console/format";

import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Send, Lock, RotateCcw } from "lucide-react";

function ticketStatusBadge(status: string) {
  if (status === "OPEN") return <Badge className="bg-amber-500 text-white">{TICKET_STATUS_LABEL[status]}</Badge>;
  if (status === "ANSWERED") return <Badge className="bg-emerald-500 text-white">{TICKET_STATUS_LABEL[status]}</Badge>;
  return <Badge variant="outline">{TICKET_STATUS_LABEL[status] ?? status}</Badge>;
}

export default function TicketDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [t, setT] = useState<ConsoleTicketDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const d = await apiRequest<ConsoleTicketDetail>(`tickets/${id}`);
      setT(d);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { if (id) void load(); }, [load, id]);

  async function sendReply() {
    const body = reply.trim();
    if (!body) return;
    try {
      setSending(true);
      await apiRequest(`tickets/${id}/messages`, { method: "POST", body: { body } });
      setReply("");
      toast.success("已回复");
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSending(false);
    }
  }

  async function setStatus(status: "OPEN" | "CLOSED") {
    try {
      await apiRequest(`tickets/${id}`, { method: "PATCH", body: { status } });
      toast.success(status === "CLOSED" ? "工单已关闭" : "工单已重新打开");
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  if (loading) {
    return <div className="space-y-4"><Skeleton className="h-8 w-40" /><Skeleton className="h-64 w-full" /></div>;
  }
  if (!t) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/console/tickets" />}><ArrowLeft className="h-4 w-4 mr-1" />返回</Button>
        <div className="text-sm text-muted-foreground">未找到该工单。</div>
      </div>
    );
  }

  const closed = t.status === "CLOSED";

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/console/tickets" />}><ArrowLeft className="h-4 w-4 mr-1" />工单列表</Button>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2">{t.subject} {ticketStatusBadge(t.status)}</CardTitle>
              <div className="text-sm text-muted-foreground">{t.customer?.email ?? "—"} · 创建于 {fmtDateTime(t.createdAt)}</div>
            </div>
            <div className="shrink-0">
              {closed ? (
                <Button variant="outline" size="sm" onClick={() => void setStatus("OPEN")}><RotateCcw className="h-3.5 w-3.5 mr-1" />重新打开</Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => void setStatus("CLOSED")}><Lock className="h-3.5 w-3.5 mr-1" />关闭工单</Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3">
            {t.messages.map((m) => {
              const isAdmin = m.authorType === "ADMIN";
              return (
                <div key={m.id} className={cn("flex", isAdmin ? "justify-end" : "justify-start")}>
                  <div className={cn("max-w-[75%] rounded-lg px-3 py-2", isAdmin ? "bg-primary text-primary-foreground" : "bg-muted")}>
                    <div className={cn("text-[11px] mb-1", isAdmin ? "text-primary-foreground/70" : "text-muted-foreground")}>
                      {isAdmin ? "客服" : "客户"} · {fmtDateTime(m.createdAt)}
                    </div>
                    <div className="text-sm whitespace-pre-wrap break-words">{m.body}</div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="border-t pt-4">
            {closed ? (
              <div className="text-sm text-muted-foreground text-center py-2">工单已关闭，如需继续请重新打开。</div>
            ) : (
              <div className="space-y-2">
                <Textarea
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  placeholder="输入回复内容…"
                  rows={3}
                />
                <div className="flex justify-end">
                  <Button onClick={() => void sendReply()} disabled={sending || !reply.trim()}>
                    <Send className="h-4 w-4 mr-1" />{sending ? "发送中…" : "发送回复"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
