"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { PublicPortalSimple } from "../../components/public-portal-simple";

function SimplePortalContent() {
  const searchParams = useSearchParams();
  const tab = searchParams.get("tab");
  const validTabs = ["submit", "track", "swap", "migrate"] as const;
  const defaultTab = validTabs.includes(tab as any)
    ? (tab as "submit" | "track" | "swap" | "migrate")
    : "submit";

  return <PublicPortalSimple defaultTab={defaultTab} />;
}

export default function SimplePortalPage() {
  return (
    <Suspense fallback={<div style={{ padding: 16 }}>…</div>}>
      <SimplePortalContent />
    </Suspense>
  );
}
