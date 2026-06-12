"use client";

import { useEffect, useState } from "react";

import { useAccount } from "@/components/account/account-provider";
import { AccountOverviewPanel } from "@/components/account/account-overview-panel";
import { getPortalOverview } from "@/lib/account/user-api";
import type { AccountOverview } from "@/lib/account/user-types";

export default function OverviewPage() {
  const { customer } = useAccount();
  const [overview, setOverview] = useState<AccountOverview | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    getPortalOverview()
      .then(setOverview)
      .catch(() => setLoadError(true));
  }, []);

  const loading = overview === null && !loadError;

  return (
    <AccountOverviewPanel
      customerId={customer.id}
      overview={overview}
      loading={loading}
      loadError={loadError}
    />
  );
}
