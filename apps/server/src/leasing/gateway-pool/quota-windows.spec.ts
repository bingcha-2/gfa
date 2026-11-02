import { describe, it, expect } from 'vitest';
import { personalWindow, upstreamWindows, quotaRange, WINDOW_MS } from './quota-windows';
const now = Date.UTC(2026, 10, 2);
const w = { period: '5h' as const, state: 'unknown' as const, remaining: null, resetAt: null, exhausted: false, uncertain: false };
describe('independent subscription and provider windows', () => {
  it('disables only the unconfigured GFA window', () => {
    expect(personalWindow('5h', null)).toMatchObject({ state: 'unlimited', remaining: null });
    expect(personalWindow('7d', { limit: 10, used: 2, resetAt: now + 1000 })).toMatchObject({ state: 'limited', remaining: .8 });
  });
  it('never invents a provider allowance from absent or inactive data', () => {
    for (const window of [null, { freshness: 'inactive', remaining: null }, { freshness: 'stale', remaining: 1 }]) {
      const mother = { accountName: 'a', usageSyncedAt: new Date(now), usageJson: JSON.stringify([{ boundAccount: 'a', pool: 'private', share: { windows: { '5h': window } } }]) };
      expect(upstreamWindows(mother, now)[0]).toMatchObject({ state: 'unknown', remaining: null });
    }
  });
  it('enforces provider reservations independently of the GFA limit', () => {
    const mother = { accountName: 'a', usageSyncedAt: new Date(now), usageJson: JSON.stringify([{ boundAccount: 'a', pool: 'private', share: { windows: { '5h': { freshness: 'fresh', remaining: .5, left: .1, reserved: .1, resetAt: now + 1000 } } } }]) };
    expect(upstreamWindows(mother, now)[0].exhausted).toBe(true);
  });
  it('resets personal 5h and weekly windows separately when there is no provider boundary', () => {
    const start = now - 6 * 3600_000;
    expect(quotaRange('5h', w, start, now).start).toBe(start + WINDOW_MS['5h']);
    expect(quotaRange('7d', { ...w, period: '7d' }, start, now).start).toBe(start);
  });
  it('does not replenish a provider window on a stale clock boundary', () => {
    expect(quotaRange('5h', { ...w, resetAt: now - 1000 }, now - 86400_000, now)).toEqual({ start: now - 1000 - WINDOW_MS['5h'], end: null });
  });
});
