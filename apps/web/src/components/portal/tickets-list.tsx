"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { PlusIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Field, FieldLabel } from "@/components/ui/field";
import { createTicket, getTickets } from "@/lib/user-api";
import type { TicketStatus, TicketSummary } from "@/lib/user-types";
import { formatDateTime } from "@/lib/format";
import { useDict } from "@/lib/i18n/client";

function statusVariant(
  status: TicketStatus
): "secondary" | "outline" | "ghost" {
  switch (status) {
    case "ANSWERED":
      return "secondary";
    case "OPEN":
      return "outline";
    case "CLOSED":
    default:
      return "ghost";
  }
}

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
      setDialogOpen(false);
      setSubject("");
      setBody("");
      await load();
    } catch {
      toast.error(t.createFailed);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setDialogOpen(true)}>
          <PlusIcon data-icon="inline-start" />
          {t.newTicket}
        </Button>
      </div>

      {loadError && <p className="text-sm text-destructive">{t.loadFailed}</p>}

      {tickets === null ? (
        <div className="space-y-2">
          <Skeleton className="h-10 rounded-lg" />
          <Skeleton className="h-12 rounded-lg" />
          <Skeleton className="h-12 rounded-lg" />
        </div>
      ) : tickets.length === 0 ? (
        <Empty className="border min-h-[280px]">
          <EmptyHeader>
            <EmptyTitle>{t.empty}</EmptyTitle>
            <EmptyDescription>{t.emptyDesc}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="rounded-xl border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.colSubject}</TableHead>
                <TableHead>{t.colStatus}</TableHead>
                <TableHead>{t.colCreatedAt}</TableHead>
                <TableHead>{t.colUpdatedAt}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tickets.map((ticket) => (
                <TableRow key={ticket.id}>
                  <TableCell>
                    <Link
                      href={`/app/tickets/${ticket.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {ticket.subject}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(ticket.status)}>
                      {t.status[ticket.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {formatDateTime(ticket.createdAt)}
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {formatDateTime(ticket.updatedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.newTicket}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <Field>
              <FieldLabel>{t.subjectLabel}</FieldLabel>
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder={t.subjectPlaceholder}
                maxLength={120}
                required
                disabled={submitting}
              />
            </Field>
            <Field>
              <FieldLabel>{t.bodyLabel}</FieldLabel>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={t.bodyPlaceholder}
                rows={5}
                required
                disabled={submitting}
              />
            </Field>
            <DialogFooter>
              <Button
                type="submit"
                disabled={submitting || !subject.trim() || !body.trim()}
              >
                {submitting ? t.submitting : t.submit}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
