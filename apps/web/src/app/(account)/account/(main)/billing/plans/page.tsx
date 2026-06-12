"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeftIcon, SparklesIcon } from "lucide-react";

import { CatalogPurchase } from "@/components/account/catalog-purchase";
import { AccountSkeleton } from "@/components/account/account-ui";
import { getPlanCatalog } from "@/lib/account/user-api";
import type { CatalogConfig } from "@/lib/account/catalog-pricing";
import { useDict } from "@/lib/i18n/client";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; catalog: CatalogConfig }
  | { kind: "unavailable" } // backend up, but nothing PUBLISHED
  | { kind: "error" }; // fetch failed

/**
 * Catalog purchase page (spec §3/§7) — two-line pure selection + live price.
 * Lives under /account/billing/plans so it inherits the account shell and sits
 * one click from the payment center.
 */
export default function CatalogPlansPage() {
  const dict = useDict();
  const c = dict.portalApp.billing.catalog;
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    getPlanCatalog()
      .then((res) => {
        if (!alive) return;
        if (res.config) setState({ kind: "ready", catalog: res.config });
        else setState({ kind: "unavailable" });
      })
      .catch(() => {
        if (alive) setState({ kind: "error" });
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="account-catalog-page">
      <header className="account-catalog-page__head">
        <Link href="/account/billing" className="account-catalog-back">
          <ArrowLeftIcon />
          {c.back}
        </Link>
        <div className="account-catalog-page__title">
          <SparklesIcon />
          <div>
            <h2>{c.pageTitle}</h2>
            <p>{c.pageDesc}</p>
          </div>
        </div>
      </header>

      {state.kind === "loading" && (
        <div className="account-catalog-loading">
          <AccountSkeleton className="account-skeleton--catalog" />
          <AccountSkeleton className="account-skeleton--catalog" />
        </div>
      )}

      {state.kind === "ready" && <CatalogPurchase catalog={state.catalog} />}

      {state.kind === "unavailable" && (
        <div className="account-catalog-empty">
          <strong>{c.unavailableTitle}</strong>
          <p>{c.unavailableDesc}</p>
        </div>
      )}

      {state.kind === "error" && (
        <div className="account-catalog-empty">
          <strong>{c.loadFailed}</strong>
        </div>
      )}
    </div>
  );
}
