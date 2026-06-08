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

// ── computeUsageDetail 口径归一 ───────────────────────────────────────────────

describe('AccessKeyStore.computeUsageDetail (normalizeUsageToGross 收口)', () => {
  it('claude: net input 归一为 gross,billable 折扣 cache_read', () => {
    const store = makeStore([{ id: 'k1', key: 's', status: 'active' }]);
    // Anthropic 上报 net input=100, cache_read=80, cache_creation=50(含于 rawTotal), output=10
    const d = store.computeUsageDetail(
      { inputTokens: 100, outputTokens: 10, cachedInputTokens: 80, rawTotalTokens: 240 },
      'claude-opus-4',
      'anthropic',
    );
    expect(d.inputTokens).toBe(230); // gross,供 fairShare 的 netInput 用
    expect(d.cachedInputTokens).toBe(80);
    expect(d.rawTotalTokens).toBe(240);
    expect(d.totalTokens).toBe(168); // 240-80+ceil(80/10)
  });

  it('gemini: 已 gross,detail 不变', () => {
    const store = makeStore([{ id: 'k1', key: 's', status: 'active' }]);
    const d = store.computeUsageDetail(
      { inputTokens: 180, outputTokens: 20, cachedInputTokens: 80 },
      'gemini-2.5-pro',
      'antigravity',
    );
    expect(d.inputTokens).toBe(180);
    expect(d.totalTokens).toBe(128); // 200-80+8
  });
});

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
    // Per-model caps (bucketLimits). Both composite (`<product>-<family>`, used by
    // product-scoped requests) and bare-family keys (used by legacy/no-product events
    // and the no-modelKey path) are set so every case below resolves to a real cap.
    function makeKeyWithUsage(tokenEvents: any[]) {
      return makeStore([{
        id: 'k1', key: 'secret1', status: 'active',
        bucketLimits: {
          'anthropic-claude': 500_000, 'claude': 500_000,
          'antigravity-gemini': 2_500_000, 'gemini': 2_500_000,
          'codex-gpt': 500_000, 'gpt': 500_000,
        },
        windowStartedAt: Date.now(),
        usageEvents: [],
        tokenUsageEvents: tokenEvents,
      }]);
    }

    it('should reject when Claude (anthropic) tokens exceed limit', () => {
      const store = makeKeyWithUsage([
        { at: Date.now(), inputTokens: 300_000, outputTokens: 200_001, modelKey: 'claude-sonnet-4-6', product: 'anthropic' },
      ]);
      const result = store.resolveFromRequest(
        { headers: { 'x-access-key': 'secret1' } } as any,
        {},
        { enforceLimit: true, modelKey: 'claude-sonnet-4-6', product: 'anthropic' },
      );
      expect(result.record).toBeNull();
      // Composite bucket anthropic-claude → label "Anthropic · Claude".
      expect(result.error).toContain('Claude token limit exceeded');
    });

    it('reports the over-limit window per the card windowMs, not a hardcoded 5h', () => {
      const store = makeStore([{
        id: 'k1', key: 'secret1', status: 'active',
        windowMs: 24 * 60 * 60 * 1000, // 1-day window, not the default 5h
        bucketLimits: { 'anthropic-claude': 500_000 },
        windowStartedAt: Date.now(),
        usageEvents: [],
        tokenUsageEvents: [
          { at: Date.now(), inputTokens: 300_000, outputTokens: 200_001, modelKey: 'claude-sonnet-4-6', product: 'anthropic' },
        ],
      }]);
      const result = store.resolveFromRequest(
        { headers: { 'x-access-key': 'secret1' } } as any,
        {},
        { enforceLimit: true, modelKey: 'claude-sonnet-4-6', product: 'anthropic' },
      );
      expect(result.record).toBeNull();
      expect(result.error).toContain('tokens/1d');
      expect(result.error).not.toContain('tokens/5h');
    });

    it('should reject when Gemini tokens exceed limit (5x multiplier)', () => {
      // Gemini limit = tokenWindowLimit * 5 = 2,500,000
      const store = makeKeyWithUsage([
        { at: Date.now(), inputTokens: 1_500_000, outputTokens: 1_000_001, modelKey: 'gemini-2.5-pro', product: 'antigravity' },
      ]);
      const result = store.resolveFromRequest(
        { headers: { 'x-access-key': 'secret1' } } as any,
        {},
        { enforceLimit: true, modelKey: 'gemini-2.5-pro', product: 'antigravity' },
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

    // 无 modelKey 的预热 / 探活不消费任何具体桶 → 不做额度拦截(不管桶怎么设、用没用爆)。
    // 真实消费都带 modelKey,走精确单桶检查。下面用你这张卡的真实配置(四个产品都设了上限,
    // 只有 anthropic-claude 用爆 130973/100000)验证跨产品不连累。
    function makeFourBucketCard() {
      return makeStore([{
        id: 'k1', key: 'secret1', status: 'active',
        bucketLimits: {
          'anthropic-claude': 100_000,
          'antigravity-gemini': 10_000,
          'antigravity-claude': 10_000,
          'codex-gpt': 1_000,
        },
        windowStartedAt: Date.now(),
        usageEvents: [],
        // 只有 anthropic-claude 用爆;antigravity / codex 一个 token 都没用(满额)。
        tokenUsageEvents: [
          { at: Date.now(), inputTokens: 80_000, outputTokens: 50_973, modelKey: 'claude-opus-4-8', product: 'anthropic' },
        ],
      }]);
    }

    it('warm-lease (no modelKey) is NOT blocked even though anthropic-claude is exhausted', () => {
      // 核心回归:antigravity-gemini 是 0/10000 满额,预热绝不能被 anthropic 的耗尽连累。
      const store = makeFourBucketCard();
      const result = store.resolveFromRequest(
        { headers: { 'x-access-key': 'secret1' } } as any,
        {},
        { enforceLimit: true }, // 无 modelKey(预热)
      );
      expect(result.record).not.toBeNull();
      expect(result.record?.id).toBe('k1');
    });

    it('claude request (with modelKey) is still precisely rejected — only the exhausted bucket', () => {
      const store = makeFourBucketCard();
      const result = store.resolveFromRequest(
        { headers: { 'x-access-key': 'secret1' } } as any,
        {},
        { enforceLimit: true, modelKey: 'claude-opus-4-8', product: 'anthropic' },
      );
      expect(result.record).toBeNull();
      expect(result.error).toContain('Claude token limit exceeded');
    });

    it('antigravity gemini (with modelKey) is allowed — its own bucket has headroom (0/10000)', () => {
      const store = makeFourBucketCard();
      const result = store.resolveFromRequest(
        { headers: { 'x-access-key': 'secret1' } } as any,
        {},
        { enforceLimit: true, modelKey: 'gemini-2.5-pro', product: 'antigravity' },
      );
      expect(result.record).not.toBeNull();
    });

    it('no-modelKey is not blocked even when EVERY bucket is exhausted (preheat consumes nothing)', () => {
      // 即便所有桶都爆,无 modelKey 的预热仍放行 —— 它不消费;真实请求各自带 modelKey 被精确拦。
      const store = makeKeyWithUsage([
        { at: Date.now(), inputTokens: 300_000, outputTokens: 200_001, modelKey: 'claude-opus' },
        { at: Date.now(), inputTokens: 1_500_000, outputTokens: 1_000_001, modelKey: 'gemini-2.5-pro' },
        { at: Date.now(), inputTokens: 300_000, outputTokens: 200_001, modelKey: 'gpt-5-codex' },
      ]);
      const result = store.resolveFromRequest(
        { headers: { 'x-access-key': 'secret1' } } as any,
        {},
        { enforceLimit: true },
      );
      expect(result.record).not.toBeNull();
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

  // ── Per-model caps via bucketLimits (no global tokenWindowLimit) ──────────

  describe('resolveFromRequest — bucketLimits (per-model caps)', () => {
    function makeCard(extra: any) {
      return makeStore([{
        id: 'k1', key: 'secret1', status: 'active',
        windowStartedAt: Date.now(), usageEvents: [], ...extra,
      }]);
    }
    const claudeReq = { headers: { 'x-access-key': 'secret1' } } as any;
    const opts = { enforceLimit: true, modelKey: 'claude-sonnet-4-6', product: 'anthropic' };

    it('enforces a bucketLimits cap even without a global tokenWindowLimit', () => {
      const store = makeCard({
        bucketLimits: { 'anthropic-claude': 500_000 },
        tokenUsageEvents: [{ at: Date.now(), inputTokens: 300_000, outputTokens: 200_001, modelKey: 'claude-sonnet-4-6', product: 'anthropic' }],
      });
      const result = store.resolveFromRequest(claudeReq, {}, opts);
      expect(result.record).toBeNull();
      expect(result.limitExceeded).toBe(true);
      expect(Number(result.resetMs)).toBeGreaterThan(0);
      expect(result.error).toContain('token limit exceeded');
    });

    it('allows a request under the bucketLimits cap', () => {
      const store = makeCard({
        bucketLimits: { 'anthropic-claude': 500_000 },
        tokenUsageEvents: [{ at: Date.now(), inputTokens: 100, outputTokens: 50, modelKey: 'claude-sonnet-4-6', product: 'anthropic' }],
      });
      const result = store.resolveFromRequest(claudeReq, {}, opts);
      expect(result.record).not.toBeNull();
      expect(result.limitExceeded).toBeFalsy();
    });

    it('leaves buckets without a cap unlimited', () => {
      // Only anthropic-claude capped; a heavily-used antigravity-gemini bucket is uncapped → allowed.
      const store = makeCard({
        bucketLimits: { 'anthropic-claude': 500_000 },
        tokenUsageEvents: [{ at: Date.now(), inputTokens: 5_000_000, outputTokens: 5_000_000, modelKey: 'gemini-2.5-pro', product: 'antigravity' }],
      });
      const result = store.resolveFromRequest(claudeReq, {}, { enforceLimit: true, modelKey: 'gemini-2.5-pro', product: 'antigravity' });
      expect(result.record).not.toBeNull();
    });

    it('does not enforce when neither tokenWindowLimit nor bucketLimits is set (unlimited)', () => {
      const store = makeCard({
        tokenUsageEvents: [{ at: Date.now(), inputTokens: 9_000_000, outputTokens: 9_000_000, modelKey: 'claude-sonnet-4-6', product: 'anthropic' }],
      });
      const result = store.resolveFromRequest(claudeReq, {}, opts);
      expect(result.record).not.toBeNull();
      expect(result.limitExceeded).toBeFalsy();
    });

    it('publicStatus reports quotaMode=static + flat family limit from bucketLimits', () => {
      const store = makeCard({ bucketLimits: { 'anthropic-claude': 500_000 } });
      const status = store.publicStatus(store.findById('k1')!);
      expect(status.quotaMode).toBe('static');
      expect(status.opusTokenLimit).toBe(500_000);
    });

    it('publicStatus quotaMode=unlimited when no caps and no binding', () => {
      const store = makeCard({});
      expect(store.publicStatus(store.findById('k1')!).quotaMode).toBe('unlimited');
    });
  });

  // ── Static account binding ───────────────────────────────────────────────

  describe('boundAccountIdFor', () => {
    it('returns the bound account id when the card provider matches the pool', () => {
      const store = makeStore([
        { id: 'k1', key: 'secret1', status: 'active', provider: 'codex', boundAccountId: 7 },
      ]);
      const record = store.findById('k1')!;
      expect(store.boundAccountIdFor(record, 'codex')).toBe(7);
    });

    it('returns 0 when the card is bound to a different pool', () => {
      const store = makeStore([
        { id: 'k1', key: 'secret1', status: 'active', provider: 'codex', boundAccountId: 7 },
      ]);
      const record = store.findById('k1')!;
      expect(store.boundAccountIdFor(record, 'antigravity')).toBe(0);
    });

    it('treats an untagged (no provider) bound card as belonging to any pool', () => {
      const store = makeStore([
        { id: 'k1', key: 'secret1', status: 'active', boundAccountId: 3 },
      ]);
      const record = store.findById('k1')!;
      expect(store.boundAccountIdFor(record, 'codex')).toBe(3);
      expect(store.boundAccountIdFor(record, 'antigravity')).toBe(3);
    });

    it('returns 0 for an unbound card', () => {
      const store = makeStore([{ id: 'k1', key: 'secret1', status: 'active' }]);
      const record = store.findById('k1')!;
      expect(store.boundAccountIdFor(record, 'codex')).toBe(0);
    });

    it('reads a per-provider binding from the bindings map', () => {
      const store = makeStore([
        { id: 'k1', key: 'secret1', status: 'active', bindings: { codex: 12, antigravity: 5 } },
      ]);
      const record = store.findById('k1')!;
      expect(store.boundAccountIdFor(record, 'codex')).toBe(12);
      expect(store.boundAccountIdFor(record, 'antigravity')).toBe(5);
    });

    it('returns 0 for a provider the card is not sold for', () => {
      const store = makeStore([
        { id: 'k1', key: 'secret1', status: 'active', bindings: { codex: 12 } },
      ]);
      const record = store.findById('k1')!;
      expect(store.boundAccountIdFor(record, 'antigravity')).toBe(0);
    });

    it('prefers the bindings map over the legacy single field', () => {
      const store = makeStore([
        { id: 'k1', key: 'secret1', status: 'active', provider: 'codex', boundAccountId: 3, bindings: { codex: 12 } },
      ]);
      const record = store.findById('k1')!;
      expect(store.boundAccountIdFor(record, 'codex')).toBe(12);
    });

    it('returns 0 when boundAccountId is not a positive number', () => {
      const store = makeStore([
        { id: 'k1', key: 'secret1', status: 'active', provider: 'codex', boundAccountId: 0 },
      ]);
      const record = store.findById('k1')!;
      expect(store.boundAccountIdFor(record, 'codex')).toBe(0);
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
    it('surfaces the card products from bindings (empty = pool card)', () => {
      const store = makeStore([
        { id: 'k1', key: 's1', status: 'active', bindings: { codex: 7 } },
        { id: 'k2', key: 's2', status: 'active', bindings: { codex: 7, antigravity: 3 } },
        { id: 'k3', key: 's3', status: 'active' },
      ]);
      expect(store.publicStatus(store.findById('k1')!).products).toEqual(['codex']);
      expect(store.publicStatus(store.findById('k2')!).products.sort()).toEqual(['antigravity', 'codex']);
      expect(store.publicStatus(store.findById('k3')!).products).toEqual([]);
    });

    it('should return correct structure with computed fields', () => {
      const now = Date.now();
      const store = makeStore([{
        id: 'k1', key: 'secret1', status: 'active',
        name: 'Test Key',
        firstUsedAt: new Date(now - 1000).toISOString(),
        durationMs: 3600_000,
        bucketLimits: { 'anthropic-claude': 100_000 },
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
      expect(status.quotaMode).toBe('static');
      expect(status.opusTokenLimit).toBe(100_000);
      expect(status.tokenWindowMs).toBe(5 * 60 * 60 * 1000);
      expect(status.remainingMs).toBeGreaterThan(0);
      expect(status.expiresAt).toBeTruthy();
      expect(status.tokenWindowResetMs).toBeGreaterThan(0);
      expect(status.hasActiveSession).toBe(false);
    });
  });
});
