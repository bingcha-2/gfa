import { accountUsageRows } from "./account-usage";
export type Period = "5h" | "7d";
export const WINDOW_MS: Record<Period, number> = { "5h": 5 * 3600_000, "7d": 7 * 86400_000 };
export type QuotaWindow = { period: Period; state: "limited" | "unlimited" | "unknown";
  remaining: number | null; resetAt: number | null; exhausted: boolean; uncertain: boolean };
const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Missing/inactive/null is NOT proof of an unlimited window. Only an explicit
 * upstream capability counts; a product name (including Ultra) is never proof. */
export function upstreamWindows(mother: any, now = Date.now()): QuotaWindow[] {
  let rows: any[] = [];
  try { const parsed = JSON.parse(mother?.usageJson || "[]"); rows = accountUsageRows(parsed, now); } catch { /* unknown */ }
  const matches = rows.filter(r => r?.boundAccount === mother?.accountName && r?.pool === "private");
  const key = matches.length === 1 ? matches[0] : null;
  const syncedAt = new Date(mother?.usageSyncedAt || 0).getTime();
  const snapshotFresh = syncedAt > 0 && now - syncedAt <= 120_000 && syncedAt <= now + 5000;
  return (["5h", "7d"] as Period[]).map(period => {
    const w = key?.share?.windows?.[period];
    const resetAt = number(w?.resetAt) && w.resetAt > 0 ? w.resetAt : null;
    const unknown: QuotaWindow = { period, state: "unknown", remaining: null, resetAt, exhausted: false, uncertain: w?.uncertain === true };
    if (!snapshotFresh || !key || key.enabled === false) return unknown;
    // Supported explicit extension; inactive alone remains ambiguous in the current ops API.
    if (w?.unlimited === true || w?.state === "unlimited") return { ...unknown, state: "unlimited", resetAt: null };
    if (w?.freshness !== "fresh" || resetAt === null || resetAt <= now || w?.uncertain ||
        !number(w?.remaining) || w.remaining < 0 || w.remaining > 1) return unknown;
    let remaining = w.remaining;
    if (number(w.accountUsed)) remaining = Math.min(remaining, Math.max(0, 1 - w.accountUsed));
    const reserved = number(w.reserved) ? Math.max(0, w.reserved) : 0;
    const leftExhausted = number(w.left) && w.left <= reserved;
    return { ...unknown, state: "limited", remaining, exhausted: remaining <= 0 || leftExhausted };
  });
}

/** Keep the last observed period when its boundary has passed but no new
 * reading arrived. Never replenish a stale upstream period on the local clock. */
export function quotaRange(period: Period, upstream: QuotaWindow, startsAt: number, now: number) {
  const duration = WINDOW_MS[period];
  if (upstream.resetAt !== null) return { start: Math.max(startsAt, upstream.resetAt - duration),
    end: upstream.resetAt > now ? upstream.resetAt : null };
  const start = startsAt + Math.max(0, Math.floor((now - startsAt) / duration)) * duration;
  return { start, end: start + duration };
}

/** Customer bars describe the purchased GFA allowance. Provider capacity is
 * independently enforced and must never change the plan's enabled windows. */
export function personalWindow(period: Period, personal: { limit: number; used: number; resetAt: number | null } | null): QuotaWindow {
  if (!personal) return { period, state: "unlimited", remaining: null, resetAt: null, exhausted: false, uncertain: false };
  const remaining = Math.max(0, Math.min(1, 1 - personal.used / personal.limit));
  return { period, state: "limited", remaining, resetAt: personal.resetAt, exhausted: remaining === 0, uncertain: false };
}
