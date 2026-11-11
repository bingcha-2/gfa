import { it, expect, vi } from 'vitest';
vi.mock('./key-vault', () => ({
  decryptKey: (cipher: string) => cipher.startsWith('fixture:') ? cipher.slice('fixture:'.length) : 'test-only',
  encryptKey: (plain: string) => `fixture:${plain}`,
  keyHint: () => 'hint',
}));
vi.mock('./upstream-client', async (original) => ({
  ...await original<typeof import('./upstream-client')>(),
  fetchAccountUsage: vi.fn(),
  fetchModels: vi.fn(),
  provisionOneKey: vi.fn(),
}));
import { GatewayPoolService } from './gateway-pool.service';
import { fetchAccountUsage, fetchModels, provisionOneKey, UpstreamError } from './upstream-client';

it('rejects an invalid inference URL before creating a mother account', async () => {
  const create = vi.fn();
  const db = { gatewayMotherAccount: { findUnique: vi.fn().mockResolvedValue(null), create } };
  const pool = new GatewayPoolService(db as any);
  await expect(pool.add('mother@example.test', undefined, 'http://pool.example.test')).rejects.toThrow('调用地址必须是 https:// 开头');
  expect(create).not.toHaveBeenCalled();
});

it.each([true, false])('refreshes account windows and resets only an observed new period: %s', async fresh => {
  const now = Date.now();
  const usage = { generatedAt: now, account: { id: 'up', name: 'test', enabled: true, windows: [
    { bucket: 'unified7d', used: 0, remaining: 1, resetAt: now + 86400000, seenAt: fresh ? now - 1000 : now - 900000 },
  ] } };
  vi.mocked(fetchAccountUsage).mockResolvedValue(usage);
  const row = { id: 'm', accountName: 'test', keyCipher: 'cipher', status: 'ready', upstreamResetAt7d: BigInt(now - 60000) };
  const update = vi.fn(); const reset = vi.fn(); const db: any = {
    gatewayMotherAccount: { findUnique: vi.fn().mockResolvedValue(row), findUniqueOrThrow: vi.fn().mockResolvedValue(row), update },
    gatewayUser: { updateMany: reset },
    siteSetting: { findMany: vi.fn().mockResolvedValue([{ key: 'gateway_upstream_op_key_cipher', value: 'cipher' }]) },
    $transaction: (fn: any) => fn(db),
  };
  await (new GatewayPoolService(db) as any).syncUsage('m');
  expect(JSON.parse(update.mock.calls[0][0].data.usageJson)).toEqual(usage);
  expect(reset).toHaveBeenCalledTimes(fresh ? 1 : 0);
  expect(fetchModels).not.toHaveBeenCalled();
});

it('retains the last snapshot on account query failure without invalidating inference credentials', async () => {
  vi.mocked(fetchAccountUsage).mockRejectedValue(new UpstreamError('account missing', 404));
  const update = vi.fn();
  const db: any = {
    gatewayMotherAccount: { findUnique: vi.fn().mockResolvedValue({ accountName: 'test' }), update },
    siteSetting: { findMany: vi.fn().mockResolvedValue([]) },
  };
  await (new GatewayPoolService(db) as any).syncUsage('m');
  const data = update.mock.calls[0][0].data;
  expect(data.usageJson).toBeUndefined();
  expect(data.status).toBeUndefined();
  expect(data.lastError).toBeTruthy();
});

it('schedules models refresh at 6h plus a random whole second within another 6h', async () => {
  const { nextModelsRefreshDelayMs } = await import('./gateway-pool.service');
  const sixHours = 6 * 3600_000;
  expect(nextModelsRefreshDelayMs(() => 0)).toBe(sixHours);
  expect(nextModelsRefreshDelayMs(() => 0.999999999)).toBe(sixHours + (6 * 3600 - 1) * 1000);
  const d = nextModelsRefreshDelayMs(() => 0.5);
  expect(d % 1000).toBe(0);
  expect(d).toBe(sixHours + 3 * 3600_000);
});

it('uses each mother account’s operations address and key to provision and sync, and its private key for inference', async () => {
  const rows = new Map<string, Record<string, any>>();
  const findUnique = vi.fn(async ({ where }: { where: { id?: string; accountName?: string } }) =>
    rows.get(where.id ?? where.accountName ?? '') ?? null);
  const db = {
    gatewayMotherAccount: {
      findUnique,
      findUniqueOrThrow: findUnique,
      create: vi.fn(async ({ data }) => {
        const row = { id: data.accountName, enabled: true, status: 'pending', ...data };
        rows.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }) => Object.assign(rows.get(where.id)!, data)),
    },
    siteSetting: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn() },
    $transaction: (fn: (tx: unknown) => unknown) => fn(db),
  };
  vi.mocked(provisionOneKey).mockImplementation(async (cfg, params) => ({
    account: params.account, requestId: params.requestId, replayed: false,
    keys: [`private-for-${cfg.opKey}`], clients: [],
  }));
  vi.mocked(fetchModels).mockResolvedValue(['claude-sonnet-4-6']);
  vi.mocked(fetchAccountUsage).mockImplementation(async (_cfg, account) => ({
    generatedAt: Date.now(), account: { id: account, name: account, enabled: true, windows: [] },
  }));

  const pool = new GatewayPoolService(db as any);
  for (const suffix of ['one', 'two']) {
    const account = `mother-${suffix}@example.test`;
    const baseUrl = `https://pool-${suffix}.example.test`;
    const opKey = `operator-${suffix}`;
    const view = await pool.add(account, undefined, baseUrl, undefined, opKey);
    expect(view).toMatchObject({ baseUrl, hasOpKey: true, status: 'ready' });
    expect(view).not.toHaveProperty('opKeyCipher');
    expect(view).not.toHaveProperty('keyCipher');
    expect(provisionOneKey).toHaveBeenLastCalledWith({ baseUrl, opKey }, expect.objectContaining({ account }));
    expect(fetchModels).toHaveBeenLastCalledWith(baseUrl, `private-for-${opKey}`);
    await pool.quotaSnapshot(view.id);
    expect(fetchAccountUsage).toHaveBeenLastCalledWith({ baseUrl, opKey }, account);
    expect(await pool.getForwardTarget(view.id)).toMatchObject({ baseUrl, key: `private-for-${opKey}` });
  }
  expect(db.siteSetting.findMany).not.toHaveBeenCalled();
});
