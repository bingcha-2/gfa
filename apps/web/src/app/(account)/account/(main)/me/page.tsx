import { getDict } from "@/lib/i18n/server";
import { PageHeader } from "@/components/account/page-header";
import { AccountMe } from "@/components/account/account-me";

export const dynamic = "force-dynamic";

export default async function MePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const dict = await getDict();
  const t = dict.portalApp;
  const sp = await searchParams;
  const initialTab = sp?.tab === "security" ? "security" : "devices";

  return (
    <div className="account-me">
      <PageHeader title={t.pages.meTitle} />
      <AccountMe initialTab={initialTab} />
    </div>
  );
}
