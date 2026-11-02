/** A renewal (including extending the same subscription) invalidates overrides. */
export function subscriptionTerm(sub: any) {
  return { startsAt: new Date(sub.startsAt).toISOString(), expiresAt: sub.expiresAt ? new Date(sub.expiresAt).toISOString() : null };
}
export function quotaPolicy(sub: any, configured: any) {
  let raw: any = {};
  try { raw = typeof sub.config === 'string' ? JSON.parse(sub.config) : sub.config ?? {}; } catch { /* invalid config is handled by the plan resolver */ }
  const saved = raw.gatewayQuotaOverride;
  const term = subscriptionTerm(sub);
  const override = saved?.startsAt === term.startsAt && saved?.expiresAt === term.expiresAt ? saved : null;
  const resolve = (period: 'fiveHour' | 'weekly') => override?.[period] ?? configured?.[period];
  return { fiveHour: resolve('fiveHour'), weekly: resolve('weekly'),
    overrides: { fiveHour: override?.fiveHour ?? null, weekly: override?.weekly ?? null },
    source: override && (override.fiveHour != null || override.weekly != null) ? 'custom' : 'plan' };
}
