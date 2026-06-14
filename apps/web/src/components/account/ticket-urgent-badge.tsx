"use client";

import { AccountStatusBadge } from "@/components/account/account-status-badge";
import { useDict } from "@/lib/i18n/client";

/** Red "urgent" (加急) badge shared by the ticket list and thread. */
export function TicketUrgentBadge() {
  const dict = useDict();
  return (
    <AccountStatusBadge tone="destructive">
      {dict.portalApp.tickets.urgentBadge}
    </AccountStatusBadge>
  );
}
