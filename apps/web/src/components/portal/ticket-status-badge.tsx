"use client";

import { Badge } from "@/components/ui/badge";
import { useDict } from "@/lib/i18n/client";
import type { TicketStatus } from "@/lib/user-types";

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

/** Localized status badge shared by the ticket list and thread pages. */
export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  const dict = useDict();
  return (
    <Badge variant={statusVariant(status)}>
      {dict.portalApp.tickets.status[status]}
    </Badge>
  );
}
