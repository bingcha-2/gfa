"use client";

import { Badge } from "@/components/ui/badge";
import { formatTokens } from "@/lib/format";
import { fmt } from "@/lib/i18n";
import { useDict } from "@/lib/i18n/client";
import type { SubscriptionQuota } from "@/lib/user-types";
import { cn } from "@/lib/utils";

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

const LEVEL_BAR_CLASS: Record<QuotaLevel, string> = {
  // Emerald/amber/destructive mirror the repo's status hues (.status-emerald,
  // amber accent, semantic destructive token).
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  critical: "bg-destructive",
};

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
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {formatTokens(used)} / {formatTokens(limit)}
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        data-level={level}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full transition-all duration-200",
            LEVEL_BAR_CLASS[level]
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      {resetText && (
        <div className="text-[11px] text-muted-foreground tabular-nums">
          {resetText}
        </div>
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
      <div className="flex items-center gap-2">
        <Badge variant="secondary">{q.unlimited}</Badge>
        <span className="text-xs text-muted-foreground tabular-nums">
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
    <div className="space-y-3">
      {quota.quotaMode === "dynamic" && (
        <Badge variant="outline">{q.dynamicBadge}</Badge>
      )}

      {quota.buckets.length === 0 ? (
        <p className="text-xs text-muted-foreground">{q.noBuckets}</p>
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
          used={quota.totalTokensUsed}
          limit={quota.weeklyTokenLimit}
          resetText={
            weeklyResetText ? fmt(q.resetIn, { time: weeklyResetText }) : null
          }
        />
      )}
    </div>
  );
}
