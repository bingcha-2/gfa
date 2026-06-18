import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { AccessKeyStore } from '../access-key-store';

let tmpDir: string;
let accessKeysPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-key-bound-'));
  accessKeysPath = path.join(tmpDir, 'access-keys.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// File cards land in byId via the on-disk keys array (rebuildIndex on readAll).
function makeStore(keys: any[] = []) {
  fs.writeFileSync(accessKeysPath, JSON.stringify({ keys, updatedAt: '' }));
  const store = new AccessKeyStore(accessKeysPath);
  store.readAll(); // force load → byId populated
  return store;
}

describe('AccessKeyStore.getRecordsBoundTo', () => {
  it('returns the records bound to the given account (and exposes their weight)', () => {
    const store = makeStore([
      { id: 'k1', key: 's1', status: 'active', provider: 'codex', boundAccountId: 7, weight: 5 },
      { id: 'k2', key: 's2', status: 'active', provider: 'codex', boundAccountId: 7, weight: 2 },
    ]);
    const recs = store.getRecordsBoundTo(7, 'codex');
    expect(recs.map((r) => r.id).sort()).toEqual(['k1', 'k2']);
    const weights = recs.map((r) => (r as any).weight).sort();
    expect(weights).toEqual([2, 5]);
  });

  it('excludes records bound to a different account and unbound records', () => {
    const store = makeStore([
      { id: 'bound', key: 's1', status: 'active', provider: 'codex', boundAccountId: 7 },
      { id: 'other', key: 's2', status: 'active', provider: 'codex', boundAccountId: 9 },
      { id: 'unbound', key: 's3', status: 'active' },
      { id: 'wrong-pool', key: 's4', status: 'active', provider: 'antigravity', boundAccountId: 7 },
    ]);
    const recs = store.getRecordsBoundTo(7, 'codex');
    expect(recs.map((r) => r.id)).toEqual(['bound']);
  });

  it('includes both a file-card (byId) and a subscription record (subscriptionById) bound to the account', () => {
    const store = makeStore([
      { id: 'file-card', key: 's1', status: 'active', provider: 'codex', boundAccountId: 7, weight: 3 },
    ]);
    store.loadSubscriptionRecords([
      { id: 'sub-card', key: 'BCAI-SUB', customerId: 'c1', status: 'active', products: ['codex'], bindings: { codex: 7 }, weight: 4 },
    ]);
    const recs = store.getRecordsBoundTo(7, 'codex');
    expect(recs.map((r) => r.id).sort()).toEqual(['file-card', 'sub-card']);
  });

  it('skips an inactive subscription record', () => {
    const store = makeStore();
    store.loadSubscriptionRecords([
      { id: 'sub-active', customerId: 'c1', status: 'active', products: ['codex'], bindings: { codex: 7 } },
      { id: 'sub-expired', customerId: 'c1', status: 'expired', products: ['codex'], bindings: { codex: 7 } },
    ]);
    const recs = store.getRecordsBoundTo(7, 'codex');
    expect(recs.map((r) => r.id)).toEqual(['sub-active']);
  });

  it('returns [] for accountId <= 0', () => {
    const store = makeStore([
      { id: 'k1', key: 's1', status: 'active', provider: 'codex', boundAccountId: 7 },
    ]);
    expect(store.getRecordsBoundTo(0, 'codex')).toEqual([]);
    expect(store.getRecordsBoundTo(-1, 'codex')).toEqual([]);
  });

  it('dedupes by id when a record sits in both byId and subscriptionById', () => {
    const store = makeStore([
      { id: 'dup', key: 's1', status: 'active', provider: 'codex', boundAccountId: 7 },
    ]);
    store.loadSubscriptionRecords([
      { id: 'dup', key: 'BCAI-SUB', customerId: 'c1', status: 'active', products: ['codex'], bindings: { codex: 7 } },
    ]);
    const recs = store.getRecordsBoundTo(7, 'codex');
    expect(recs.filter((r) => r.id === 'dup')).toHaveLength(1);
  });
});
