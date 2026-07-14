"use client";

import { AccountPill } from "./account-ui";
import { formatTokens } from "@/lib/format";
import { fmt } from "@/lib/i18n";
import { useDict } from "@/lib/i18n/client";
import type { SubscriptionQuota } from "@/lib/account/user-types";

export type QuotaLevel = "ok" | "warn" | "critical";

/** Integer percent used, clamped 0-100. Zero/negative limit → 0 (no cap). */
export function quotaPercent(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

/** Integer percent remaining, clamped 0-100. Zero/negative limit means no active cap. */
export function quotaRemainingPercent(used: number, limit: number): number {
  if (limit <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((1 - used / limit) * 100)));
}

/** Remaining quota: 40-100% green, 15-39% amber, 0-14% red. */
export function quotaLevel(used: number, limit: number): QuotaLevel {
  const remaining = quotaRemainingPercent(used, limit);
  if (remaining < 15) return "critical";
  if (remaining < 40) return "warn";
  return "ok";
}

/**
 * "3 小时 12 分钟" / "5 分钟" from a reset-in milliseconds value.
 * Returns null when there is nothing meaningful to show.
 */
export function formatResetText(
  ms: number | null,
  templates: { hoursMinutes: string; minutesOnly: string }
): string | null {
  if (!ms || ms <= 0) return null;
  const totalMinutes = Math.max(1, Math.ceil(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 1) {
    return fmt(templates.hoursMinutes, { h: hours, m: minutes });
  }
  return fmt(templates.minutesOnly, { m: minutes });
}

function Bar({
  label,
  used,
  limit,
  resetText,
  formatValue = formatTokens,
  remainingLabel,
}: {
  label: string;
  used: number;
  limit: number;
  resetText: string | null;
  formatValue?: (value: number) => string;
  remainingLabel?: string;
}) {
  const usedPct = quotaPercent(used, limit);
  const pct = remainingLabel ? quotaRemainingPercent(used, limit) : usedPct;
  const level = quotaLevel(used, limit);

  return (
    <div className="account-quota-bar">
      <div className="account-quota-bar__meta">
        <span>{label}</span>
        <span>
          {remainingLabel ? `${remainingLabel} ${pct}%` : `${formatValue(used)} / ${formatValue(limit)}`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        data-level={level}
        className="account-quota-bar__track"
      >
        <div
          className="account-quota-bar__fill"
          style={{ width: `${pct}%` }}
        />
      </div>
      {resetText && (
        <div className="account-quota-bar__reset">{resetText}</div>
      )}
    </div>
  );
}

/** Per-subscription quota bars — buckets + optional weekly cap. */
export function QuotaBar({ quota }: { quota: SubscriptionQuota }) {
  const dict = useDict();
  const q = dict.portalApp.quota;

  if (quota.quotaMode === "unlimited") {
    return (
      <div className="account-quota-inline">
        <AccountPill tone="success">{q.unlimited}</AccountPill>
        <span>
          {fmt(q.windowUsed, { tokens: formatTokens(quota.recentWindowTokens) })}
        </span>
      </div>
    );
  }

  const windowResetText = formatResetText(quota.tokenWindowResetMs, {
    hoursMinutes: q.hoursMinutes,
    minutesOnly: q.minutesOnly,
  });
  const weeklyResetText = formatResetText(quota.weeklyWindowResetMs, {
    hoursMinutes: q.hoursMinutes,
    minutesOnly: q.minutesOnly,
  });
  const productQuotas = Object.entries(quota.usdQuotaByProduct ?? {});

  return (
    <div className="account-quota-stack">
      {quota.quotaMode === "usd" && (
        <AccountPill tone="info">{q.usdBadge}</AccountPill>
      )}
      {quota.quotaMode === "dynamic" && (
        <AccountPill tone="info">{q.dynamicBadge}</AccountPill>
      )}

      {quota.quotaMode === "usd" ? (
        <>
          {productQuotas.map(([product, productQuota]) => (
            <section key={product} aria-label={`${product} ${q.usdBadge}`}>
              <strong>{product}</strong>
              {productQuota.fiveHour && (
                <Bar
                  label={q.usd5hLabel}
                  used={productQuota.fiveHour.used}
                  limit={productQuota.fiveHour.limit}
                  remainingLabel={q.remainingLabel}
                  resetText={formatResetText(productQuota.fiveHour.resetMs, { hoursMinutes: q.hoursMinutes, minutesOnly: q.minutesOnly })}
                />
              )}
              {productQuota.weekly && (
                <Bar
                  label={q.usdWeeklyLabel}
                  used={productQuota.weekly.used}
                  limit={productQuota.weekly.limit}
                  remainingLabel={q.remainingLabel}
                  resetText={formatResetText(productQuota.weekly.resetMs, { hoursMinutes: q.hoursMinutes, minutesOnly: q.minutesOnly })}
                />
              )}
            </section>
          ))}
        </>
      ) : quota.buckets.length === 0 ? (
        <p className="account-muted-note">{q.noBuckets}</p>
      ) : (
        quota.buckets.map((bucket) => (
          <Bar
            key={bucket.bucket}
            label={bucket.bucket}
            used={bucket.used ?? 0}
            limit={bucket.limit}
            resetText={
              windowResetText ? fmt(q.resetIn, { time: windowResetText }) : null
            }
          />
        ))
      )}

      {quota.quotaMode !== "usd" && quota.weeklyTokenLimit != null && quota.weeklyTokenLimit > 0 && (
        <Bar
          label={q.weeklyLabel}
          used={quota.weeklyWindowTokens}
          limit={quota.weeklyTokenLimit}
          resetText={
            weeklyResetText ? fmt(q.resetIn, { time: weeklyResetText }) : null
          }
        />
      )}
    </div>
  );
}
