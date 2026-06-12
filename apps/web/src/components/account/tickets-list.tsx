"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { PlusIcon } from "lucide-react";

import {
  AccountButton,
  AccountEmpty,
  AccountInput,
  AccountSkeleton,
  AccountTextarea,
} from "@/components/account/account-ui";
import { TicketStatusBadge } from "@/components/account/ticket-status-badge";
import { createTicket, getTickets } from "@/lib/account/user-api";
import type { TicketSummary } from "@/lib/account/user-types";
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

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || !subject.trim() || !body.trim()) return;
    setSubmitting(true);
    try {
      await createTicket(subject.trim(), body.trim());
      toast.success(t.createdToast);
      // Closing triggers onOpenChange(false), which resets subject/body.
      setDialogOpen(false);
      await load();
    } catch {
      toast.error(t.createFailed);
    } finally {
      setSubmitting(false);
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
              </tr>
            </thead>
            <tbody>
              {tickets.map((ticket) => (
                <tr key={ticket.id}>
                  <td>
                    <Link
                      href={`/account/tickets/${ticket.id}`}
                      className="account-link"
                    >
                      {ticket.subject}
                    </Link>
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
            aria-label="关闭工单弹窗"
            onClick={() => {
              setDialogOpen(false);
              setSubject("");
              setBody("");
            }}
          />
          <section
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
                aria-label="关闭工单弹窗"
                onClick={() => {
                  setDialogOpen(false);
                  setSubject("");
                  setBody("");
                }}
              >
                x
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
    </div>
  );
}
