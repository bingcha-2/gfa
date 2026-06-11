import { getDict } from "@/lib/i18n/server";
import { PageHeader } from "@/components/portal/page-header";
import { UsageTable } from "@/components/portal/usage-table";

export const dynamic = "force-dynamic";

export default async function UsagePage() {
  const dict = await getDict();
  const t = dict.portalApp;
  return (
    <div className="space-y-6">
      <PageHeader title={t.pages.usageTitle} />
      <UsageTable />
    </div>
  );
}
