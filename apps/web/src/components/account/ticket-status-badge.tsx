"use client";

import { AccountStatusBadge } from "@/components/account/account-status-badge";
import { useDict } from "@/lib/i18n/client";
import type { TicketStatus } from "@/lib/account/user-types";

function statusVariant(
  status: TicketStatus
): "success" | "warning" | "muted" {
  switch (status) {
    case "ANSWERED":
      return "success";
    case "OPEN":
      return "warning";
    case "CLOSED":
    default:
      return "muted";
  }
}

/** Localized status badge shared by the ticket list and thread pages. */
export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  const dict = useDict();
  return (
    <AccountStatusBadge tone={statusVariant(status)}>
      {dict.portalApp.tickets.status[status]}
    </AccountStatusBadge>
  );
}
