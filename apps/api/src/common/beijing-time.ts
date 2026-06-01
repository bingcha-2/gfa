/**
 * beijing-time.ts — UTC+8 (Asia/Shanghai) day-boundary helpers.
 *
 * All admin-facing day grouping and "today / last-N-days" windows use Beijing
 * calendar days, independent of the server's local timezone or UTC. The trick:
 * shift an instant by +8h and read its UTC calendar fields — those fields then
 * spell the Beijing wall-clock date/time.
 */

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Beijing calendar date (YYYY-MM-DD) for an instant. */
export function beijingDayKey(d: Date): string {
  return new Date(d.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Real UTC instant of Beijing 00:00 on (today - daysAgo). Use as a Prisma
 * `gte` bound so "last N days" means N full Beijing days plus today.
 */
export function beijingDayStart(daysAgo = 0, now: Date = new Date()): Date {
  const shifted = new Date(now.getTime() + BEIJING_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  shifted.setUTCDate(shifted.getUTCDate() - daysAgo);
  return new Date(shifted.getTime() - BEIJING_OFFSET_MS);
}

/**
 * Ordered Beijing day keys from (today - daysAgo) through today inclusive.
 * Used to fill continuous daily series (including zero days).
 */
export function beijingDayKeysSince(daysAgo: number, now: Date = new Date()): string[] {
  const keys: string[] = [];
  const cursor = new Date(now.getTime() + BEIJING_OFFSET_MS);
  cursor.setUTCHours(0, 0, 0, 0);
  cursor.setUTCDate(cursor.getUTCDate() - daysAgo);
  const endKey = beijingDayKey(now);
  // Iterate by Beijing calendar day until we pass today's key.
  for (let i = 0; i <= daysAgo + 1; i++) {
    const key = cursor.toISOString().slice(0, 10);
    keys.push(key);
    if (key === endKey) break;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}
