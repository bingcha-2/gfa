import { getDict } from "@/lib/i18n/server";
import { PageHeader } from "@/components/portal/page-header";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";

export const dynamic = "force-dynamic";

export default async function ReferralPage() {
  const dict = await getDict();
  const t = dict.portalApp;
  return (
    <div className="space-y-6">
      <PageHeader title={t.pages.referralTitle} />
      <Empty className="border min-h-[300px]">
        <EmptyHeader>
          <EmptyTitle>{t.placeholder.comingSoon}</EmptyTitle>
          <EmptyDescription>{t.placeholder.comingSoonDesc}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
