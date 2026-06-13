import { getDict } from "@/lib/i18n/server";
import { PageHeader } from "@/components/account/page-header";
import { SubscriptionsPanel } from "@/components/account/subscriptions-panel";

export const dynamic = "force-dynamic";

export default async function SubscriptionsPage() {
  const dict = await getDict();
  return (
    <div className="account-page">
      <PageHeader
        title={dict.portalApp.pages.subscriptionsTitle}
        description={dict.portalApp.subscriptions.pageDesc}
      />
      <SubscriptionsPanel />
    </div>
  );
}
