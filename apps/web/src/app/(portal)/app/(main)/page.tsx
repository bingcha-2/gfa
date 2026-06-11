import {
  CreditCardIcon,
  CalendarIcon,
  BarChart2Icon,
  MonitorSmartphoneIcon,
} from "lucide-react";

import { serverUserApi } from "@/lib/user-server-api";
import { getDict } from "@/lib/i18n/server";
import { PageHeader } from "@/components/portal/page-header";
import { StatCard } from "@/components/portal/stat-card";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import type { Customer } from "@/lib/user-types";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const dict = await getDict();
  const t = dict.portalApp;
  const ov = t.overview;

  // Re-fetch customer here for fresh data (already validated in layout)
  let customer: Customer | null = null;
  try {
    customer = await serverUserApi<Customer>("me");
  } catch {
    // Layout would have redirected; this is a safety fallback
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t.pages.overviewTitle}
        description={customer?.email}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={ov.planLabel}
          value={ov.noPlan}
          icon={<CreditCardIcon />}
        />
        <StatCard
          label={ov.expiresLabel}
          value={ov.noExpiry}
          icon={<CalendarIcon />}
        />
        <StatCard
          label={ov.usageLabel}
          value="—"
          icon={<BarChart2Icon />}
        />
        <StatCard
          label={ov.devicesLabel}
          value="—"
          icon={<MonitorSmartphoneIcon />}
        />
      </div>

      <Empty className="border mt-8 min-h-[200px]">
        <EmptyHeader>
          <EmptyTitle>{ov.comingSoon}</EmptyTitle>
          <EmptyDescription>{ov.comingSoonDesc}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
