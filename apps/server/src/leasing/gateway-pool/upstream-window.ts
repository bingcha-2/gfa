/** Only a fresh, unambiguous reading crossing the old boundary proves a reset.
 * The upstream can adjust resetAt by milliseconds within the same window.
 */
export function upstreamWindowTransition(usage: unknown[], account: string, previous: number | null, now: number, period: "5h" | "7d" = "7d") {
  const matches = usage.filter((item: any) => item?.boundAccount === account && item?.pool === "private");
  if (matches.length !== 1) return { reset: false, resetAt: null };
  const window = (matches[0] as any)?.share?.windows?.[period];
  const resetAt = window?.resetAt;
  const readingAt = window?.readingAt;
  if (window?.freshness !== "fresh" || !Number.isSafeInteger(resetAt) || resetAt <= now ||
      !Number.isSafeInteger(readingAt) || readingAt > now || window?.uncertain) {
    return { reset: false, resetAt: null };
  }
  if (previous === null) return { reset: false, resetAt };
  // Ignore clock/readout corrections and keep the old boundary until an actual
  // subsequent period is observed. A one-minute tolerance excludes boundary jitter.
  const reset = now >= previous && readingAt >= previous && resetAt > previous + 60_000;
  return { reset, resetAt: reset ? resetAt : null };
}
