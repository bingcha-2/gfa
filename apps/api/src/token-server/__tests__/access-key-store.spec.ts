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

  // ── Token limit enforcement ─────────────────────────────────────────────

  describe('resolveFromRequest — enforceLimit', () => {
    function makeKeyWithUsage(tokenEvents: any[]) {
      return makeStore([{
        id: 'k1', key: 'secret1', status: 'active',
        tokenWindowLimit: 500_000,
        windowStartedAt: Date.now(),
        usageEvents: [],
        tokenUsageEvents: tokenEvents,
      }]);
    }

    it('should reject when Opus tokens exceed limit', () => {
      const store = makeKeyWithUsage([
        { at: Date.now(), inputTokens: 300_000, outputTokens: 200_001, modelKey: 'claude-sonnet-4-6' },
      ]);
      const result = store.resolveFromRequest(
        { headers: { 'x-access-key': 'secret1' } } as any,
        {},
        { enforceLimit: true, modelKey: 'claude-sonnet-4-6' },
      );
      expect(result.record).toBeNull();
      expect(result.error).toContain('Opus token limit exceeded');
    });

    it('should reject when Gemini tokens exceed limit (5x multiplier)', () => {
      // Gemini limit = tokenWindowLimit * 5 = 2,500,000
      const store = makeKeyWithUsage([
        { at: Date.now(), inputTokens: 1_500_000, outputTokens: 1_000_001, modelKey: 'gemini-2.5-pro' },
      ]);
      const result = store.resolveFromRequest(
        { headers: { 'x-access-key': 'secret1' } } as any,
        {},
        { enforceLimit: true, modelKey: 'gemini-2.5-pro' },
      );
      expect(result.record).toBeNull();
      expect(result.error).toContain('Gemini token limit exceeded');
    });

    it('should allow request when tokens are under limit', () => {
      const store = makeKeyWithUsage([
        { at: Date.now(), inputTokens: 100, outputTokens: 50, modelKey: 'claude-sonnet-4-6' },
      ]);
      const result = store.resolveFromRequest(
        { headers: { 'x-access-key': 'secret1' } } as any,
        {},
        { enforceLimit: true, modelKey: 'claude-sonnet-4-6' },
      );
      expect(result.record).not.toBeNull();
      expect(result.record?.id).toBe('k1');
    });

    it('should reject only when ALL buckets (gemini/opus/codex) exceed limit (no modelKey)', () => {
      const store = makeKeyWithUsage([
        { at: Date.now(), inputTokens: 300_000, outputTokens: 200_001, modelKey: 'claude-opus' },
        { at: Date.now(), inputTokens: 1_500_000, outputTokens: 1_000_001, modelKey: 'gemini-2.5-pro' },
        { at: Date.now(), inputTokens: 300_000, outputTokens: 200_001, modelKey: 'gpt-5-codex' },
      ]);
      // No modelKey → requires every bucket to be exceeded
      const result = store.resolveFromRequest(
        { headers: { 'x-access-key': 'secret1' } } as any,
        {},
        { enforceLimit: true },
      );
      expect(result.record).toBeNull();
      expect(result.error).toContain('token limit exceeded');
    });

    it('should reject when all USED buckets exhausted even if an unused bucket has headroom (no modelKey)', () => {
      // Regression: opus + gemini fully used and exhausted, codex never used.
      // The codex bucket's 0 usage must NOT keep the card alive — an exhausted
      // card with no modelKey has to be rejected.
      const store = makeKeyWithUsage([
        { at: Date.now(), inputTokens: 300_000, outputTokens: 200_001, modelKey: 'claude-opus' },
        { at: Date.now(), inputTokens: 1_500_000, outputTokens: 1_000_001, modelKey: 'gemini-2.5-pro' },
      ]);
      const result = store.resolveFromRequest(
        { headers: { 'x-access-key': 'secret1' } } as any,
        {},
        { enforceLimit: true },
      );
      expect(result.record).toBeNull();
      expect(result.error).toContain('token limit exceeded');
    });

    it('should allow when only one category exceeds limit (no modelKey)', () => {
      const store = makeKeyWithUsage([
        { at: Date.now(), inputTokens: 300_000, outputTokens: 200_001, modelKey: 'claude-opus' },
        // Gemini is under limit
        { at: Date.now(), inputTokens: 100, outputTokens: 50, modelKey: 'gemini-2.5-pro' },
      ]);
      const result = store.resolveFromRequest(
        { headers: { 'x-access-key': 'secret1' } } as any,
        {},
        { enforceLimit: true },
      );
      expect(result.record).not.toBeNull();
    });
  });

  // ── Key extraction from various sources ──────────────────────────────────

  describe('resolveFromRequest — key extraction', () => {
    it('should resolve from payload.accountCard', () => {
      const store = makeStore([{ id: 'k1', key: 'secret1', status: 'active' }]);
      const result = store.resolveFromRequest(
        { headers: {} } as any,
        { accountCard: 'secret1' },
      );
      expect(result.record?.id).toBe('k1');
    });

    it('should resolve from payload.cardKey', () => {
      const store = makeStore([{ id: 'k1', key: 'secret1', status: 'active' }]);
      const result = store.resolveFromRequest(
        { headers: {} } as any,
        { cardKey: 'secret1' },
      );
      expect(result.record?.id).toBe('k1');
    });

    it('should resolve from payload.key', () => {
      const store = makeStore([{ id: 'k1', key: 'secret1', status: 'active' }]);
      const result = store.resolveFromRequest(
        { headers: {} } as any,
        { key: 'secret1' },
      );
      expect(result.record?.id).toBe('k1');
    });

    it('should set firstUsedAt on activate', () => {
      const store = makeStore([{ id: 'k1', key: 'secret1', status: 'active' }]);
      const result = store.resolveFromRequest(
        { headers: { 'x-access-key': 'secret1' } } as any,
        {},
        { activate: true },
      );
      expect(result.record?.firstUsedAt).toBeTruthy();
    });

    it('should not overwrite existing firstUsedAt on activate', () => {
      const originalDate = '2025-01-01T00:00:00.000Z';
      const store = makeStore([{
        id: 'k1', key: 'secret1', status: 'active',
        firstUsedAt: originalDate, durationMs: 10 * 365 * 24 * 3600 * 1000,
      }]);
      const result = store.resolveFromRequest(
        { headers: { 'x-access-key': 'secret1' } } as any,
        {},
        { activate: true },
      );
      expect(result.record?.firstUsedAt).toBe(originalDate);
    });
  });

  // ── Session validation (comprehensive) ──────────────────────────────────

  describe('validateSession — comprehensive', () => {
    it('should allow refresh when same sessionId and same clientId', () => {
      const store = makeStore([{
        id: 'k1', key: 'secret1', status: 'active',
        activeSessionId: 'sess_abc',
        sessionClientId: 'client-1',
        sessionStartedAt: new Date().toISOString(),
        sessionExpiresAt: new Date(Date.now() + 600000).toISOString(),
      }]);
      const record = store.findById('k1')!;
      const result = store.validateSession(record, {
        sessionId: 'sess_abc',
        clientId: 'client-1',
      });
      expect(result.ok).toBe(true);
      expect(result.action).toBe('refresh');
    });

    it('should reject when same sessionId but different clientId', () => {
      const store = makeStore([{
        id: 'k1', key: 'secret1', status: 'active',
        activeSessionId: 'sess_abc',
        sessionClientId: 'client-1',
        sessionStartedAt: new Date().toISOString(),
        sessionExpiresAt: new Date(Date.now() + 600000).toISOString(),
      }]);
      const record = store.findById('k1')!;
      const result = store.validateSession(record, {
        sessionId: 'sess_abc',
        clientId: 'client-2',
      });
      expect(result.ok).toBe(false);
      expect(result.statusCode).toBe(409);
      expect(result.error).toContain('another client');
    });

    it('should reject when same sessionId but no clientId', () => {
      const store = makeStore([{
        id: 'k1', key: 'secret1', status: 'active',
        activeSessionId: 'sess_abc',
        sessionClientId: 'client-1',
        sessionStartedAt: new Date().toISOString(),
        sessionExpiresAt: new Date(Date.now() + 600000).toISOString(),
      }]);
      const record = store.findById('k1')!;
      const result = store.validateSession(record, {
        sessionId: 'sess_abc',
        // no clientId
      });
      expect(result.ok).toBe(false);
      expect(result.statusCode).toBe(409);
    });

    it('should allow creating new session when existing session is expired', () => {
      const store = makeStore([{
        id: 'k1', key: 'secret1', status: 'active',
        activeSessionId: 'sess_old',
        sessionClientId: 'client-1',
        sessionStartedAt: new Date(Date.now() - 3600000).toISOString(),
        sessionExpiresAt: new Date(Date.now() - 1000).toISOString(), // expired
      }]);
      const record = store.findById('k1')!;
      const result = store.validateSession(record, {
        clientId: 'client-2',
      });
      expect(result.ok).toBe(true);
      expect(result.action).toBe('create');
    });

    it('should allow same clientId reuse without sessionId', () => {
      const store = makeStore([{
        id: 'k1', key: 'secret1', status: 'active',
        activeSessionId: 'sess_abc',
        sessionClientId: 'client-1',
        sessionStartedAt: new Date().toISOString(),
        sessionExpiresAt: new Date(Date.now() + 600000).toISOString(),
      }]);
      const record = store.findById('k1')!;
      const result = store.validateSession(record, {
        clientId: 'client-1',
        // no sessionId — same client reconnecting
      });
      expect(result.ok).toBe(true);
      expect(result.sameClientSessionReuse).toBe(true);
    });
  });

  // ── Session refresh modes ──────────────────────────────────────────────

  describe('refreshSession', () => {
    it('should create new sessionId in create mode', () => {
      const store = makeStore([{
        id: 'k1', key: 'secret1', status: 'active',
        activeSessionId: 'sess_old',
        sessionClientId: 'client-1',
      }]);
      const record = store.findById('k1')!;
      const newSessionId = store.refreshSession(record, { clientId: 'client-2' }, Date.now(), { create: true });
      expect(newSessionId).not.toBe('sess_old');
      expect(record.sessionClientId).toBe('client-2');
    });

    it('should rotate sessionId in rotate mode', () => {
      const store = makeStore([{
        id: 'k1', key: 'secret1', status: 'active',
        activeSessionId: 'sess_old',
        sessionClientId: 'client-1',
        sessionExpiresAt: new Date(Date.now() + 600000).toISOString(),
      }]);
      const record = store.findById('k1')!;
      const newSessionId = store.refreshSession(record, { clientId: 'client-1' }, Date.now(), { rotate: true });
      expect(newSessionId).not.toBe('sess_old');
      expect(record.sessionClientId).toBe('client-1');
    });

    it('should keep existing sessionId in normal refresh mode', () => {
      const now = Date.now();
      const store = makeStore([{
        id: 'k1', key: 'secret1', status: 'active',
        activeSessionId: 'sess_existing',
        sessionClientId: 'client-1',
        sessionStartedAt: new Date(now).toISOString(),
        sessionExpiresAt: new Date(now + 600000).toISOString(),
      }]);
      const record = store.findById('k1')!;
      const sessionId = store.refreshSession(record, { clientId: 'client-1' }, now);
      expect(sessionId).toBe('sess_existing');
    });

    it('should set sessionExpiresAt on refresh', () => {
      const now = Date.now();
      const store = makeStore([{
        id: 'k1', key: 'secret1', status: 'active',
      }]);
      const record = store.findById('k1')!;
      store.refreshSession(record, { clientId: 'client-1' }, now, { create: true });
      expect(record.sessionExpiresAt).toBeTruthy();
      const expiresAt = Date.parse(record.sessionExpiresAt!);
      expect(expiresAt).toBeGreaterThan(now);
    });
  });

  // ── publicStatus ──────────────────────────────────────────────────────

  describe('publicStatus', () => {
    it('should return correct structure with computed fields', () => {
      const now = Date.now();
      const store = makeStore([{
        id: 'k1', key: 'secret1', status: 'active',
        name: 'Test Key',
        firstUsedAt: new Date(now - 1000).toISOString(),
        durationMs: 3600_000,
        tokenWindowLimit: 100_000,
        windowStartedAt: now,
        totalRequests: 5,
        totalTokensUsed: 1234,
        usageEvents: [],
        tokenUsageEvents: [],
      }]);
      const record = store.findById('k1')!;
      const status = store.publicStatus(record);

      expect(status.id).toBe('k1');
      expect(status.name).toBe('Test Key');
      expect(status.status).toBe('active');
      expect(status.totalRequests).toBe(5);
      expect(status.totalTokensUsed).toBe(1234);
      expect(status.tokenWindowLimit).toBe(100_000);
      expect(status.tokenWindowMs).toBe(5 * 60 * 60 * 1000);
      expect(status.remainingMs).toBeGreaterThan(0);
      expect(status.expiresAt).toBeTruthy();
      expect(status.tokenWindowResetMs).toBeGreaterThan(0);
      expect(status.hasActiveSession).toBe(false);
    });
  });
});
