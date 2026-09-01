"use client";

import { useEffect, useState } from "react";
import { ArrowUpIcon, ArrowDownIcon } from "lucide-react";

import { AccountEmpty, AccountSkeleton } from "./account-ui";
import { AccountStatusBadge } from "./account-status-badge";
import { getPortalOverview, setSubscriptionPriority } from "@/lib/account/user-api";
import {
  isSubscriptionActive,
  quotaMeterPercent,
  subscriptionPlanLabel,
} from "@/lib/account/subscription-status";
import type { OverviewSubscription } from "@/lib/account/user-types";
import { fmt } from "@/lib/i18n";
import { useDict } from "@/lib/i18n/client";

type MeterLevel = "ok" | "warn" | "critical";

function sortByPriority(subs: OverviewSubscription[]): OverviewSubscription[] {
  return [...subs].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
}

function productKey(p: string): "codex" | "claude" | "antigravity" | undefined {
  const s = p.toLowerCase();
  if (s.includes("codex")) return "codex";
  if (s.includes("claude")) return "claude";
  if (s.includes("anti") || s.includes("gravity")) return "antigravity";
  return undefined;
}

/** Remaining-fuel level for the 液位 meter — high remaining reads healthy. */
function remainMeter(sub: OverviewSubscription): { pct: number | null; level: MeterLevel } {
  const percents = [
    ...(sub.quota?.buckets ?? []),
    ...(sub.quota?.weeklyBuckets ?? []),
  ].flatMap((bucket) => {
    const pct = quotaMeterPercent(bucket);
    return pct == null ? [] : [pct];
  });
  if (percents.length === 0) return { pct: null, level: "ok" };
  const pct = Math.min(...percents);
  if (pct < 15) return { pct, level: "critical" };
  if (pct < 40) return { pct, level: "warn" };
  return { pct, level: "ok" };
}

export function SubscriptionsPanel() {
  const dict = useDict();
  const t = dict.portalApp.subscriptions;

  const [subs, setSubs] = useState<OverviewSubscription[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    getPortalOverview()
      .then((o) => setSubs(sortByPriority(o.subscriptions)))
      .catch(() => setError(true));
  }, []);

  async function move(index: number, dir: -1 | 1) {
    if (!subs || busy) return;
    const j = index + dir;
    if (j < 0 || j >= subs.length) return;
    setBusy(true);
    const next = [...subs];
    [next[index], next[j]] = [next[j], next[index]];
    setSubs(next); // optimistic
    try {
      // Renumber the whole list so priority becomes a stable 0..n-1 sequence.
      let latest: Awaited<ReturnType<typeof setSubscriptionPriority>> | null = null;
      for (let i = 0; i < next.length; i++) {
        latest = await setSubscriptionPriority(next[i].id, i);
      }
      if (latest) setSubs(sortByPriority(latest.subscriptions));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return <p className="account-form-error">{t.loadFailed}</p>;
  }
  if (!subs) {
    return (
      <div className="account-skeleton-stack">
        <AccountSkeleton className="account-skeleton--row" />
        <AccountSkeleton className="account-skeleton--row" />
        <AccountSkeleton className="account-skeleton--row" />
      </div>
    );
  }
  if (subs.length === 0) {
    return (
      <AccountEmpty title={t.empty} description={t.emptyDesc}>
        <a href="/account/billing" className="account-btn account-btn--primary">
          {t.buy}
        </a>
      </AccountEmpty>
    );
  }

  const now = Date.now();
  const levelLabel = (lv: MeterLevel) =>
    lv === "critical" ? t.levelCritical : lv === "warn" ? t.levelWarn : t.levelOk;

  return (
    <div className="account-relay">
      <ol className="account-relay-list">
        {subs.map((sub, i) => {
          const active = isSubscriptionActive(sub, now);
          const cancelled = sub.status.toUpperCase() === "CANCELLED";
          const statusLabel = cancelled
            ? t.statusCancelled
            : active
              ? t.statusActive
              : t.statusExpired;
          const meter = remainMeter(sub);
          const meterText = meter.pct === null ? t.unlimited : levelLabel(meter.level);
          return (
            <li
              key={sub.id}
              className="account-relay-item"
              data-first={i === 0 || undefined}
              data-busy={busy || undefined}
            >
              <div className="account-relay-rank">{i + 1}</div>

              <div className="account-relay-body">
                <div className="account-relay-head">
                  <span className="account-relay-name">
                    <span>{subscriptionPlanLabel(sub)}</span>
                    {i === 0 && <span className="account-relay-tag">{t.priorityTag}</span>}
                  </span>
                  <AccountStatusBadge tone={active ? "success" : "muted"}>
                    {statusLabel}
                  </AccountStatusBadge>
                </div>

                {sub.products.length > 0 && (
                  <div className="account-relay-products">
                    {sub.products.map((p) => (
                      <span key={p} className="account-prodchip" data-p={productKey(p)}>
                        {p}
                      </span>
                    ))}
                  </div>
                )}

                <div className="account-relay-meter" data-level={meter.level}>
                  <div className="account-relay-meter__head">
                    <span>{t.remainLabel}</span>
                    <span className="account-relay-meter__val">
                      {meter.pct === null ? t.unlimited : `${meter.pct}%`}
                      {meter.pct !== null && (
                        <span className="account-relay-meter__level">{meterText}</span>
                      )}
                    </span>
                  </div>
                  {meter.pct !== null && (
                    <div
                      className="account-meter"
                      data-level={meter.level}
                      role="progressbar"
                      aria-valuenow={meter.pct}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={fmt(t.remainMeter, { pct: meter.pct, level: meterText })}
                    >
                      <div
                        className="account-meter__fill"
                        style={{ width: `${meter.pct}%` }}
                      />
                    </div>
                  )}
                </div>

                <div className="account-relay-extra">
                  <span>
                    {t.expiresLabel}{" "}
                    <b>
                      {sub.expiresAt
                        ? new Date(sub.expiresAt).toLocaleDateString()
                        : t.neverExpires}
                    </b>
                  </span>
                </div>
              </div>

              <div className="account-relay-arrows">
                <button
                  type="button"
                  className="account-relay-arrow"
                  disabled={i === 0 || busy}
                  onClick={() => move(i, -1)}
                  aria-label={t.moveUp}
                >
                  <ArrowUpIcon />
                </button>
                <button
                  type="button"
                  className="account-relay-arrow"
                  disabled={i === subs.length - 1 || busy}
                  onClick={() => move(i, 1)}
                  aria-label={t.moveDown}
                >
                  <ArrowDownIcon />
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
