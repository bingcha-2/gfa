import { getDict } from "@/lib/i18n/server";
import { PageHeader } from "@/components/portal/page-header";
import { NotificationsList } from "@/components/portal/notifications-list";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const dict = await getDict();
  const t = dict.portalApp;
  return (
    <div className="space-y-6">
      <PageHeader title={t.pages.notificationsTitle} />
      <NotificationsList />
    </div>
  );
}
