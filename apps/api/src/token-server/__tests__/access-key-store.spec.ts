import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { AccessKeyStore } from '../access-key-store';

let tmpDir: string;
let accessKeysPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-key-test-'));
  accessKeysPath = path.join(tmpDir, 'access-keys.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeStore(keys: any[] = []) {
  fs.writeFileSync(accessKeysPath, JSON.stringify({ keys, updatedAt: '' }));
  return new AccessKeyStore(accessKeysPath);
}

// ── Basic CRUD ───────────────────────────────────────────────────────────────

describe('AccessKeyStore', () => {
  describe('readAll / findByKey', () => {
    it('should load keys from disk', () => {
      const store = makeStore([{ id: 'k1', key: 'secret1', status: 'active' }]);
      const keys = store.readAll();
      expect(keys.keys).toHaveLength(1);
      expect(keys.keys[0].id).toBe('k1');
    });

    it('should return empty keys for non-existent file', () => {
      const store = new AccessKeyStore(path.join(tmpDir, 'missing.json'));
      expect(store.readAll().keys).toEqual([]);
    });

    it('should find key by constant-time comparison', () => {
      const store = makeStore([
        { id: 'k1', key: 'secret1', status: 'active' },
        { id: 'k2', key: 'secret2', status: 'active' },
      ]);
      const record = store.findByKey('secret2');
      expect(record?.id).toBe('k2');
    });

    it('should return null for non-existent key', () => {
      const store = makeStore([{ id: 'k1', key: 'secret1', status: 'active' }]);
      expect(store.findByKey('wrong')).toBeNull();
    });
  });

  describe('findById', () => {
    it('should find key by id', () => {
      const store = makeStore([{ id: 'k1', key: 'secret1', status: 'active' }]);
      expect(store.findById('k1')?.key).toBe('secret1');
    });

    it('should return null for non-existent id', () => {
      const store = makeStore([]);
      expect(store.findById('missing')).toBeNull();
    });
  });

  // ── Key resolution (the core auth flow) ──────────────────────────────────

  describe('resolveFromRequest', () => {
    it('should resolve active key from x-access-key header', () => {
      const store = makeStore([{ id: 'k1', key: 'secret1', status: 'active' }]);
      const result = store.resolveFromRequest(
        { headers: { 'x-access-key': 'secret1' } } as any,
        {},
      );
      expect(result.record?.id).toBe('k1');
      expect(result.error).toBeUndefined();
    });

    it('should resolve from payload.accessKey', () => {
      const store = makeStore([{ id: 'k1', key: 'secret1', status: 'active' }]);
      const result = store.resolveFromRequest(
        { headers: {} } as any,
        { accessKey: 'secret1' },
      );
      expect(result.record?.id).toBe('k1');
    });

    it('should resolve from Bearer token', () => {
      const store = makeStore([{ id: 'k1', key: 'secret1', status: 'active' }]);
      const result = store.resolveFromRequest(
        { headers: { authorization: 'Bearer secret1' } } as any,
        {},
      );
      expect(result.record?.id).toBe('k1');
    });

    it('should return error for missing key', () => {
      const store = makeStore([]);
      const result = store.resolveFromRequest({ headers: {} } as any, {});
      expect(result.record).toBeNull();
      expect(result.error).toBe('Missing access key');
    });

    it('should return error for invalid key', () => {
      const store = makeStore([{ id: 'k1', key: 'secret1', status: 'active' }]);
      const result = store.resolveFromRequest(
        { headers: { 'x-access-key': 'wrong' } } as any,
        {},
      );
      expect(result.record).toBeNull();
      expect(result.error).toBe('Invalid access key');
    });

    it('should return error for disabled key', () => {
      const store = makeStore([{ id: 'k1', key: 'secret1', status: 'disabled' }]);
      const result = store.resolveFromRequest(
        { headers: { 'x-access-key': 'secret1' } } as any,
        {},
      );
      expect(result.record).toBeNull();
      expect(result.error).toBe('Access key disabled');
    });

    it('should mark key as expired if past duration', () => {
      const store = makeStore([{
        id: 'k1',
        key: 'secret1',
        status: 'active',
        firstUsedAt: '2020-01-01T00:00:00.000Z',
        durationMs: 1000,
      }]);
      const result = store.resolveFromRequest(
        { headers: { 'x-access-key': 'secret1' } } as any,
        {},
      );
      expect(result.record).toBeNull();
      expect(result.error).toBe('Access key expired');
    });
  });

  // ── Usage recording ──────────────────────────────────────────────────────

  describe('recordUsage', () => {
    it('should increment totalRequests', () => {
      const store = makeStore([{
        id: 'k1', key: 'secret1', status: 'active',
        totalRequests: 0, usageEvents: [], tokenUsageEvents: [],
        windowStartedAt: Date.now(),
      }]);
      store.recordUsage('k1', 200, { inputTokens: 100, outputTokens: 50 }, '');
      const record = store.findById('k1');
      expect(record?.totalRequests).toBe(1);
      expect(record?.totalInputTokens).toBe(100);
    });

    it('should not throw for unknown cardId', () => {
      const store = makeStore([]);
      expect(() => store.recordUsage('unknown', 200, {}, '')).not.toThrow();
    });
  });

  // ── Session management ─────────────────────────────────────────────────

  describe('session management', () => {
    it('should create a session on first access', () => {
      const store = makeStore([{
        id: 'k1', key: 'secret1', status: 'active',
        usageEvents: [], tokenUsageEvents: [],
      }]);
      const record = store.findById('k1')!;
      const validation = store.validateSession(record, { clientId: 'client-1' });
      expect(validation.ok).toBe(true);
      expect(validation.action).toBe('create');
    });

    it('should reject session from different device', () => {
      const store = makeStore([{
        id: 'k1', key: 'secret1', status: 'active',
        activeSessionId: 'sess_existing',
        sessionClientId: 'client-1',
        sessionStartedAt: new Date().toISOString(),
        sessionExpiresAt: new Date(Date.now() + 600000).toISOString(),
        usageEvents: [], tokenUsageEvents: [],
      }]);
      const record = store.findById('k1')!;
      const validation = store.validateSession(record, {
        sessionId: 'sess_other',
        clientId: 'client-2',
      });
      expect(validation.ok).toBe(false);
      expect(validation.statusCode).toBe(409);
    });
  });

  // ── Flush to disk ──────────────────────────────────────────────────────

  describe('flush', () => {
    it('should persist changes to disk after flush', () => {
      const store = makeStore([{
        id: 'k1', key: 'secret1', status: 'active',
        totalRequests: 0, usageEvents: [], tokenUsageEvents: [],
        windowStartedAt: Date.now(),
      }]);
      store.recordUsage('k1', 200, { inputTokens: 100, outputTokens: 50 }, '');
      store.flush();

      // Re-read from disk
      const raw = JSON.parse(fs.readFileSync(accessKeysPath, 'utf8'));
      expect(raw.keys[0].totalRequests).toBe(1);
    });
  });
});
