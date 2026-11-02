import { describe, it, expect, vi } from 'vitest';
vi.mock('./key-vault', () => ({ decryptKey: () => 'test-only', encryptKey: () => 'cipher', keyHint: () => 'hint' }));
vi.mock('./upstream-client', async (original) => ({ ...await original<typeof import('./upstream-client')>(), fetchAccountKeyUsage: vi.fn(), fetchModels: vi.fn() }));
import { GatewayPoolService } from './gateway-pool.service';
import { fetchAccountKeyUsage, fetchModels, UpstreamError } from './upstream-client';
it.each([401, 503, 200])('empty usage checks key without confusing a %s response with exhaustion', async status => {
  vi.mocked(fetchAccountKeyUsage).mockResolvedValue([]);
  if (status === 200) vi.mocked(fetchModels).mockResolvedValue(['model']);
  else vi.mocked(fetchModels).mockRejectedValue(new UpstreamError('models failed', status));
  const row = { id: 'm', accountName: 'test', keyCipher: 'cipher', status: 'ready', baseUrl: 'https://test.invalid' };
  const update = vi.fn(); const db: any = {
    gatewayMotherAccount: { findUnique: vi.fn().mockResolvedValue(row), findUniqueOrThrow: vi.fn().mockResolvedValue(row), update },
    siteSetting: { findMany: vi.fn().mockResolvedValue([{ key: 'gateway_upstream_op_key_cipher', value: 'cipher' }]) },
    $transaction: (fn: any) => fn(db),
  };
  await (new GatewayPoolService(db) as any).syncUsage('m');
  const data = update.mock.calls[0][0].data;
  expect(data.usageJson).toBe('[]');
  if (status === 401) { expect(data.status).toBe('key_lost'); expect(data.lastError).toContain('401'); }
  else { expect(data.status).toBeUndefined(); expect(data.lastError).toContain('未返回'); }
});
