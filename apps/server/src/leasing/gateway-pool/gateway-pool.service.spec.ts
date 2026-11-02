import { it, expect, vi } from 'vitest';
vi.mock('./key-vault', () => ({ decryptKey: () => 'test-only', encryptKey: () => 'cipher', keyHint: () => 'hint' }));
vi.mock('./upstream-client', async (original) => ({ ...await original<typeof import('./upstream-client')>(), fetchAccountUsage: vi.fn(), fetchModels: vi.fn() }));
import { GatewayPoolService } from './gateway-pool.service';
import { fetchAccountUsage, fetchModels, UpstreamError } from './upstream-client';

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
