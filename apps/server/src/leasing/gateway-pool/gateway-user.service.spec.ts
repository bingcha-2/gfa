import { describe, expect, it, vi } from "vitest";

import { costUsd, hashKey, GatewayUserService, type UserState } from "./gateway-user.service";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

describe("Desktop gateway accounting reuses the existing ledger", () => {
  it("records mother/user identity and increments the same USD balance in one transaction", async () => {
    const prisma = {
      gatewayUsage: { create: vi.fn().mockReturnValue("usage-write") },
      gatewayUser: { update: vi.fn().mockReturnValue("balance-write") },
      $transaction: vi.fn().mockResolvedValue([]),
    };
    const service = new GatewayUserService(prisma as any, {} as any);
    const state: UserState = { id: "shared-cli-desktop-user", customerId: "customer", motherId: "existing-mother", shares: 1, enabled: true, usedUsd: 10, inflight: 0, periodStartedAt: Date.now(), loadedAt: Date.now() };
    const usage = { requestId: "desktop-request", model: "claude-sonnet-4-6", tokens: { ...zero, input: 1000, output: 200, cacheRead: 500, cacheWrite1h: 20 }, status: 200 };
    const cost = costUsd(usage.model, usage.tokens);
    await service.recordUsage(state, usage);
    expect(prisma.gatewayUsage.create).toHaveBeenCalledWith({ data: expect.objectContaining({ gatewayUserId: state.id, motherAccountId: state.motherId, requestId: usage.requestId, costUsd: cost, cacheWrite1h: 20 }) });
    expect(prisma.gatewayUser.update).toHaveBeenCalledWith({ where: { id: state.id }, data: expect.objectContaining({ usedUsd: { increment: cost }, totalUsedUsd: { increment: cost }, totalRequests: { increment: 1 } }) });
    expect(prisma.$transaction).toHaveBeenCalledWith(["usage-write", "balance-write"]);
    expect(state.usedUsd).toBeCloseTo(10 + cost);
    // Existing unique requestId constraint prevents a retry from charging twice.
    prisma.$transaction.mockRejectedValueOnce({ code: "P2002" });
    await service.recordUsage(state, usage);
    expect(state.usedUsd).toBeCloseTo(10 + cost);
  });
});

describe("gateway costUsd", () => {
  it("charges nothing for zero tokens", () => {
    expect(costUsd("claude-sonnet-4-6", zero)).toBe(0);
  });

  it("scales linearly with tokens", () => {
    const one = costUsd("claude-sonnet-4-6", { ...zero, input: 1_000, output: 1_000 });
    const two = costUsd("claude-sonnet-4-6", { ...zero, input: 2_000, output: 2_000 });
    expect(one).toBeGreaterThan(0);
    expect(two).toBeCloseTo(one * 2, 9);
  });

  it("prices output higher than input and cache reads below input", () => {
    const m = "claude-sonnet-4-6";
    const input = costUsd(m, { ...zero, input: 1_000_000 });
    const output = costUsd(m, { ...zero, output: 1_000_000 });
    const cacheRead = costUsd(m, { ...zero, cacheRead: 1_000_000 });
    expect(output).toBeGreaterThan(input);
    expect(cacheRead).toBeLessThan(input);
  });

  it("prices opus above haiku for the same usage", () => {
    const u = { ...zero, input: 100_000, output: 50_000 };
    expect(costUsd("claude-opus-4-8", u)).toBeGreaterThan(costUsd("claude-haiku-4-5-20251001", u));
  });

  it("never returns a negative or NaN value for an unknown model", () => {
    expect(() => costUsd("claude-unknown-model", { ...zero, input: 1_000, output: 1_000 })).toThrow("MODEL_PRICING_UNAVAILABLE");
  });
});

describe("hashKey", () => {
  it("is deterministic and does not contain the key", () => {
    expect(hashKey("gfa-abc")).toBe(hashKey("gfa-abc"));
    expect(hashKey("gfa-abc")).not.toContain("abc");
    expect(hashKey("gfa-abc")).not.toBe(hashKey("gfa-abd"));
  });
});

describe("gateway subscription eligibility", () => {
  it("rejects activation before releasing credentials when no subscription exists", async () => {
    const prisma = { customer: { findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE' }) }, subscription: { findMany: vi.fn().mockResolvedValue([]) }, gatewayUser: { findUnique: vi.fn() } };
    const service = new GatewayUserService(prisma as any, {} as any);
    await expect(service.activate('customer')).rejects.toMatchObject({ status: 403 });
    expect(prisma.gatewayUser.findUnique).not.toHaveBeenCalled();
  });
  it("requires Claude entitlement and rechecks cancellation without caching", async () => {
    const findMany = vi.fn().mockResolvedValue([{ config: JSON.stringify({ products: ['anthropic'] }) }]);
    const prisma = { customer: { findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE' }) }, subscription: { findMany } };
    const service = new GatewayUserService(prisma as any, {} as any);
    expect(await service.hasActiveSubscription('customer')).toBe(true);
    expect(findMany.mock.calls[0][0].where).toMatchObject({ customerId: 'customer', status: 'ACTIVE', startsAt: { lte: expect.any(Date) }, OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }] });
    findMany.mockResolvedValue([{ config: JSON.stringify({ products: ['codex'] }) }]);
    expect(await service.hasActiveSubscription('customer')).toBe(false);
    findMany.mockResolvedValue([]);
    expect(await service.hasActiveSubscription('customer')).toBe(false);
    prisma.customer.findUnique.mockResolvedValue({ status: 'DISABLED' });
    expect(await service.hasActiveSubscription('customer')).toBe(false);
  });
});

describe("gateway summary", () => {
  it("scopes billing to the caller and omits account identities and credentials", async () => {
    const prisma = {
      gatewayUser: { findUnique: vi.fn().mockResolvedValue({ id: 'own-user', shares: 1, enabled: true, usedUsd: .00005, totalUsedUsd: .00005, totalRequests: 1, motherAccount: { accountName: 'secret-account', enabled: true, status: 'ready', keyCipher: 'secret-key', usageJson: JSON.stringify([{ boundAccount: 'secret-account', pool: 'private', share: { windows: { '7d': { freshness: 'stale', remaining: 1, resetAt: Date.now() + 100000, calibration: { status: 'learning' } } } } }]) } }) },
      gatewayUsage: { groupBy: vi.fn().mockResolvedValue([]), findMany: vi.fn().mockResolvedValue([{ createdAt: new Date(), model: 'claude-haiku-4-5', inputTokens: 15, outputTokens: 7, cacheReadTokens: 0, cacheWrite5m: 0, cacheWrite1h: 0, costUsd: .00005 }]) },
    };
    const service = new GatewayUserService(prisma as any, {} as any);
    (prisma as any).customer = { findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE' }) };
    (prisma as any).subscription = { findMany: vi.fn().mockResolvedValue([]) };
    (service as any).pool.quotaSnapshot = vi.fn().mockResolvedValue(null);
    const result = await service.summary('caller');
    expect(prisma.gatewayUser.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { customerId: 'caller' } }));
    expect(prisma.gatewayUsage.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { gatewayUserId: 'own-user' } }));
    expect(result).toMatchObject({ subscriptionValid: false, usedUsd: .00005, windows: [{ period: '5h', remaining: null }, { period: '7d', remaining: null }] });
    expect(JSON.stringify(result)).not.toMatch(/secret-account|secret-key/);
    expect(result.dailyHistory).toHaveLength(35);
    expect(result.dailyHistory?.[0]).toMatchObject({ requests: 1, inputTokens: 15, outputTokens: 7, costUsd: .00005, byModel: { 'claude-haiku-4-5': { requests: 1, inputTokens: 15, costUsd: .00005 } } });
    expect(prisma.gatewayUsage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { gatewayUserId: 'own-user', createdAt: { gte: expect.any(Date) } } }));
  });
});

describe('live subscription window enforcement', () => {
  function fixture(fiveHour = 10, weekly = 100) {
    const row = { id: 'u', customerId: 'c', motherAccountId: 'm', shares: 1, enabled: true, usedUsd: 999, motherAccount: { enabled: true, status: 'ready' } };
    const aggregate = vi.fn().mockResolvedValue({ _sum: { costUsd: 2 } });
    const prisma = { gatewayUser: { findUnique: vi.fn().mockResolvedValue(row) }, gatewayUsage: { aggregate } };
    const service = new GatewayUserService(prisma as any, { quotaSnapshot: vi.fn().mockResolvedValue(row.motherAccount) } as any);
    const sub = { id: 'claude-sub', startsAt: new Date(Date.now() - 3600000), config: JSON.stringify({ products: ['anthropic'], usdQuotaByProduct: { anthropic: { fiveHour, weekly } } }) };
    const status = () => service.quotaStatus({ id: 'u', customerId: 'c', motherId: 'm', shares: 1 }, row, [sub]);
    return { status, aggregate, row, sub, service };
  }
  it('admin list uses exactly the admission calculation, not shares or old counters', async () => {
    const f = fixture(10, 100);
    const db = (f.service as any).prisma;
    db.gatewayUser.findMany = vi.fn().mockResolvedValue([f.row]);
    db.customer = { findMany: vi.fn().mockResolvedValue([{ id: 'c', email: 'test@example.test' }]) };
    vi.spyOn(f.service as any, 'activeClaudeSubscriptions').mockResolvedValue([f.sub]);
    const status = await f.status();
    const [listed] = await f.service.listUsers();
    expect(listed.quotaWindows).toEqual(status.quotaWindows);
    expect(listed.quotaWindows).toMatchObject([{ period: '5h', usedUsd: 2, limitUsd: 10 }, { period: '7d', usedUsd: 2, limitUsd: 100 }]);
    expect(listed.limitUsd).toBe(100);
    expect(listed.usedUsd).toBe(2);
    vi.spyOn(f.service as any, 'activeClaudeSubscriptions').mockResolvedValue([]);
    expect((await f.service.listUsers())[0]).toMatchObject({ subscriptionValid: false, quotaWindows: [], limitUsd: 0 });
  });
  it('applies per-window overrides immediately and expires them on renewal', async () => {
    const f = fixture();
    (f.sub as any).expiresAt = new Date(Date.now() + 86400000);
    const config = JSON.parse(f.sub.config);
    config.gatewayQuotaOverride = { startsAt: f.sub.startsAt.toISOString(), expiresAt: (f.sub as any).expiresAt.toISOString(), fiveHour: 1, weekly: null };
    f.sub.config = JSON.stringify(config);
    const blocked = await f.status();
    expect(blocked.allowed).toBe(false);
    expect(blocked.quotaSource).toBe('custom');
    expect(blocked.quotaWindows).toMatchObject([{ limitUsd: 1, usedUsd: 2 }, { limitUsd: 100, usedUsd: 2 }]);
    (f.sub as any).expiresAt = new Date(Date.now() + 172800000);
    const renewed = await f.status();
    expect(renewed.allowed).toBe(true);
    expect(renewed.quotaSource).toBe('plan');
    expect(renewed.quotaWindows[0].limitUsd).toBe(10);
  });
  it('does not fall back to shares when the plan has no quota', async () => {
    const f = fixture();
    f.sub.config = JSON.stringify({ products: ['anthropic'] });
    expect(await f.status()).toMatchObject({ allowed: false, reason: 'quota_configuration_invalid', quotaWindows: [] });
  });
  it('saves and restores overrides without changing usage, and rejects inactive subscriptions', async () => {
    const f = fixture(); const db = (f.service as any).prisma;
    db.$transaction = (fn: any) => fn(db);
    db.subscription = { update: vi.fn() };
    const subscriptions = vi.spyOn(f.service as any, 'activeClaudeSubscriptions').mockResolvedValue([f.sub]);
    await f.service.setQuotaOverride('u', { subscriptionId: f.sub.id, fiveHour: 0, weekly: 50 });
    const saved = JSON.parse(db.subscription.update.mock.calls[0][0].data.config);
    expect(saved.gatewayQuotaOverride).toMatchObject({ fiveHour: 0, weekly: 50 });
    expect(saved.usdQuotaByProduct.anthropic).toEqual({ fiveHour: 10, weekly: 100 });
    expect(db.subscription.update.mock.calls[0][0].data).toEqual({ config: expect.any(String) });
    f.sub.config = JSON.stringify(saved);
    await f.service.setQuotaOverride('u', { subscriptionId: f.sub.id, fiveHour: null, weekly: null });
    expect(JSON.parse(db.subscription.update.mock.calls[1][0].data.config).gatewayQuotaOverride).toBeUndefined();
    subscriptions.mockResolvedValue([]);
    await expect(f.service.setQuotaOverride('u', { subscriptionId: f.sub.id, fiveHour: 0, weekly: 50 })).rejects.toThrow('订阅已变更');
    await expect(f.service.setQuotaOverride('u', { subscriptionId: f.sub.id, fiveHour: -1, weekly: 50 })).rejects.toThrow('额度必须');
    expect(db.subscription.update).toHaveBeenCalledTimes(2);
  });
  it('uses actual ledger usage, not the old shared counter, for both bars', async () => {
    const f = fixture(); const q = await f.status();
    expect(q.allowed).toBe(true);
    expect(q.windows.map(w => w.remaining)).toEqual([.8, .98]);
    expect(q.subscriptionId).toBe('claude-sub');
    expect(f.aggregate.mock.calls[0][0].where.AND[0]).toMatchObject({ OR: [{ subscriptionId: 'claude-sub' }, { subscriptionId: null }] });
  });
  it.each([['5h', 10, 2], ['7d', 2, 100]])('blocks exhausted %s before forwarding', async (period, fiveUsed, weekUsed) => {
    const f = fixture(); f.aggregate.mockResolvedValueOnce({ _sum: { costUsd: fiveUsed } }).mockResolvedValueOnce({ _sum: { costUsd: weekUsed } });
    const q = await f.status(); expect(q.allowed).toBe(false); expect(q.reason).toBe(`quota_${period}_exhausted`); expect(q.retryAt).toBeGreaterThan(Date.now());
  });
  it('zero 5h config hides and disables only the personal 5h cap', async () => {
    const f = fixture(0, 100); const q = await f.status();
    expect(q.allowed).toBe(true); expect(q.windows[0].state).toBe('unlimited'); expect(q.windows[1].remaining).toBe(.98); expect(f.aggregate).toHaveBeenCalledTimes(2);
  });
  it('cannot disable the provider cap by setting the personal cap to zero', async () => {
    const f = fixture(0, 100);
    Object.assign(f.row.motherAccount, { accountName: 'a', usageSyncedAt: new Date(), usageJson: JSON.stringify([{ boundAccount: 'a', pool: 'private', share: { windows: { '5h': { freshness: 'fresh', remaining: 0, resetAt: Date.now() + 60000 } } } }]) });
    const q = await f.status(); expect(q.allowed).toBe(false); expect(q.reason).toBe('quota_5h_exhausted'); expect(q.windows[0].state).toBe('unlimited');
  });
  it.each(['5h', '7d'])('lets upstream reconcile uncertain %s readings without bypassing GFA limits', async period => {
    const f = fixture();
    Object.assign(f.row.motherAccount, { accountName: 'a', usageSyncedAt: new Date(), usageJson: JSON.stringify([
      { boundAccount: 'a', pool: 'private', share: { windows: { [period]: {
        freshness: 'fresh', remaining: 1, uncertain: true, inFlight: 0, reserved: .005, resetAt: Date.now() + 60000,
      } } } },
    ]) });
    expect(await f.status()).toMatchObject({ allowed: true, reason: 'ok', subscriptionId: 'claude-sub' });
    f.aggregate.mockResolvedValue({ _sum: { costUsd: 100 } });
    expect(await f.status()).toMatchObject({ allowed: false, reason: 'quota_5h_exhausted' });
    expect(await f.service.quotaStatus({ id: 'u', customerId: 'c', motherId: 'm', shares: 1 }, f.row, []))
      .toMatchObject({ allowed: false, reason: 'subscription_required' });
  });
  it('rejects invalid settings instead of treating them as unlimited', async () => {
    const f = fixture(-1); expect((await f.status()).reason).toBe('quota_configuration_invalid'); expect(f.aggregate).not.toHaveBeenCalled();
  });
});

describe('admin allocation enforces subscription and capacity', () => {
  function fixture(products: string[] = ['anthropic'], status = 'ACTIVE') {
    const db: any = {
      customer: { findUnique: vi.fn().mockResolvedValue({ id: 'c', status }) },
      subscription: { findMany: vi.fn().mockResolvedValue(products.length ? [{ config: JSON.stringify({ products }) }] : []) },
      gatewayUser: { findUnique: vi.fn().mockResolvedValue(null), groupBy: vi.fn().mockResolvedValue([{ motherAccountId: 'm', _count: { _all: 6 } }]), create: vi.fn() },
      gatewayMotherAccount: { findMany: vi.fn().mockResolvedValue([{ id: 'm', totalShares: 6 }]) },
      $transaction: (fn: any) => fn(db),
    };
    const service = new GatewayUserService(db, {} as any);
    return { service, db };
  }
  it.each([{ products: [] }, { products: ['codex'] }])('rejects direct allocation with products $products', async ({ products }) => {
    const { service, db } = fixture(products);
    await expect(service.assign('test@example.test', 1)).rejects.toMatchObject({ status: 403 });
    expect(db.gatewayUser.create).not.toHaveBeenCalled();
    expect(db.gatewayMotherAccount.findMany).not.toHaveBeenCalled();
  });
  it('rejects a disabled customer even with an active Claude subscription', async () => {
    const { service, db } = fixture(['anthropic'], 'DISABLED');
    await expect(service.assign('test@example.test')).rejects.toMatchObject({ status: 403 });
    expect(db.gatewayUser.create).not.toHaveBeenCalled();
  });
  it('allows a full mother account and prefers spare capacity before overallocating', async () => {
    const { service, db } = fixture();
    expect((await (service as any).pickMother(undefined, db)).id).toBe('m');
    db.gatewayMotherAccount.findMany.mockResolvedValue([{ id: 'm', totalShares: 6 }, { id: 'free', totalShares: 6 }]);
    expect((await (service as any).pickMother(undefined, db)).id).toBe('free');
    db.gatewayMotherAccount.findMany.mockResolvedValue([]);
    await expect((service as any).pickMother(undefined, db)).rejects.toMatchObject({ status: 400 });
  });
  it('rebinds only with an active subscription and preserves the usage ledger', async () => {
    const { service, db } = fixture();
    db.gatewayUser.findUnique.mockResolvedValue({ id: 'u', customerId: 'c', keyHash: 'hash', motherAccountId: 'old' });
    db.gatewayUser.update = vi.fn();
    await service.updateUser('u', { motherAccountId: 'm' });
    expect(db.gatewayUser.update).toHaveBeenCalledWith({ where: { id: 'u' }, data: { motherAccountId: 'm' } });
    expect(db.gatewayMotherAccount.findMany).toHaveBeenCalledWith({ where: { enabled: true, status: 'ready', id: 'm' } });
    db.subscription.findMany.mockResolvedValue([]);
    await expect(service.updateUser('u', { motherAccountId: 'm' })).rejects.toMatchObject({ status: 403 });
    expect(db.gatewayUser.update).toHaveBeenCalledTimes(1);
  });
  it('does not truncate fractional shares into valid allocations', async () => {
    const { service } = fixture();
    await expect(service.assign('test@example.test', 1.5)).rejects.toMatchObject({ status: 400 });
  });
});
