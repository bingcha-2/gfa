"use client";

import {
  CreditCardIcon,
  CalendarIcon,
  BarChart2Icon,
  MonitorSmartphoneIcon,
} from "lucide-react";

import { usePortal } from "@/components/portal/portal-provider";
import { useDict } from "@/lib/i18n/client";
import { PageHeader } from "@/components/portal/page-header";
import { StatCard } from "@/components/portal/stat-card";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";

/**
 * Overview — consumes the customer the (main) layout guard already fetched
 * (passed through PortalShell → PortalProvider); no second /web/me round-trip.
 * Parent layout is force-dynamic, so no route segment config needed here.
 */
export default function OverviewPage() {
  const { customer } = usePortal();
  const dict = useDict();
  const t = dict.portalApp;
  const ov = t.overview;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t.pages.overviewTitle}
        description={customer.email}
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
