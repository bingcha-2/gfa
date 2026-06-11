import { getDict } from "@/lib/i18n/server";
import { PageHeader } from "@/components/portal/page-header";
import { TicketsList } from "@/components/portal/tickets-list";

export const dynamic = "force-dynamic";

export default async function TicketsPage() {
  const dict = await getDict();
  const t = dict.portalApp;
  return (
    <div className="space-y-6">
      <PageHeader title={t.pages.ticketsTitle} />
      <TicketsList />
    </div>
  );
}
