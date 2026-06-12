import { getDict } from "@/lib/i18n/server";
import { PageHeader } from "@/components/account/page-header";
import { NotificationsList } from "@/components/account/notifications-list";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const dict = await getDict();
  const t = dict.portalApp;
  return (
    <div className="account-page">
      <PageHeader title={t.pages.notificationsTitle} />
      <NotificationsList />
    </div>
  );
}
