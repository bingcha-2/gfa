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

/** 血条 semantics: <60% ok (green), 60-85% warn (amber), >=85% critical (red). */
export function quotaLevel(used: number, limit: number): QuotaLevel {
  const pct = limit <= 0 ? 0 : (used / limit) * 100;
  if (pct >= 85) return "critical";
  if (pct >= 60) return "warn";
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
}: {
  label: string;
  used: number;
  limit: number;
  resetText: string | null;
}) {
  const pct = quotaPercent(used, limit);
  const level = quotaLevel(used, limit);

  return (
    <div className="account-quota-bar">
      <div className="account-quota-bar__meta">
        <span>{label}</span>
        <span>
          {formatTokens(used)} / {formatTokens(limit)}
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

  return (
    <div className="account-quota-stack">
      {quota.quotaMode === "dynamic" && (
        <AccountPill tone="info">{q.dynamicBadge}</AccountPill>
      )}

      {quota.buckets.length === 0 ? (
        <p className="account-muted-note">{q.noBuckets}</p>
      ) : (
        quota.buckets.map((bucket) => (
          <Bar
            key={bucket.bucket}
            label={bucket.bucket}
            used={bucket.used}
            limit={bucket.limit}
            resetText={
              windowResetText ? fmt(q.resetIn, { time: windowResetText }) : null
            }
          />
        ))
      )}

      {quota.weeklyTokenLimit != null && quota.weeklyTokenLimit > 0 && (
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
