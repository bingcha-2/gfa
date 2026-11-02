import type { AccountUsage } from "./upstream-client";

// Upstream polls every 300 seconds. Allow one extra polling interval, but never
// treat generatedAt (a cached snapshot read) as the actual observation time.
const MAX_READING_AGE_MS = 600_000;

/** Normalize account readings for existing quota consumers. Legacy stored key
 * snapshots remain readable until the first successful account refresh. These
 * account windows are NOT private-key quota shares or calibration ledgers. */
export function accountUsageRows(value: unknown, now = Date.now()): any[] {
  if (Array.isArray(value)) return value;
  const account = (value as AccountUsage | null)?.account;
  if (!account || !Array.isArray(account.windows)) return [];
  const windows: Record<string, unknown> = {};
  for (const [period, bucket] of [["5h", "unified5h"], ["7d", "unified7d"]]) {
    const matches = account.windows.filter(w => w.bucket === bucket);
    if (matches.length !== 1) continue;
    const w = matches[0];
    const seenAt = w.seenAt;
    const fresh = typeof seenAt === "number" && Number.isSafeInteger(seenAt) &&
      seenAt > 0 && seenAt <= now && now - seenAt <= MAX_READING_AGE_MS;
    windows[period] = {
      remaining: w.remaining, accountUsed: w.used, resetAt: w.resetAt,
      readingAt: seenAt,
      freshness: !fresh ? "unknown" : typeof w.resetAt === "number" && w.resetAt <= now ? "expired" : "fresh",
    };
  }
  return [{ source: "account", boundAccount: account.name, pool: "private",
    enabled: account.enabled, share: { windows } }];
}
