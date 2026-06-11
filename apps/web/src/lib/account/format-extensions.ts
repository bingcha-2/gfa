/**
 * Portal-specific formatting helpers (billing, countdowns).
 * Kept separate from lib/format.ts to avoid touching console-shared code.
 */

/** 9900 → "¥99" · 9990 → "¥99.90" — whole yuan drop decimals. */
export function formatPriceCents(cents: number): string {
  const yuan = cents / 100;
  return Number.isInteger(yuan) ? `¥${yuan}` : `¥${yuan.toFixed(2)}`;
}

/** Milliseconds → "mm:ss", clamped at 00:00. For pay-order countdowns. */
export function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
