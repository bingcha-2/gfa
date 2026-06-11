import { getDict } from "@/lib/i18n/server";
import { PageHeader } from "@/components/portal/page-header";
import { TicketThread } from "@/components/portal/ticket-thread";

export const dynamic = "force-dynamic";

export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const dict = await getDict();
  const t = dict.portalApp;

  return (
    <div className="space-y-6">
      <PageHeader title={t.pages.ticketsTitle} />
      <TicketThread ticketId={id} />
    </div>
  );
}
