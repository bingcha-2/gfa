"use client";

import Link from "next/link";
import {
  RefreshCwIcon,
  DownloadIcon,
  ReceiptTextIcon,
  BellIcon,
  MessageSquareIcon,
  LayersIcon,
} from "lucide-react";

import { AccountSkeleton } from "./account-ui";
import type {
  AccountOverview,
  SubscriptionQuota,
} from "@/lib/account/user-types";
import {
  deriveMembershipStatus,
  productEntitlementBadge,
  subscriptionPlanLabel,
  type MembershipState,
} from "@/lib/account/subscription-status";
import { formatTokens } from "@/lib/format";
import { fmt } from "@/lib/i18n";
import { useDict } from "@/lib/i18n/client";

const STATE_LAMP: Record<MembershipState, "success" | "warning" | "danger" | "brand"> = {
  active: "success",
  expiring_soon: "warning",
  expired: "danger",
  none: "brand",
};
const STATE_STAT_TONE: Record<MembershipState, "ok" | "warn" | "danger" | undefined> = {
  active: "ok",
  expiring_soon: "warn",
  expired: "danger",
  none: undefined,
};

function usedPercent(quota: SubscriptionQuota | null): number | null {
  if (!quota) return null;
  const first = quota.buckets[0];
  if (!first || first.limit <= 0) return null;
  return Math.min(100, Math.round(((first.used ?? 0) / first.limit) * 100));
}

function productKey(p: string): "codex" | "claude" | "antigravity" | "" {
  const s = p.toLowerCase();
  if (s.includes("codex")) return "codex";
  if (s.includes("claude")) return "claude";
  if (s.includes("anti") || s.includes("gravity")) return "antigravity";
  return "";
}

function mmYY(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")} / ${String(d.getFullYear()).slice(2)}`;
}

function LoadingPanel() {
  return (
    <div className="account-overview" data-testid="account-overview-panel">
      <section className="account-overview-hero">
        <div className="account-overview-hero__copy">
          <AccountSkeleton className="account-skeleton--heading" />
          <AccountSkeleton className="account-skeleton--hero" />
        </div>
        <div className="account-overview-hero__side">
          <AccountSkeleton style={{ aspectRatio: "1.6 / 1", borderRadius: "22px" }} />
        </div>
      </section>
      <AccountSkeleton className="account-skeleton--row" />
    </div>
  );
}

export function AccountOverviewPanel({
  customerId,
  overview,
  loading,
  loadError,
}: {
  customerId: string;
  overview: AccountOverview | null;
  loading: boolean;
  loadError: boolean;
}) {
  const dict = useDict();
  const o = dict.portalApp.overview;

  const { state, best, daysLeft } = deriveMembershipStatus(
    overview?.subscriptions ?? [],
    Date.now()
  );
  const quota = best?.quota ?? null;
  const usedPct = usedPercent(quota);
  const remainPct = usedPct === null ? null : 100 - usedPct;
  const hasPlan = Boolean(best);
  const needsRenew = state === "expired" || state === "expiring_soon";

  const planName = best ? subscriptionPlanLabel(best) : o.noPlanName;
  const products = best?.products ?? [];
  const entitlement = productEntitlementBadge(state);
  const deviceCount = overview?.devices.count ?? 0;
  const deviceLimit = overview?.devices.limit ?? 0;
  const unread = overview?.unreadNotifications ?? 0;

  const expiresAt = best?.expiresAt ?? null;
  const validThru = expiresAt ? mmYY(expiresAt) : hasPlan ? "∞" : "—";
  const expiresOn = expiresAt ? expiresAt.slice(0, 10) : null;
  const tier = state === "expired" ? "EXPIRED" : hasPlan ? "ACTIVE" : "FREE";

  const eyebrowLabel: Record<MembershipState, string> = {
    active: o.statusRunning,
    expiring_soon: o.statusExpiringSoon,
    expired: o.statusExpired,
    none: o.statusPending,
  };
  const acctLabel: Record<MembershipState, string> = {
    active: o.acctNormal,
    expiring_soon: o.acctExpiringSoon,
    expired: o.acctExpired,
    none: o.acctNone,
  };

  const idRaw = (customerId || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  const memberId = idRaw ? `${idRaw.slice(0, 4)} ${idRaw.slice(4, 8)}` : "————";

  const dotTotal = Math.min(deviceLimit || 0, 6);

  if (loading) return <LoadingPanel />;

  return (
    <div className="account-overview" data-testid="account-overview-panel">
      <section className="account-overview-hero">
        <div className="account-overview-hero__copy">
          <div className="account-overview-status">
            <span className="account-overview-hero__eyebrow">
              <span
                className="account-status-lamp"
                data-tone={loadError ? "info" : STATE_LAMP[state]}
              />
              MEMBERSHIP / {loadError ? o.statusError : eyebrowLabel[state]}
            </span>
            <h1>
              {o.heroPre}
              <span className="am">{o.heroBrand}</span>
              <br />
              {o.heroTitle}
            </h1>
            <p className="account-overview-hero__sub">{o.heroSub}</p>
          </div>
          <div className="account-overview-hero__actions account-overview-actions">
            <Link href="/account/billing" className="account-btn account-btn--primary">
              <RefreshCwIcon />
              {needsRenew ? o.renewNow : hasPlan ? o.renewOrBuy : o.buy}
            </Link>
            <Link href="/account/download" className="account-btn account-btn--secondary">
              <DownloadIcon />
              {o.installClient}
            </Link>
          </div>
        </div>

        <div className="account-overview-hero__side">
          <div className="account-pass-wrap">
            <div className="account-pass">
              <div className="account-pass__top">
                <div>
                  <div className="account-pass__lab">MEMBER PASS</div>
                  <div className="account-pass__brand">
                    <span className="mk">
                      <img src="/bcai-icon.png" alt="" />
                    </span>
                    {dict.common.brandName}
                  </div>
                </div>
                <span className="account-pass__tier" data-tier={tier.toLowerCase()}>
                  {tier}
                </span>
              </div>
              <div className="account-pass__chip" aria-hidden />
              <div className="account-pass__mid">
                <div className="account-pass__plan">
                  {planName}
                  <small>{hasPlan ? o.passMembership : o.passNoPlan}</small>
                </div>
                {dotTotal > 0 && (
                  <div
                    className="account-pass__punch"
                    title={fmt(o.passDevicesTitle, { count: deviceCount, limit: deviceLimit })}
                  >
                    {Array.from({ length: dotTotal }).map((_, i) => (
                      <i key={i} data-off={i >= deviceCount || undefined} />
                    ))}
                  </div>
                )}
              </div>
              <div className="account-pass__bot">
                <div className="account-pass__id">
                  <small>MEMBER ID</small>
                  BCAI · {memberId}
                </div>
                <div className="account-pass__thru">
                  <small>VALID THRU</small>
                  <b>{validThru}</b>
                </div>
              </div>
            </div>
          </div>
          {products.length > 0 && (
            <div
              className="account-overview-hero__prod"
              data-muted={!entitlement.active || undefined}
            >
              <span className="pl">
                {entitlement.active ? o.entitledProducts : o.lapsedProducts}
              </span>
              <span className="account-prodchips">
                {products.map((p) => (
                  <span key={p} className="account-prodchip" data-p={productKey(p)}>
                    {p}
                  </span>
                ))}
              </span>
            </div>
          )}
        </div>
      </section>

      {needsRenew && !loadError && (
        <div className="account-overview-warn" data-state={state} role="status">
          <div className="account-overview-warn__text">
            <strong>{state === "expired" ? o.warnExpiredTitle : o.warnExpiringTitle}</strong>
            <span>
              {state === "expired"
                ? expiresOn
                  ? fmt(o.warnExpiredDated, { plan: planName, date: expiresOn })
                  : fmt(o.warnExpiredUndated, { plan: planName })
                : fmt(o.warnExpiringDated, {
                    plan: planName,
                    date: expiresOn ?? "",
                    days: daysLeft ?? 0,
                  })}
            </span>
          </div>
          <Link
            href="/account/billing"
            className="account-btn account-btn--primary account-btn--compact"
          >
            <RefreshCwIcon />
            {o.renewNow}
          </Link>
        </div>
      )}

      {loadError && (
        <p className="account-overview-error">{o.loadErrorKeepEntry}</p>
      )}

      <section className="account-overview-stats account-overview-statstrip" aria-label={o.statsAria}>
        <div>
          <span className="k">{o.statQuota}</span>
          <span className="v acc-mono" data-tone={remainPct !== null && remainPct > 20 ? "ok" : undefined}>
            {remainPct === null ? "—" : remainPct}
            {remainPct !== null && <small>%</small>}
          </span>
        </div>
        <div>
          <span className="k">{o.statDevices}</span>
          <span className="v acc-mono">
            {deviceCount}
            <small>/ {deviceLimit || "—"}</small>
          </span>
        </div>
        <div>
          <span className="k">{o.statUsage}</span>
          <span className="v acc-mono">
            {quota ? formatTokens(quota.recentWindowTokens) : "—"}
          </span>
        </div>
        <div>
          <span className="k">{o.statStatus}</span>
          <span className="v" data-tone={STATE_STAT_TONE[state]}>
            {acctLabel[state]}
          </span>
        </div>
      </section>

      <section className="account-overview-grid" aria-label={o.quickAria}>
        <Link href="/account/subscriptions" className="account-quick-card">
          <div className="account-quick-card__top">
            <span className="account-quick-card__icon">
              <LayersIcon />
            </span>
          </div>
          <div className="account-quick-card__title">{o.cardSubsTitle}</div>
          <div className="account-quick-card__desc">{o.cardSubsDesc}</div>
        </Link>
        <Link href="/account/billing" className="account-quick-card">
          <div className="account-quick-card__top">
            <span className="account-quick-card__icon">
              <ReceiptTextIcon />
            </span>
          </div>
          <div className="account-quick-card__title">{o.cardBillingTitle}</div>
          <div className="account-quick-card__desc">{o.cardBillingDesc}</div>
        </Link>
        <Link href="/account/notifications" className="account-quick-card">
          <div className="account-quick-card__top">
            <span className="account-quick-card__icon">
              <BellIcon />
            </span>
            {unread > 0 && (
              <span className="account-quick-card__badge">
                {fmt(o.cardUnread, { n: unread })}
              </span>
            )}
          </div>
          <div className="account-quick-card__title">{o.cardNotifTitle}</div>
          <div className="account-quick-card__desc">{o.cardNotifDesc}</div>
        </Link>
        <Link href="/account/download" className="account-quick-card">
          <div className="account-quick-card__top">
            <span className="account-quick-card__icon">
              <DownloadIcon />
            </span>
          </div>
          <div className="account-quick-card__title">{o.cardDownloadTitle}</div>
          <div className="account-quick-card__desc">{o.cardDownloadDesc}</div>
        </Link>
        <Link href="/account/tickets" className="account-quick-card">
          <div className="account-quick-card__top">
            <span className="account-quick-card__icon">
              <MessageSquareIcon />
            </span>
          </div>
          <div className="account-quick-card__title">{o.cardTicketTitle}</div>
          <div className="account-quick-card__desc">{o.cardTicketDesc}</div>
        </Link>
      </section>
    </div>
  );
}
