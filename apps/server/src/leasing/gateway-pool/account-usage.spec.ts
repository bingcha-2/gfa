import { afterEach, expect, it, vi } from 'vitest';
import { fetchAccountUsage } from './upstream-client';
import { accountUsageRows } from './account-usage';
import { upstreamWindows } from './quota-windows';
import { upstreamWindowTransition } from './upstream-window';
const now = 1800000000000;
function snapshot(remaining: number | null = .8, seenAt: number | null = now - 300000) {
  return { generatedAt: now, account: { id: 'a', name: 'a+b@test', enabled: true, windows: [
    { bucket: 'unified5h', used: remaining === null ? null : 1 - remaining, remaining, resetAt: now + 100000, seenAt },
    { bucket: 'unified7d', used: .3, remaining: .7, resetAt: now + 200000, seenAt },
    { bucket: 'unified7dSonnet', used: 1, remaining: 0, resetAt: now + 200000, seenAt },
  ] } };
}
afterEach(() => vi.unstubAllGlobals());
it('calls the operator endpoint, encoding the exact name, and accepts an account object', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshot())));
  vi.stubGlobal('fetch', fetcher);
  await expect(fetchAccountUsage({ baseUrl: 'https://test.invalid/', opKey: 'test-key' }, 'a+b@test')).resolves.toEqual(snapshot());
  expect(fetcher.mock.calls[0][0]).toBe('https://test.invalid/teamclaude/ops/account-usage?account=a%2Bb%40test');
  expect(fetcher.mock.calls[0][1].headers['x-api-key']).toBe('test-key');
});
it.each([[], { account: { name: 'different', windows: [] } }, { account: { name: 'a+b@test' } }])('rejects mismatched/old/malformed responses', async body => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
  await expect(fetchAccountUsage({ baseUrl: 'https://test.invalid', opKey: 'test-key' }, 'a+b@test')).rejects.toThrow('unexpected account usage');
});
it.each([null, 0, .8])('preserves unknown and zero readings: %s', remaining => {
  const data = snapshot(remaining);
  const windows = upstreamWindows({ accountName: data.account.name, usageJson: JSON.stringify(data), usageSyncedAt: new Date(now) }, now);
  expect(windows[0].remaining).toBe(remaining);
  expect(windows[0].state).toBe(remaining === null ? 'unknown' : 'limited');
  expect(windows[0].exhausted).toBe(remaining === 0);
  expect(windows[1].remaining).toBe(.7);
});
it.each([null, now - 600001, now + 1])('does not refresh old or unknown observations using generatedAt: %s', seenAt => {
  const data = snapshot(.8, seenAt);
  expect(accountUsageRows(data, now)[0].share.windows['5h'].freshness).toBe('unknown');
  expect(upstreamWindowTransition(data, data.account.name, now - 1000, now).reset).toBe(false);
});
it('missing windows remain unknown, not unlimited', () => {
  const data = snapshot(); data.account.windows = [];
  expect(upstreamWindows({ accountName: data.account.name, usageJson: JSON.stringify(data), usageSyncedAt: new Date(now) }, now).map(w => w.state)).toEqual(['unknown', 'unknown']);
});
