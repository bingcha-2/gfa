"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { LockIcon, SendIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { TicketStatusBadge } from "@/components/portal/ticket-status-badge";
import { getTicket, replyTicket, UserApiError } from "@/lib/user-api";
import type { TicketDetail } from "@/lib/user-types";
import { formatDateTime } from "@/lib/format";
import { useDict } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

type LoadState = "loading" | "ready" | "notFound" | "error";

export function TicketThread({ ticketId }: { ticketId: string }) {
  const dict = useDict();
  const t = dict.portalApp.tickets;

  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      const next = await getTicket(ticketId);
      setDetail(next);
      setLoadState("ready");
    } catch (err) {
      // Only a genuine 404 means "not found"; 500s / network errors get a
      // retryable generic error state instead of a misleading "not found".
      if (err instanceof UserApiError && err.status === 404) {
        setLoadState("notFound");
      } else {
        setLoadState("error");
      }
    }
  }, [ticketId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!detail || sending || !reply.trim()) return;
    setSending(true);
    try {
      const { message } = await replyTicket(ticketId, reply.trim());
      setDetail((prev) =>
        prev ? { ...prev, messages: [...prev.messages, message] } : prev
      );
      setReply("");
    } catch (err) {
      if (err instanceof UserApiError && err.code === "TICKET_CLOSED") {
        // Ticket was closed since loading — flip status locally and notify.
        setDetail((prev) =>
          prev
            ? { ...prev, ticket: { ...prev.ticket, status: "CLOSED" } }
            : prev
        );
        toast.error(t.closedNotice);
      } else {
        toast.error(t.replyFailed);
      }
    } finally {
      setSending(false);
    }
  }

  if (loadState === "notFound") {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{t.notFound}</p>
        <Link
          href="/account/tickets"
          className="text-sm text-accent underline-offset-4 hover:underline"
        >
          {t.backToList}
        </Link>
      </div>
    );
  }

  if (loadState === "error") {
    return (
      <div className="space-y-4">
        <p className="text-sm text-destructive">{t.threadLoadFailed}</p>
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={() => void load()}>
            {t.retry}
          </Button>
          <Link
            href="/account/tickets"
            className="text-sm text-muted-foreground underline-offset-4 hover:underline hover:text-foreground"
          >
            {t.backToList}
          </Link>
        </div>
      </div>
    );
  }

  if (loadState === "loading" || detail === null) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-64 rounded" />
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-20 rounded-xl ml-12" />
      </div>
    );
  }

  const closed = detail.ticket.status === "CLOSED";

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="space-y-2">
        <Link
          href="/account/tickets"
          className="text-xs text-muted-foreground underline-offset-4 hover:underline hover:text-foreground"
        >
          {t.backToList}
        </Link>
        <div className="flex items-center gap-3">
          <h3 className="text-base font-semibold">{detail.ticket.subject}</h3>
          <TicketStatusBadge status={detail.ticket.status} />
        </div>
        <p className="text-xs text-muted-foreground tabular-nums">
          {formatDateTime(detail.ticket.createdAt)}
        </p>
      </div>

      <ul className="space-y-3">
        {detail.messages.map((message) => {
          const mine = message.authorType === "CUSTOMER";
          return (
            <li
              key={message.id}
              className={cn("flex", mine ? "justify-end" : "justify-start")}
            >
              <div
                className={cn(
                  "max-w-[85%] rounded-xl border p-3 space-y-1.5",
                  mine
                    ? "bg-accent/10 border-accent/20"
                    : "bg-card"
                )}
              >
                <div className="flex items-baseline gap-2 text-[11px] text-muted-foreground">
                  <span className="font-medium">
                    {mine ? t.authorCustomer : t.authorAdmin}
                  </span>
                  <span className="tabular-nums">
                    {formatDateTime(message.createdAt)}
                  </span>
                </div>
                <p className="text-sm whitespace-pre-line">{message.body}</p>
              </div>
            </li>
          );
        })}
      </ul>

      {closed ? (
        <div className="flex items-center gap-2 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
          <LockIcon className="size-4 shrink-0" />
          {t.closedNotice}
        </div>
      ) : (
        <form onSubmit={handleSend} className="space-y-3">
          <Textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder={t.replyPlaceholder}
            rows={4}
            disabled={sending}
            required
          />
          <div className="flex justify-end">
            <Button type="submit" disabled={sending || !reply.trim()}>
              <SendIcon data-icon="inline-start" />
              {sending ? t.sending : t.send}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
