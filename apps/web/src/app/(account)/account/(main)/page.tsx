"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  BarChart2Icon,
  BellIcon,
  CalendarIcon,
  CreditCardIcon,
  MonitorSmartphoneIcon,
} from "lucide-react";

import { useAccount } from "@/components/account/account-provider";
import { QuotaBar } from "@/components/account/quota-bar";
import { PageHeader } from "@/components/account/page-header";
import { StatCard } from "@/components/account/stat-card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { getPortalOverview } from "@/lib/account/user-api";
import type { OverviewSubscription, AccountOverview } from "@/lib/account/user-types";
import { formatDateTime, formatTokens } from "@/lib/format";
import { fmt } from "@/lib/i18n";
import { useDict } from "@/lib/i18n/client";

/** Best subscription: ACTIVE first, then the one expiring latest (null expiry = no expiry → best). */
function pickBestSubscription(
  subscriptions: OverviewSubscription[]
): OverviewSubscription | null {
  if (subscriptions.length === 0) return null;
  const score = (sub: OverviewSubscription) => ({
    active: sub.status.toUpperCase() === "ACTIVE" ? 1 : 0,
    expiry: sub.expiresAt
      ? new Date(sub.expiresAt).getTime()
      : Number.MAX_SAFE_INTEGER,
  });
  return [...subscriptions].sort((a, z) => {
    const sa = score(a);
    const sz = score(z);
    if (sa.active !== sz.active) return sz.active - sa.active;
    return sz.expiry - sa.expiry;
  })[0];
}

export default function OverviewPage() {
  const { customer } = useAccount();
  const dict = useDict();
  const t = dict.portalApp;
  const ov = t.overview;
  const b = t.billing;

  const [overview, setOverview] = useState<AccountOverview | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    getPortalOverview()
      .then(setOverview)
      .catch(() => setLoadError(true));
  }, []);

  const loading = overview === null && !loadError;
  const best = overview ? pickBestSubscription(overview.subscriptions) : null;

  const planValue = overview
    ? best
      ? best.planName ?? b.migratedPlanName
      : ov.noPlan
    : undefined;

  const expiresValue = overview
    ? best
      ? best.expiresAt
        ? formatDateTime(best.expiresAt)
        : b.neverExpires
      : ov.noExpiry
    : undefined;

  const usageValue = overview
    ? best
      ? formatTokens(best.quota.recentWindowTokens)
      : "—"
    : undefined;

  const devicesValue = overview
    ? `${overview.devices.count} / ${overview.devices.limit}`
    : undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t.pages.overviewTitle}
        description={customer.email}
        actions={
          overview && overview.unreadNotifications > 0 ? (
            <Link href="/account/notifications">
              <Badge variant="secondary" className="gap-1">
                <BellIcon className="size-3" />
                {fmt(ov.unreadChip, { n: overview.unreadNotifications })}
              </Badge>
            </Link>
          ) : undefined
        }
      />

      {loadError && (
        <p className="text-sm text-destructive">{ov.loadFailed}</p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={ov.planLabel}
          value={planValue}
          loading={loading}
          icon={<CreditCardIcon />}
        />
        <StatCard
          label={ov.expiresLabel}
          value={expiresValue}
          loading={loading}
          icon={<CalendarIcon />}
        />
        <StatCard
          label={ov.usageLabel}
          value={usageValue}
          loading={loading}
          icon={<BarChart2Icon />}
        />
        <StatCard
          label={ov.devicesLabel}
          value={devicesValue}
          loading={loading}
          icon={<MonitorSmartphoneIcon />}
        />
      </div>

      {/* ── 额度状态 ────────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <h3 className="text-sm font-medium">{ov.quotaSection}</h3>

        {loading ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-40 rounded-xl" />
            <Skeleton className="h-40 rounded-xl" />
          </div>
        ) : overview && overview.subscriptions.length > 0 ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {overview.subscriptions.map((sub) => (
              <div
                key={sub.id}
                className="rounded-xl border bg-card p-5 space-y-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    {sub.planName ?? b.migratedPlanName}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {sub.migratedFromCard && (
                      <Badge variant="outline">{b.migratedBadge}</Badge>
                    )}
                    <Badge variant="secondary">
                      {sub.weight >= 8 ? b.weightDedicated : b.weightShared}
                    </Badge>
                  </div>
                </div>
                <QuotaBar quota={sub.quota} />
              </div>
            ))}
          </div>
        ) : (
          <Empty className="border min-h-[160px]">
            <EmptyHeader>
              <EmptyTitle>{b.currentEmpty}</EmptyTitle>
              <EmptyDescription>{b.currentEmptyDesc}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Link
                href="/account/billing"
                className="text-sm text-accent underline-offset-4 hover:underline"
              >
                {ov.goBilling}
              </Link>
            </EmptyContent>
          </Empty>
        )}
      </section>
    </div>
  );
}
