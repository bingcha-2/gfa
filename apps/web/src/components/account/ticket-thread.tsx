"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { FlameIcon, LockIcon, SendIcon } from "lucide-react";

import { AccountButton, AccountSkeleton } from "@/components/account/account-ui";
import { TicketUrgentBadge } from "@/components/account/ticket-urgent-badge";
import { getTicket, replyTicket, setTicketUrgent, UserApiError } from "@/lib/account/user-api";
import type { TicketDetail } from "@/lib/account/user-types";
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
  const [togglingUrgent, setTogglingUrgent] = useState(false);

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

  async function handleToggleUrgent() {
    if (!detail || togglingUrgent) return;
    const next = !detail.ticket.urgent;
    setTogglingUrgent(true);
    try {
      const { ticket } = await setTicketUrgent(ticketId, next);
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              ticket: { ...prev.ticket, urgent: ticket.urgent, urgentAt: ticket.urgentAt },
            }
          : prev
      );
      toast.success(next ? t.urgentToast : t.cancelUrgentToast);
    } catch (err) {
      if (err instanceof UserApiError && err.code === "TICKET_CLOSED") {
        // Ticket was closed since loading — closing clears urgent server-side.
        setDetail((prev) =>
          prev
            ? {
                ...prev,
                ticket: { ...prev.ticket, status: "CLOSED", urgent: false, urgentAt: null },
              }
            : prev
        );
        toast.error(t.closedNotice);
      } else {
        toast.error(t.urgentFailed);
      }
    } finally {
      setTogglingUrgent(false);
    }
  }

  if (loadState === "notFound") {
    return (
      <div className="account-state-panel">
        <p>{t.notFound}</p>
      </div>
    );
  }

  if (loadState === "error") {
    return (
      <div className="account-state-panel">
        <p className="account-state-panel__error">{t.threadLoadFailed}</p>
        <div>
          <AccountButton variant="secondary" onClick={() => void load()}>
            {t.retry}
          </AccountButton>
        </div>
      </div>
    );
  }

  if (loadState === "loading" || detail === null) {
    return (
      <div className="account-skeleton-stack">
        <AccountSkeleton className="account-skeleton--heading" />
        <AccountSkeleton className="account-skeleton--message" />
        <AccountSkeleton className="account-skeleton--message account-skeleton--indent" />
      </div>
    );
  }

  const closed = detail.ticket.status === "CLOSED";

  return (
    <div className="account-ticket-thread" data-testid="account-ticket-thread">
      {!closed && (
        <div
          style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.75rem" }}
        >
          {detail.ticket.urgent && <TicketUrgentBadge />}
          <AccountButton
            variant="secondary"
            onClick={() => void handleToggleUrgent()}
            disabled={togglingUrgent}
          >
            <FlameIcon data-icon="inline-start" />
            {detail.ticket.urgent ? t.cancelUrgent : t.urgent}
          </AccountButton>
        </div>
      )}

      <ul className="account-thread-list">
        {detail.messages.map((message) => {
          const mine = message.authorType === "CUSTOMER";
          return (
            <li
              key={message.id}
              className={cn("account-thread-message", mine && "account-thread-message--mine")}
            >
              <div>
                <div className="account-thread-message__meta">
                  <span>
                    {mine ? t.authorCustomer : t.authorAdmin}
                  </span>
                  <time dateTime={message.createdAt}>
                    {formatDateTime(message.createdAt)}
                  </time>
                </div>
                <p>{message.body}</p>
              </div>
            </li>
          );
        })}
      </ul>

      {closed ? (
        <div className="account-closed-notice">
          <LockIcon />
          {t.closedNotice}
        </div>
      ) : (
        <form onSubmit={handleSend} className="account-reply-form">
          <textarea
            className="account-textarea"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder={t.replyPlaceholder}
            rows={4}
            disabled={sending}
            required
          />
          <div className="account-form-actions">
            <AccountButton type="submit" disabled={sending || !reply.trim()}>
              <SendIcon data-icon="inline-start" />
              {sending ? t.sending : t.send}
            </AccountButton>
          </div>
        </form>
      )}
    </div>
  );
}
