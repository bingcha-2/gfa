"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { FlameIcon, PlusIcon, XIcon } from "lucide-react";

import {
  AccountButton,
  AccountEmpty,
  AccountInput,
  AccountSkeleton,
  AccountTextarea,
} from "@/components/account/account-ui";
import { TicketStatusBadge } from "@/components/account/ticket-status-badge";
import { TicketUrgentBadge } from "@/components/account/ticket-urgent-badge";
import { TicketThread } from "@/components/account/ticket-thread";
import { createTicket, getTickets, setTicketUrgent, UserApiError } from "@/lib/account/user-api";
import type { TicketSummary } from "@/lib/account/user-types";
import { useDialogA11y } from "@/lib/account/use-dialog-a11y";
import { formatDateTime } from "@/lib/format";
import { useDict } from "@/lib/i18n/client";

export function TicketsList() {
  const dict = useDict();
  const t = dict.portalApp.tickets;

  const [tickets, setTickets] = useState<TicketSummary[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Ticket whose conversation is shown in a modal (null = no thread open).
  const [activeTicket, setActiveTicket] = useState<TicketSummary | null>(null);

  // Id of the ticket whose urgent flag is currently being toggled (row button).
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const createPanelRef = useRef<HTMLElement>(null);
  const threadPanelRef = useRef<HTMLElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await getTickets();
      setTickets(data.tickets);
      setLoadError(false);
    } catch {
      setTickets([]);
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const closeCreate = useCallback(() => {
    setDialogOpen(false);
    setSubject("");
    setBody("");
  }, []);

  // Closing reloads the list so "最近更新" / 状态 reflect any reply just sent.
  const closeThread = useCallback(() => {
    setActiveTicket(null);
    void load();
  }, [load]);

  useDialogA11y(createPanelRef, dialogOpen, closeCreate);
  useDialogA11y(threadPanelRef, Boolean(activeTicket), closeThread);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || !subject.trim() || !body.trim()) return;
    setSubmitting(true);
    try {
      await createTicket(subject.trim(), body.trim());
      toast.success(t.createdToast);
      closeCreate();
      await load();
    } catch {
      toast.error(t.createFailed);
    } finally {
      setSubmitting(false);
    }
  }

  // Toggle urgent straight from the list row (no need to open the thread).
  // Propagation is stopped by the cell wrapper so the row doesn't open the thread.
  async function handleToggleUrgent(ticket: TicketSummary) {
    if (togglingId) return;
    const next = !ticket.urgent;
    setTogglingId(ticket.id);
    try {
      const { ticket: updated } = await setTicketUrgent(ticket.id, next);
      setTickets((prev) =>
        prev
          ? prev.map((row) =>
              row.id === ticket.id
                ? { ...row, urgent: updated.urgent, urgentAt: updated.urgentAt }
                : row
            )
          : prev
      );
      toast.success(next ? t.urgentToast : t.cancelUrgentToast);
    } catch (err) {
      if (err instanceof UserApiError && err.code === "TICKET_CLOSED") {
        // Closed since the list loaded — reflect it locally (closed clears urgent).
        setTickets((prev) =>
          prev
            ? prev.map((row) =>
                row.id === ticket.id
                  ? { ...row, status: "CLOSED", urgent: false, urgentAt: null }
                  : row
              )
            : prev
        );
        toast.error(t.closedNotice);
      } else {
        toast.error(t.urgentFailed);
      }
    } finally {
      setTogglingId(null);
    }
  }

  return (
    <div className="account-ticket-center" data-testid="account-ticket-center">
      <div className="account-list-toolbar">
        <AccountButton onClick={() => setDialogOpen(true)}>
          <PlusIcon data-icon="inline-start" />
          {t.newTicket}
        </AccountButton>
      </div>

      {loadError && <p className="account-form-error">{t.loadFailed}</p>}

      {tickets === null ? (
        <div className="account-skeleton-stack">
          <AccountSkeleton className="account-skeleton--row" />
          <AccountSkeleton className="account-skeleton--row" />
          <AccountSkeleton className="account-skeleton--row" />
        </div>
      ) : tickets.length === 0 ? (
        <AccountEmpty title={t.empty} description={t.emptyDesc} />
      ) : (
        <div className="account-data-table">
          <table>
            <thead>
              <tr>
                <th>{t.colSubject}</th>
                <th>{t.colStatus}</th>
                <th>{t.colCreatedAt}</th>
                <th>{t.colUpdatedAt}</th>
                <th>{t.colActions}</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((ticket) => (
                <tr
                  key={ticket.id}
                  data-clickable
                  onClick={() => setActiveTicket(ticket)}
                >
                  <td>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
                      <button
                        type="button"
                        className="account-link account-linkbtn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveTicket(ticket);
                        }}
                      >
                        {ticket.subject}
                      </button>
                      {ticket.urgent && <TicketUrgentBadge />}
                    </span>
                  </td>
                  <td>
                    <TicketStatusBadge status={ticket.status} />
                  </td>
                  <td className="account-data-table__muted">
                    {formatDateTime(ticket.createdAt)}
                  </td>
                  <td className="account-data-table__muted">
                    {formatDateTime(ticket.updatedAt)}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {ticket.status !== "CLOSED" && (
                      <AccountButton
                        variant="secondary"
                        onClick={() => void handleToggleUrgent(ticket)}
                        disabled={togglingId === ticket.id}
                      >
                        <FlameIcon data-icon="inline-start" />
                        {ticket.urgent ? t.cancelUrgent : t.urgent}
                      </AccountButton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialogOpen && (
        <div className="account-dialog" role="presentation">
          <button
            type="button"
            className="account-dialog__backdrop"
            aria-label={t.close}
            onClick={closeCreate}
          />
          <section
            ref={createPanelRef}
            tabIndex={-1}
            className="account-dialog__panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-ticket-dialog-title"
          >
            <header className="account-dialog__header">
              <div>
                <h2 id="account-ticket-dialog-title">{t.newTicket}</h2>
                <p>{t.bodyPlaceholder}</p>
              </div>
              <button
                type="button"
                className="account-dialog__close"
                aria-label={t.close}
                onClick={closeCreate}
              >
                <XIcon size={16} />
              </button>
            </header>
            <form onSubmit={handleCreate} className="account-form-stack">
              <AccountInput
                label={t.subjectLabel}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder={t.subjectPlaceholder}
                maxLength={120}
                required
                disabled={submitting}
                data-autofocus
              />
              <AccountTextarea
                label={t.bodyLabel}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={t.bodyPlaceholder}
                rows={5}
                required
                disabled={submitting}
              />
              <div className="account-form-actions">
                <AccountButton
                  type="submit"
                  disabled={submitting || !subject.trim() || !body.trim()}
                >
                  {submitting ? t.submitting : t.submit}
                </AccountButton>
              </div>
            </form>
          </section>
        </div>
      )}

      {activeTicket && (
        <div className="account-dialog" role="presentation">
          <button
            type="button"
            className="account-dialog__backdrop"
            aria-label={t.close}
            onClick={closeThread}
          />
          <section
            ref={threadPanelRef}
            tabIndex={-1}
            className="account-dialog__panel account-dialog__panel--wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-ticket-thread-dialog-title"
          >
            <header className="account-dialog__header">
              <div className="account-ticket-dialog__heading">
                <h2 id="account-ticket-thread-dialog-title">
                  {activeTicket.subject}
                </h2>
                <TicketStatusBadge status={activeTicket.status} />
              </div>
              <button
                type="button"
                className="account-dialog__close"
                aria-label={t.close}
                onClick={closeThread}
              >
                <XIcon size={16} />
              </button>
            </header>
            <TicketThread ticketId={activeTicket.id} />
          </section>
        </div>
      )}
    </div>
  );
}
