import { getDict } from "@/lib/i18n/server";
import { PageHeader } from "@/components/account/page-header";
import { UsageView } from "@/components/account/usage-view";

export const dynamic = "force-dynamic";

export default async function UsagePage() {
  const dict = await getDict();
  const t = dict.portalApp;
  return (
    <div className="account-page">
      <PageHeader title={t.pages.usageTitle} />
      <UsageView />
    </div>
  );
}
