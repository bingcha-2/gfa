import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessKeyStore, type AccessKeyRecord } from '../access-key-store';
import type { ProviderQuotaSnapshotInput } from '../../lease-core/provider';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-07-14T00:00:00.000Z');

describe('AccessKeyStore upstream-driven USD windows', () => {
  let dir: string;
  let store: AccessKeyStore;

  const config = (bindings: Record<string, number> = { codex: 11, anthropic: 22 }) => ({
    id: 'sub-1',
    key: 'secret',
    status: 'active',
    products: Object.keys(bindings),
    bindings,
    quotaAlgorithm: 'usd',
    usdQuotaByProduct: {
      codex: { fiveHour: 100, weekly: 1_000 },
      anthropic: { fiveHour: 200, weekly: 2_000 },
    },
  });

  const record = () => store.findById('sub-1')! as AccessKeyRecord;
  const usage = (product = 'codex') => record().usdUsageByProduct![product]!;
  const status = (product = 'codex') => store.publicStatus(record(), 0, product).usdQuotaByProduct[product];
  const input = (values: {
    h?: number | null;
    w?: number | null;
    hReset?: number;
    wReset?: number;
    hPresent?: boolean;
    wPresent?: boolean;
  }): ProviderQuotaSnapshotInput[] => [{
    modelKey: 'account',
    hourlyPercent: values.h,
    weeklyPercent: values.w,
    hourlyPresent: values.hPresent,
    weeklyPresent: values.wPresent,
    hourlyResetAt: values.hReset ? new Date(values.hReset) : undefined,
    weeklyResetAt: values.wReset ? new Date(values.wReset) : undefined,
  }];
  const apply = (
    values: Parameters<typeof input>[0],
    observedAt: number,
    snapshotId: string,
    product = 'codex',
    accountId = product === 'codex' ? 11 : 22,
  ) => store.applyUpstreamUsdQuotaSnapshot(accountId, product, input(values), {
    observedAt,
    arrivedAt: observedAt,
    snapshotId,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gfa-usd-upstream-'));
    const file = path.join(dir, 'access-keys.json');
    fs.writeFileSync(file, JSON.stringify({ keys: [] }), 'utf8');
    store = new AccessKeyStore(file);
    store.loadSubscriptionRecords([config()] as any);
    record().usdUsageByProduct = {
      codex: { used5h: 80, usedWeekly: 800, windowStartedAt5h: T0 - HOUR, windowStartedAtWeekly: T0 - DAY },
      anthropic: { used5h: 120, usedWeekly: 1_200, windowStartedAt5h: T0 - HOUR, windowStartedAtWeekly: T0 - DAY },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('first rollout snapshot and ordinary decreases preserve historical usage', () => {
    apply({ h: 80, w: 70, hReset: T0 + 4 * HOUR, wReset: T0 + 5 * DAY }, T0 + 1, 'baseline');
    expect(status()).toMatchObject({ fiveHour: { used: 80 }, weekly: { used: 800 } });

    apply({ h: 60, w: 50, hReset: T0 + 4 * HOUR, wReset: T0 + 5 * DAY }, T0 + 2, 'decrease');
    expect(status()).toMatchObject({ fiveHour: { used: 80 }, weekly: { used: 800 } });
    expect(usage().upstreamFiveHour?.lowFraction).toBeCloseTo(0.6);
    expect(usage().upstreamWeekly?.lowFraction).toBeCloseTo(0.5);
  });

  it('a first snapshot with trusted proof of a weekly rollover clears stale weekly usage only', () => {
    const anthropic = usage('anthropic');
    anthropic.used5h = 71.56;
    anthropic.usedWeekly = 1_336.24;
    anthropic.upstreamFiveHour = undefined;
    anthropic.upstreamWeekly = undefined;

    store.applyUpstreamUsdQuotaSnapshot(22, 'anthropic', input({
      h: 90,
      w: 98,
      hReset: T0 + 4 * HOUR,
      wReset: T0 + 8 * DAY,
    }), {
      observedAt: T0 + 1,
      arrivedAt: T0 + 1,
      snapshotId: 'manual-refresh-after-weekly-rollover',
      previousResetAtByScope: { weekly: T0 + DAY },
    });

    expect(status('anthropic')).toMatchObject({
      fiveHour: { used: 71.56 },
      weekly: { used: 0 },
    });
    expect(anthropic.upstreamWeekly).toMatchObject({
      resetAt: T0 + 8 * DAY,
      lowFraction: 0.98,
    });

    anthropic.usedWeekly = 5;
    store.applyUpstreamUsdQuotaSnapshot(22, 'anthropic', input({
      w: 98,
      wReset: T0 + 8 * DAY,
    }), {
      observedAt: T0 + 2,
      arrivedAt: T0 + 2,
      snapshotId: 'manual-refresh-same-weekly-epoch',
      previousResetAtByScope: { weekly: T0 + DAY },
    });
    expect(status('anthropic').weekly.used).toBe(5);
  });

  it('trusted rollover proof clears a reset-less window that already has a percentage baseline', () => {
    apply({ w: 40 }, T0 + 1, 'percentage-without-reset', 'anthropic', 22);
    expect(status('anthropic').weekly.used).toBe(1_200);
    expect(usage('anthropic').upstreamWeekly).toMatchObject({ lowFraction: 0.4 });
    expect(usage('anthropic').upstreamWeekly?.resetAt).toBeUndefined();

    store.applyUpstreamUsdQuotaSnapshot(22, 'anthropic', input({
      w: 98,
      wReset: T0 + 8 * DAY,
    }), {
      observedAt: T0 + 2,
      arrivedAt: T0 + 2,
      snapshotId: 'reset-arrived-after-percentage',
      previousResetAtByScope: { weekly: T0 + DAY },
    });

    expect(status('anthropic').weekly.used).toBe(0);
    expect(usage('anthropic').upstreamWeekly).toMatchObject({
      resetAt: T0 + 8 * DAY,
      lowFraction: 0.98,
    });
  });

  it('a new 5h resetAt clears 5h once without touching weekly', () => {
    apply({ h: 40, w: 40, hReset: T0 + HOUR, wReset: T0 + DAY }, T0 + 1, 'old');
    apply({ h: 99, w: 40, hReset: T0 + 6 * HOUR, wReset: T0 + DAY }, T0 + 2, 'new');
    expect(status()).toMatchObject({ fiveHour: { used: 0 }, weekly: { used: 800 } });

    usage().used5h = 7;
    apply({ h: 99, w: 40, hReset: T0 + 6 * HOUR, wReset: T0 + DAY }, T0 + 3, 'new-duplicate-content');
    expect(status()).toMatchObject({ fiveHour: { used: 7 }, weekly: { used: 800 } });
  });

  it('a new weekly resetAt clears weekly without touching 5h', () => {
    apply({ h: 40, w: 40, hReset: T0 + HOUR, wReset: T0 + DAY }, T0 + 1, 'old');
    apply({ h: 40, w: 99, hReset: T0 + HOUR, wReset: T0 + 8 * DAY }, T0 + 2, 'new-week');
    expect(status()).toMatchObject({ fiveHour: { used: 80 }, weekly: { used: 0 } });
  });

  it('one trusted mother-account snapshot advances every bound USD subscription', () => {
    store.loadSubscriptionRecords([{
      ...config(), id: 'sub-2', key: 'secret-2', bindings: { codex: 11 }, products: ['codex'],
    }] as any);
    const second = store.findById('sub-2')!;
    second.usdUsageByProduct = {
      codex: { used5h: 55, usedWeekly: 500, windowStartedAt5h: T0, windowStartedAtWeekly: T0 },
    };
    apply({ h: 30, hReset: T0 + HOUR }, T0 + 1, 'mother-baseline');
    apply({ h: 99, hReset: T0 + 6 * HOUR }, T0 + 2, 'mother-next');

    expect(status().fiveHour.used).toBe(0);
    expect(store.publicStatus(second, 0, 'codex').usdQuotaByProduct.codex.fiveHour.used).toBe(0);
    expect(second.usdUsageByProduct?.codex?.usedWeekly).toBe(500);
  });

  it('snapshots and rolls back the complete mother-account mutation scope', () => {
    store.loadSubscriptionRecords([{
      ...config(), id: 'sub-2', key: 'secret-2', bindings: { codex: 11 }, products: ['codex'],
    }] as any);
    const second = store.findById('sub-2')!;
    // Exercise the JSON-undefined edge: the second subscription has not created
    // any USD usage object before the failed mutation.
    second.usdUsageByProduct = undefined;
    const snapshots = store.snapshotUsdMutationScope('sub-1', 11, 'codex');

    store.recordUsage('sub-2', 200, { inputTokens: 100_000 }, 'gpt-5.6-luna', 'new-usage', 'codex');
    apply({ h: 30, hReset: T0 + HOUR }, T0 + 1, 'mother-baseline');
    apply({ h: 99, hReset: T0 + 6 * HOUR }, T0 + 2, 'mother-next');
    expect(second.usdUsageByProduct).toBeDefined();

    store.restoreSubscriptionUsages(snapshots);
    expect(status()).toMatchObject({ fiveHour: { used: 80 }, weekly: { used: 800 } });
    expect(second.usdUsageByProduct).toBeUndefined();
    expect(store.serializeSubscriptionWindowsFor(snapshots.map((item) => item.id)).map((item) => item.id).sort())
      .toEqual(['sub-1', 'sub-2']);
  });

  it('Codex reset does not affect Anthropic windows in a mixed subscription', () => {
    apply({ h: 30, w: 30, hReset: T0 + HOUR, wReset: T0 + DAY }, T0 + 1, 'codex-old');
    apply({ h: 30, w: 30, hReset: T0 + HOUR, wReset: T0 + DAY }, T0 + 1, 'claude-old', 'anthropic', 22);
    apply({ h: 98, w: 30, hReset: T0 + 6 * HOUR, wReset: T0 + DAY }, T0 + 2, 'codex-new');

    expect(status('codex').fiveHour.used).toBe(0);
    expect(status('anthropic')).toMatchObject({ fiveHour: { used: 120 }, weekly: { used: 1_200 } });
  });

  it('stale and backward snapshots cannot reset a newer epoch', () => {
    apply({ h: 50, hReset: T0 + 4 * HOUR }, T0 + 20, 'current');
    apply({ h: 99, hReset: T0 + 9 * HOUR }, T0 + 10, 'stale');
    expect(status().fiveHour.used).toBe(80);

    apply({ h: 99, hReset: T0 + 2 * HOUR }, T0 + 30, 'backward');
    expect(status().fiveHour.used).toBe(80);
    expect(usage().upstreamFiveHour?.observedAt).toBe(T0 + 20);
  });

  it('persists epoch idempotency across restart', () => {
    apply({ h: 40, hReset: T0 + HOUR }, T0 + 1, 'old');
    apply({ h: 99, hReset: T0 + 6 * HOUR }, T0 + 2, 'new');
    usage().used5h = 9;
    usage().windowStartedAt5h = T0 + 3;
    const saved = store.serializeSubscriptionWindows()[0].windowState;

    const restarted = new AccessKeyStore(path.join(dir, 'access-keys.json'));
    restarted.loadSubscriptionRecords([config()] as any);
    restarted.restoreSubscriptionWindow('sub-1', saved);
    store = restarted;
    apply({ h: 99, hReset: T0 + 6 * HOUR }, T0 + 2, 'new');

    expect(status().fiveHour.used).toBe(9);
    expect(usage().upstreamFiveHour?.resetAt).toBe(T0 + 6 * HOUR);
  });

  it('rebind establishes a new baseline without gifting a reset', () => {
    apply({ h: 30, hReset: T0 + HOUR }, T0 + 1, 'mother-11');
    store.loadSubscriptionRecords([config({ codex: 12, anthropic: 22 })] as any);
    expect(usage().used5h).toBe(80);
    expect(usage().upstreamFiveHour).toEqual({ baselineReason: 'rebind' });

    apply({ h: 99, hReset: T0 + 6 * HOUR }, T0 + 2, 'mother-12', 'codex', 12);
    expect(status().fiveHour.used).toBe(80);
    expect(usage().upstreamAccountId).toBe(12);
  });

  it('rebind ignores trusted rollover evidence from before the subscription moved accounts', () => {
    apply({ h: 30, hReset: T0 + HOUR }, T0 + 1, 'mother-11');
    store.loadSubscriptionRecords([config({ codex: 12, anthropic: 22 })] as any);

    store.applyUpstreamUsdQuotaSnapshot(12, 'codex', input({
      h: 99,
      hReset: T0 + 6 * HOUR,
    }), {
      observedAt: T0 + 2,
      arrivedAt: T0 + 2,
      snapshotId: 'new-mother-after-rebind',
      previousResetAtByScope: { fiveHour: T0 + HOUR },
    });

    expect(status().fiveHour.used).toBe(80);
    expect(usage().upstreamFiveHour).toMatchObject({
      resetAt: T0 + 6 * HOUR,
      lowFraction: 0.99,
    });
    expect(usage().upstreamFiveHour?.baselineReason).toBeUndefined();
  });

  it('explicit 5h cancellation and restoration are isolated from weekly', () => {
    apply({ h: 40, w: 40, hReset: T0 + HOUR, wReset: T0 + DAY, hPresent: true, wPresent: true }, T0 + 1, 'both');
    apply({ h: null, w: 40, wReset: T0 + DAY, hPresent: false, wPresent: true }, T0 + 2, 'weekly-only');
    expect(status()).toMatchObject({ fiveHour: null, weekly: { used: 800 } });
    expect(usage().used5h).toBeUndefined();
    store.recordUsage('sub-1', 200, { inputTokens: 100_000 }, 'gpt-5-codex', 'while-absent', 'codex');
    expect(usage().used5h).toBeUndefined();

    usage().usedWeekly = 777;
    apply({ h: 95, w: 40, hReset: T0 + 5 * HOUR, wReset: T0 + DAY, hPresent: true, wPresent: true }, T0 + 3, 'restored');
    expect(status()).toMatchObject({ fiveHour: { used: 0 }, weekly: { used: 777 } });
  });

  it('books USD consumption only when applyUsdConsumption is true (non-durable reports evaporate on restart)', () => {
    // Two identical USD subs bound to the same codex mother account, fresh windows.
    store.loadSubscriptionRecords([
      { ...config(), id: 'sub-durable', key: 'k-durable' },
      { ...config(), id: 'sub-lost', key: 'k-lost' },
    ] as any);
    for (const id of ['sub-durable', 'sub-lost']) {
      store.findById(id)!.usdUsageByProduct = {
        codex: { used5h: 10, usedWeekly: 100, windowStartedAt5h: T0, windowStartedAtWeekly: T0 },
        anthropic: { used5h: 0, usedWeekly: 0, windowStartedAt5h: T0, windowStartedAtWeekly: T0 },
      };
    }
    const u = (id: string) => store.findById(id)!.usdUsageByProduct!.codex!;

    // Same report on both; only the durability flag differs. A report that can't be
    // durably checkpointed must NOT mutate used-USD, or it silently resets on restart.
    store.recordUsage('sub-durable', 200, { inputTokens: 100_000 }, 'gpt-5-codex', 'r-dur', 'codex', '', true);
    store.recordUsage('sub-lost', 200, { inputTokens: 100_000 }, 'gpt-5-codex', 'r-lost', 'codex', '', false);

    expect(u('sub-durable').used5h!).toBeGreaterThan(u('sub-lost').used5h!);
    expect(u('sub-durable').usedWeekly!).toBeGreaterThan(u('sub-lost').usedWeekly!);
    // The non-durable report leaves usage exactly at its pre-report value.
    expect(u('sub-lost').used5h).toBe(10);
    expect(u('sub-lost').usedWeekly).toBe(100);
  });

  it('confirmed relative rebound resets 80→99 and 20→75, but not 80→82', () => {
    apply({ h: 80, w: 20 }, T0 + 1, 'low');
    apply({ h: 99, w: 75 }, T0 + 2, 'rebound-1');
    expect(status()).toMatchObject({ fiveHour: { used: 80 }, weekly: { used: 800 } });
    apply({ h: 99, w: 75 }, T0 + 3, 'rebound-2');
    expect(status()).toMatchObject({ fiveHour: { used: 0 }, weekly: { used: 0 } });

    usage().used5h = 12;
    apply({ h: 80 }, T0 + 4, 'new-low');
    apply({ h: 82 }, T0 + 5, 'small-1');
    apply({ h: 82 }, T0 + 6, 'small-2');
    expect(status().fiveHour.used).toBe(12);
  });

  it('natural resetAt expiry clears once and a later epoch confirmation does not clear twice', () => {
    apply({ h: 40, hReset: T0 + HOUR }, T0 + 1, 'baseline');
    vi.setSystemTime(T0 + HOUR + 1);
    expect(status().fiveHour.used).toBe(0);
    usage().used5h = 6;
    usage().windowStartedAt5h = T0 + HOUR + 1;

    apply({ h: 99, hReset: T0 + HOUR }, T0 + HOUR + 2, 'same-epoch-high-1');
    apply({ h: 99, hReset: T0 + HOUR }, T0 + HOUR + 3, 'same-epoch-high-2');
    expect(status().fiveHour.used).toBe(6);

    apply({ h: 99, hReset: T0 + 6 * HOUR }, T0 + HOUR + 4, 'next-epoch');
    expect(status().fiveHour.used).toBe(6);
    expect(usage().upstreamFiveHour?.appliedResetAt).toBe(T0 + HOUR);
  });

  it('does not charge a delayed old-epoch report to the new upstream window', () => {
    apply({ h: 40, w: 40, hReset: T0 + HOUR, wReset: T0 + DAY }, T0 + 1, 'baseline');
    vi.setSystemTime(T0 + HOUR + 10_000);
    expect(status()).toMatchObject({ fiveHour: { used: 0 }, weekly: { used: 800 } });
    usage().used5h = 6;
    usage().windowStartedAt5h = T0 + HOUR + 1;

    store.recordUsage('sub-1', 200, {
      inputTokens: 1_000_000,
      occurredAt: T0 + HOUR - 1,
    }, 'gpt-5.6-luna', 'late-old-window', 'codex');
    expect(status().fiveHour.used).toBe(6);
    expect(status().weekly.used).toBeGreaterThan(800);

    store.recordUsage('sub-1', 200, {
      inputTokens: 1_000_000,
      occurredAt: T0 + HOUR + 5_000,
    }, 'gpt-5.6-luna', 'current-window', 'codex');
    expect(status().fiveHour.used).toBeGreaterThan(6);
  });

  it('anchors an advanced resetAt at first observation and keeps old delayed reports out', () => {
    apply({ w: 40, wReset: T0 + DAY }, T0 + 1, 'old-week');
    apply({ w: 99, wReset: T0 + 8 * DAY }, T0 + 2, 'new-week');
    expect(status().weekly.used).toBe(0);
    vi.setSystemTime(T0 + 2);

    store.recordUsage('sub-1', 200, {
      inputTokens: 1_000_000,
      occurredAt: T0 + 1,
    }, 'gpt-5.6-luna', 'late-before-observation', 'codex');
    expect(status().weekly.used).toBe(0);

    store.recordUsage('sub-1', 200, {
      inputTokens: 1_000_000,
      occurredAt: T0 + 2,
    }, 'gpt-5.6-luna', 'request-carrying-reset', 'codex');
    expect(status().weekly.used).toBeGreaterThan(0);
  });
});
