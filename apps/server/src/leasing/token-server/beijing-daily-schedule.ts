const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const BEIJING_UTC_OFFSET_MS = 8 * HOUR_MS;

/** Milliseconds from `nowMs` until the next Beijing-time whole hour. */
export function msUntilNextBeijingHour(nowMs: number, hour: number): number {
  const normalizedHour = Math.min(23, Math.max(0, Math.trunc(hour)));
  const beijingNow = nowMs + BEIJING_UTC_OFFSET_MS;
  const beijingDayStart = Math.floor(beijingNow / DAY_MS) * DAY_MS;
  let nextRun = beijingDayStart + normalizedHour * HOUR_MS;
  if (nextRun <= beijingNow) nextRun += DAY_MS;
  return Math.max(1, nextRun - beijingNow);
}
