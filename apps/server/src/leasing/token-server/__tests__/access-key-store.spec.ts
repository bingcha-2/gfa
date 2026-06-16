import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { AccessKeyStore } from '../access-key-store';
import { cardIdSessionResolver, sessionReqFor } from './session-test-util';

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
  const store = new AccessKeyStore(accessKeysPath);
  // The session JWT is the only runtime credential — specs drive
  // resolveFromRequest through the stub resolver (token.cardId → record id).
  store.setSessionResolver(cardIdSessionResolver);
  return store;
}

// ── computeUsageDetail 口径归一 ───────────────────────────────────────────────

describe('AccessKeyStore.computeUsageDetail (normalizeUsageToGross 收口)', () => {
  it('claude: net input 归一为 gross,billable 折扣 cache_read', async () => {
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

  it('gemini: 已 gross,detail 不变', async () => {
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
    it('should load keys from disk', async () => {
      const store = makeStore([{ id: 'k1', key: 'secret1', status: 'active' }]);
      const keys = store.readAll();
      expect(keys.keys).toHaveLength(1);
      expect(keys.keys[0].id).toBe('k1');
    });

    it('should return empty keys for non-existent file', async () => {
      const store = new AccessKeyStore(path.join(tmpDir, 'missing.json'));
      expect(store.readAll().keys).toEqual([]);
    });

    it('should find key by constant-time comparison', async () => {
      const store = makeStore([
        { id: 'k1', key: 'secret1', status: 'active' },
        { id: 'k2', key: 'secret2', status: 'active' },
      ]);
      const record = store.findByKey('secret2');
      expect(record?.id).toBe('k2');
    });

    it('should return null for non-existent key', async () => {
      const store = makeStore([{ id: 'k1', key: 'secret1', status: 'active' }]);
      expect(store.findByKey('wrong')).toBeNull();
    });
  });

  describe('findById', () => {
    it('should find key by id', async () => {
      const store = makeStore([{ id: 'k1', key: 'secret1', status: 'active' }]);
      expect(store.findById('k1')?.key).toBe('secret1');
    });

    it('should return null for non-existent id', async () => {
      const store = makeStore([]);
      expect(store.findById('missing')).toBeNull();
    });
  });

  // ── Credential resolution (the core auth flow) ───────────────────────────

  describe('resolveFromRequest', () => {
    it('resolves an active record from a session JWT (the only runtime credential)', async () => {
      const store = makeStore([{ id: 'k1', key: 'secret1', status: 'active' }]);
      const result = await store.resolveFromRequest(sessionReqFor('k1'), {});
      expect(result.record?.id).toBe('k1');
      expect(result.viaSession).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('ignores the legacy x-access-key header (card credential removed)', async () => {
      const store = makeStore([{ id: 'k1', key: 'secret1', status: 'active' }]);
      const result = await store.resolveFromRequest(
        { headers: { 'x-access-key': 'secret1' } } as any,
        {},
      );
      expect(result.record).toBeNull();
      expect(result.error).toBe('Missing access key');
    });

    it('ignores the legacy x-token-server-secret header and payload key fields', async () => {
      const store = makeStore([{ id: 'k1', key: 'secret1', status: 'active' }]);
      const result = await store.resolveFromRequest(
        { headers: { 'x-token-server-secret': 'secret1' } } as any,
        { accessKey: 'secret1', accountCard: 'secret1', cardKey: 'secret1', key: 'secret1' },
      );
      expect(result.record).toBeNull();
      expect(result.error).toBe('Missing access key');
    });

    it('rejects a card-value Bearer (no longer a credential)', async () => {
      const store = makeStore([{ id: 'k1', key: 'secret1', status: 'active' }]);
      const result = await store.resolveFromRequest(
        { headers: { authorization: 'Bearer secret1' } } as any,
        {},
      );
      expect(result.record).toBeNull();
      expect(result.error).toBe('Invalid access key');
    });

    it('should return error for missing credential', async () => {
      const store = makeStore([]);
      const result = await store.resolveFromRequest({ headers: {} } as any, {});
      expect(result.record).toBeNull();
      expect(result.error).toBe('Missing access key');
    });

    it('should return error for disabled record (session path)', async () => {
      const store = makeStore([{ id: 'k1', key: 'secret1', status: 'disabled' }]);
      const result = await store.resolveFromRequest(sessionReqFor('k1'), {});
      expect(result.record).toBeNull();
      expect(result.error).toBe('Access key disabled');
    });

    it('should mark record as expired if past duration (session path)', async () => {
      const store = makeStore([{
        id: 'k1',
        key: 'secret1',
        status: 'active',
        firstUsedAt: '2020-01-01T00:00:00.000Z',
        durationMs: 1000,
      }]);
      const result = await store.resolveFromRequest(sessionReqFor('k1'), {});
      expect(result.record).toBeNull();
      expect(result.error).toBe('Access key expired');
    });
  });

  // ── Usage recording ──────────────────────────────────────────────────────

  describe('recordUsage', () => {
    it('records a usage event into the rate-limit window', async () => {
      const store = makeStore([{
        id: 'k1', key: 'secret1', status: 'active',
        usageEvents: [], tokenUsageEvents: [],
        windowStartedAt: Date.now(),
      }]);
      store.recordUsage('k1', 200, { inputTokens: 100, outputTokens: 50 }, '');
      const record = store.findById('k1');
      // 累计计数已下线;用量进入限流窗口事件(权威用量在 CardUsageHourly)。
      expect(record?.tokenUsageEvents?.length).toBe(1);
      expect(record?.tokenUsageEvents?.[0].inputTokens).toBe(100);
    });

    it('should not throw for unknown cardId', async () => {
      const store = makeStore([]);
      expect(() => store.recordUsage('unknown', 200, {}, '')).not.toThrow();
    });
  });

  // ── Flush to disk ──────────────────────────────────────────────────────

  describe('flush', () => {
    it('recordUsage does NOT persist to disk — usage lives in DB (CardTokenUsage), file untouched', async () => {
      const store = makeStore([{
        id: 'k1', key: 'secret1', status: 'active',
        totalRequests: 0, usageEvents: [], tokenUsageEvents: [],
        windowStartedAt: Date.now(),
      }]);
      store.recordUsage('k1', 200, { inputTokens: 100, outputTokens: 50 }, '');
      store.flush();

      // 上报路径不再标脏 → flush 不写盘:磁盘计数维持初始 0。
      const raw = JSON.parse(fs.readFileSync(accessKeysPath, 'utf8'));
      expect(raw.keys[0].totalRequests).toBe(0);
      // 内存:用量进入限流窗口事件(累计计数已下线;权威用量在 CardUsageHourly)。
      expect(store.findById('k1')!.tokenUsageEvents!.length).toBe(1);
    });

    it('recordUsage keeps event arrays + counters in memory only — nothing reaches disk', async () => {
      const store = makeStore([{
        id: 'k1', key: 'secret1', status: 'active',
        totalRequests: 0, windowStartedAt: Date.now(), weeklyWindowStartedAt: Date.now(),
      }]);
      store.recordUsage('k1', 200, { inputTokens: 100, outputTokens: 50, rawTotalTokens: 150 }, 'claude-opus-4', '', 'anthropic');
      store.flush();

      // 磁盘:上报不落盘 —— 计数维持 0,事件数组也从不写出(serializable() 仍会剥离,
      // 这里因根本没写盘而天然不存在)。
      const raw = JSON.parse(fs.readFileSync(accessKeysPath, 'utf8'));
      expect(raw.keys[0].totalRequests).toBe(0);
      expect(raw.keys[0].usageEvents).toBeUndefined();
      expect(raw.keys[0].tokenUsageEvents).toBeUndefined();
      expect(raw.keys[0].weeklyTokenUsageEvents).toBeUndefined();

      // 内存:窗口事件在 —— 限额窗口的权威来源(累计计数已下线)。
      const inMem = store.findById('k1')!;
      expect((inMem.tokenUsageEvents || []).length).toBeGreaterThan(0);
    });

    it('round-trips requiresBinding through flush → disk → reload (M13b plan-record flag)', async () => {
      const store = makeStore([{
        id: 'sub-1', key: 'sub_backing', status: 'active', requiresBinding: true,
        totalRequests: 0, windowStartedAt: Date.now(),
      }]);
      // Dirty the cache so flush() rewrites the file via serializable().
      store.recordUsage('sub-1', 200, { inputTokens: 10, outputTokens: 5 }, '');
      store.flush();

      // serializable() must NOT strip the flag (it only omits event arrays).
      const raw = JSON.parse(fs.readFileSync(accessKeysPath, 'utf8'));
      expect(raw.keys[0].requiresBinding).toBe(true);

      // ...and a reload (admin edit path) keeps it in memory too.
      store.reload();
      expect(store.findById('sub-1')!.requiresBinding).toBe(true);
    });
  });

  describe('reload', () => {
    it('preserves the in-memory rate-limit window across reload (disk no longer stores events)', async () => {
      const store = makeStore([{
        id: 'k1', key: 'secret1', status: 'active',
        windowStartedAt: Date.now(), weeklyWindowStartedAt: Date.now(),
      }]);
      store.recordUsage('k1', 200, { inputTokens: 100, outputTokens: 50, rawTotalTokens: 150 }, 'claude-opus-4', '', 'anthropic');
      store.flush(); // disk now holds NO events

      const before = store.publicStatus(store.findById('k1')!).recentWindowTokens;
      expect(before).toBeGreaterThan(0);

      // reload happens on every admin card edit; it must not reset usage windows.
      store.reload();

      const after = store.publicStatus(store.findById('k1')!).recentWindowTokens;
      expect(after).toBe(before);
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

    it('should reject when Claude (anthropic) tokens exceed limit', async () => {
      const store = makeKeyWithUsage([
        { at: Date.now(), inputTokens: 300_000, outputTokens: 200_001, modelKey: 'claude-sonnet-4-6', product: 'anthropic' },
      ]);
      const result = await store.resolveFromRequest(
        sessionReqFor('k1'),
        {},
        { enforceLimit: true, modelKey: 'claude-sonnet-4-6', product: 'anthropic' },
      );
      expect(result.record).toBeNull();
      // Composite bucket anthropic-claude → label "Anthropic · Claude".
      expect(result.error).toContain('Claude token limit exceeded');
    });

    it('reports the over-limit window per the card windowMs, not a hardcoded 5h', async () => {
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
      const result = await store.resolveFromRequest(
        sessionReqFor('k1'),
        {},
        { enforceLimit: true, modelKey: 'claude-sonnet-4-6', product: 'anthropic' },
      );
      expect(result.record).toBeNull();
      expect(result.error).toContain('tokens/1d');
      expect(result.error).not.toContain('tokens/5h');
    });

    it('should reject when Gemini tokens exceed limit (5x multiplier)', async () => {
      // Gemini limit = tokenWindowLimit * 5 = 2,500,000
      const store = makeKeyWithUsage([
        { at: Date.now(), inputTokens: 1_500_000, outputTokens: 1_000_001, modelKey: 'gemini-2.5-pro', product: 'antigravity' },
      ]);
      const result = await store.resolveFromRequest(
        sessionReqFor('k1'),
        {},
        { enforceLimit: true, modelKey: 'gemini-2.5-pro', product: 'antigravity' },
      );
      expect(result.record).toBeNull();
      expect(result.error).toContain('Gemini token limit exceeded');
    });

    it('should allow request when tokens are under limit', async () => {
      const store = makeKeyWithUsage([
        { at: Date.now(), inputTokens: 100, outputTokens: 50, modelKey: 'claude-sonnet-4-6' },
      ]);
      const result = await store.resolveFromRequest(
        sessionReqFor('k1'),
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

    it('warm-lease (no modelKey) is NOT blocked even though anthropic-claude is exhausted', async () => {
      // 核心回归:antigravity-gemini 是 0/10000 满额,预热绝不能被 anthropic 的耗尽连累。
      const store = makeFourBucketCard();
      const result = await store.resolveFromRequest(
        sessionReqFor('k1'),
        {},
        { enforceLimit: true }, // 无 modelKey(预热)
      );
      expect(result.record).not.toBeNull();
      expect(result.record?.id).toBe('k1');
    });

    it('claude request (with modelKey) is still precisely rejected — only the exhausted bucket', async () => {
      const store = makeFourBucketCard();
      const result = await store.resolveFromRequest(
        sessionReqFor('k1'),
        {},
        { enforceLimit: true, modelKey: 'claude-opus-4-8', product: 'anthropic' },
      );
      expect(result.record).toBeNull();
      expect(result.error).toContain('Claude token limit exceeded');
    });

    it('antigravity gemini (with modelKey) is allowed — its own bucket has headroom (0/10000)', async () => {
      const store = makeFourBucketCard();
      const result = await store.resolveFromRequest(
        sessionReqFor('k1'),
        {},
        { enforceLimit: true, modelKey: 'gemini-2.5-pro', product: 'antigravity' },
      );
      expect(result.record).not.toBeNull();
    });

    it('no-modelKey is not blocked even when EVERY bucket is exhausted (preheat consumes nothing)', async () => {
      // 即便所有桶都爆,无 modelKey 的预热仍放行 —— 它不消费;真实请求各自带 modelKey 被精确拦。
      const store = makeKeyWithUsage([
        { at: Date.now(), inputTokens: 300_000, outputTokens: 200_001, modelKey: 'claude-opus' },
        { at: Date.now(), inputTokens: 1_500_000, outputTokens: 1_000_001, modelKey: 'gemini-2.5-pro' },
        { at: Date.now(), inputTokens: 300_000, outputTokens: 200_001, modelKey: 'gpt-5-codex' },
      ]);
      const result = await store.resolveFromRequest(
        sessionReqFor('k1'),
        {},
        { enforceLimit: true },
      );
      expect(result.record).not.toBeNull();
    });

    it('should allow when only one category exceeds limit (no modelKey)', async () => {
      const store = makeKeyWithUsage([
        { at: Date.now(), inputTokens: 300_000, outputTokens: 200_001, modelKey: 'claude-opus' },
        // Gemini is under limit
        { at: Date.now(), inputTokens: 100, outputTokens: 50, modelKey: 'gemini-2.5-pro' },
      ]);
      const result = await store.resolveFromRequest(
        sessionReqFor('k1'),
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
    const claudeReq = sessionReqFor('k1');
    const opts = { enforceLimit: true, modelKey: 'claude-sonnet-4-6', product: 'anthropic' };

    it('enforces a bucketLimits cap even without a global tokenWindowLimit', async () => {
      const store = makeCard({
        bucketLimits: { 'anthropic-claude': 500_000 },
        tokenUsageEvents: [{ at: Date.now(), inputTokens: 300_000, outputTokens: 200_001, modelKey: 'claude-sonnet-4-6', product: 'anthropic' }],
      });
      const result = await store.resolveFromRequest(claudeReq, {}, opts);
      expect(result.record).toBeNull();
      expect(result.limitExceeded).toBe(true);
      expect(Number(result.resetMs)).toBeGreaterThan(0);
      expect(result.error).toContain('token limit exceeded');
    });

    it('allows a request under the bucketLimits cap', async () => {
      const store = makeCard({
        bucketLimits: { 'anthropic-claude': 500_000 },
        tokenUsageEvents: [{ at: Date.now(), inputTokens: 100, outputTokens: 50, modelKey: 'claude-sonnet-4-6', product: 'anthropic' }],
      });
      const result = await store.resolveFromRequest(claudeReq, {}, opts);
      expect(result.record).not.toBeNull();
      expect(result.limitExceeded).toBeFalsy();
    });

    it('leaves buckets without a cap unlimited', async () => {
      // Only anthropic-claude capped; a heavily-used antigravity-gemini bucket is uncapped → allowed.
      const store = makeCard({
        bucketLimits: { 'anthropic-claude': 500_000 },
        tokenUsageEvents: [{ at: Date.now(), inputTokens: 5_000_000, outputTokens: 5_000_000, modelKey: 'gemini-2.5-pro', product: 'antigravity' }],
      });
      const result = await store.resolveFromRequest(claudeReq, {}, { enforceLimit: true, modelKey: 'gemini-2.5-pro', product: 'antigravity' });
      expect(result.record).not.toBeNull();
    });

    it('does not enforce when neither tokenWindowLimit nor bucketLimits is set (unlimited)', async () => {
      const store = makeCard({
        tokenUsageEvents: [{ at: Date.now(), inputTokens: 9_000_000, outputTokens: 9_000_000, modelKey: 'claude-sonnet-4-6', product: 'anthropic' }],
      });
      const result = await store.resolveFromRequest(claudeReq, {}, opts);
      expect(result.record).not.toBeNull();
      expect(result.limitExceeded).toBeFalsy();
    });

    it('publicStatus reports quotaMode=static + flat family limit from bucketLimits', async () => {
      const store = makeCard({ bucketLimits: { 'anthropic-claude': 500_000 } });
      const status = store.publicStatus(store.findById('k1')!);
      expect(status.quotaMode).toBe('static');
      expect(status.opusTokenLimit).toBe(500_000);
    });

    it('publicStatus quotaMode=unlimited when no caps and no binding', async () => {
      const store = makeCard({});
      expect(store.publicStatus(store.findById('k1')!).quotaMode).toBe('unlimited');
    });
  });

  // ── Static account binding ───────────────────────────────────────────────

  describe('boundAccountIdFor', () => {
    it('returns the bound account id when the card provider matches the pool', async () => {
      const store = makeStore([
        { id: 'k1', key: 'secret1', status: 'active', provider: 'codex', boundAccountId: 7 },
      ]);
      const record = store.findById('k1')!;
      expect(store.boundAccountIdFor(record, 'codex')).toBe(7);
    });

    it('returns 0 when the card is bound to a different pool', async () => {
      const store = makeStore([
        { id: 'k1', key: 'secret1', status: 'active', provider: 'codex', boundAccountId: 7 },
      ]);
      const record = store.findById('k1')!;
      expect(store.boundAccountIdFor(record, 'antigravity')).toBe(0);
    });

    it('treats an untagged (no provider) bound card as belonging to any pool', async () => {
      const store = makeStore([
        { id: 'k1', key: 'secret1', status: 'active', boundAccountId: 3 },
      ]);
      const record = store.findById('k1')!;
      expect(store.boundAccountIdFor(record, 'codex')).toBe(3);
      expect(store.boundAccountIdFor(record, 'antigravity')).toBe(3);
    });

    it('returns 0 for an unbound card', async () => {
      const store = makeStore([{ id: 'k1', key: 'secret1', status: 'active' }]);
      const record = store.findById('k1')!;
      expect(store.boundAccountIdFor(record, 'codex')).toBe(0);
    });

    it('reads a per-provider binding from the bindings map', async () => {
      const store = makeStore([
        { id: 'k1', key: 'secret1', status: 'active', bindings: { codex: 12, antigravity: 5 } },
      ]);
      const record = store.findById('k1')!;
      expect(store.boundAccountIdFor(record, 'codex')).toBe(12);
      expect(store.boundAccountIdFor(record, 'antigravity')).toBe(5);
    });

    it('returns 0 for a provider the card is not sold for', async () => {
      const store = makeStore([
        { id: 'k1', key: 'secret1', status: 'active', bindings: { codex: 12 } },
      ]);
      const record = store.findById('k1')!;
      expect(store.boundAccountIdFor(record, 'antigravity')).toBe(0);
    });

    it('prefers the bindings map over the legacy single field', async () => {
      const store = makeStore([
        { id: 'k1', key: 'secret1', status: 'active', provider: 'codex', boundAccountId: 3, bindings: { codex: 12 } },
      ]);
      const record = store.findById('k1')!;
      expect(store.boundAccountIdFor(record, 'codex')).toBe(12);
    });

    it('returns 0 when boundAccountId is not a positive number', async () => {
      const store = makeStore([
        { id: 'k1', key: 'secret1', status: 'active', provider: 'codex', boundAccountId: 0 },
      ]);
      const record = store.findById('k1')!;
      expect(store.boundAccountIdFor(record, 'codex')).toBe(0);
    });
  });

  // ── Activation arming (firstUsedAt) on the session path ──────────────────

  describe('resolveFromRequest — activate', () => {
    it('should set firstUsedAt on activate', async () => {
      const store = makeStore([{ id: 'k1', key: 'secret1', status: 'active' }]);
      const result = await store.resolveFromRequest(
        sessionReqFor('k1'),
        {},
        { activate: true },
      );
      expect(result.record?.firstUsedAt).toBeTruthy();
    });

    it('should not overwrite existing firstUsedAt on activate', async () => {
      const originalDate = '2025-01-01T00:00:00.000Z';
      const store = makeStore([{
        id: 'k1', key: 'secret1', status: 'active',
        firstUsedAt: originalDate, durationMs: 10 * 365 * 24 * 3600 * 1000,
      }]);
      const result = await store.resolveFromRequest(
        sessionReqFor('k1'),
        {},
        { activate: true },
      );
      expect(result.record?.firstUsedAt).toBe(originalDate);
    });
  });

  // ── publicStatus ──────────────────────────────────────────────────────

  describe("订阅 record 的 customerId 透传(账户化地基)", () => {
    it("loadSubscriptionRecords 注册带 customerId 的 record → findById 可取回", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-aks-cust-"));
      const store = new AccessKeyStore(path.join(tmp, "access-keys.json"));
      store.loadSubscriptionRecords([
        { id: "sub-9", customerId: "cust-9", status: "active", products: ["codex"] },
      ]);
      expect(store.findById("sub-9")?.customerId).toBe("cust-9");
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("loadSubscriptionRecords 注册带 priority 的 record → findById 可取回", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-aks-prio-"));
      const store = new AccessKeyStore(path.join(tmp, "access-keys.json"));
      store.loadSubscriptionRecords([
        { id: "sub-p", customerId: "cust-1", priority: 7, status: "active", products: ["codex"] },
      ]);
      expect(store.findById("sub-p")?.priority).toBe(7);
      fs.rmSync(tmp, { recursive: true, force: true });
    });
  });

  describe('publicStatus', () => {
    it('surfaces the card products from bindings (empty = pool card)', async () => {
      const store = makeStore([
        { id: 'k1', key: 's1', status: 'active', bindings: { codex: 7 } },
        { id: 'k2', key: 's2', status: 'active', bindings: { codex: 7, antigravity: 3 } },
        { id: 'k3', key: 's3', status: 'active' },
      ]);
      expect(store.publicStatus(store.findById('k1')!).products).toEqual(['codex']);
      expect(store.publicStatus(store.findById('k2')!).products.sort()).toEqual(['antigravity', 'codex']);
      expect(store.publicStatus(store.findById('k3')!).products).toEqual([]);
    });

    it('should return correct structure with computed fields', async () => {
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
      // 累计计数已从 publicStatus 下线(权威用量在 CardUsageHourly)。
      expect(status.totalRequests).toBeUndefined();
      expect(status.totalTokensUsed).toBeUndefined();
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

describe("precheckRecord — 只读三道闸预检", () => {
  it("bucket 已超额 → allowed=false + resetMs;且不写缓存(record.status 不变)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-aks-pre-"));
    const store = new AccessKeyStore(path.join(tmp, "access-keys.json"));
    const now = Date.now();
    store.loadSubscriptionRecords([{
      id: "s1", customerId: "c1", status: "active", products: ["codex"],
      bucketLimits: { "codex-gpt": 100 }, windowMs: 18_000_000,
      windowStartedAt: now,
      tokenUsageEvents: [{ at: now, status: 200, modelKey: "gpt-5-codex", product: "codex", totalTokens: 100 }],
    }]);
    const rec = store.findById("s1")!;
    const res = store.precheckRecord(rec, { modelKey: "gpt-5-codex", product: "codex", enforceLimit: true });
    expect(res.allowed).toBe(false);
    expect(res.resetMs).toBeGreaterThan(0);
    expect(rec.status).toBe("active"); // 预检未把它改成 expired/写缓存
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("额度充足 → allowed=true", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-aks-pre2-"));
    const store = new AccessKeyStore(path.join(tmp, "access-keys.json"));
    store.loadSubscriptionRecords([{
      id: "s2", customerId: "c1", status: "active", products: ["codex"],
      bucketLimits: { "codex-gpt": 100000 }, windowMs: 18_000_000,
    }]);
    const res = store.precheckRecord(store.findById("s2")!, { modelKey: "gpt-5-codex", product: "codex", enforceLimit: true });
    expect(res.allowed).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("listByCustomerSorted — 账户订阅按 priority 升序", () => {
  it("只返回该 customer 的 ACTIVE 订阅,按 priority 升序", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-aks-list-"));
    const store = new AccessKeyStore(path.join(tmp, "access-keys.json"));
    store.loadSubscriptionRecords([
      { id: "s-b", customerId: "c1", priority: 5, status: "active", products: ["codex"] },
      { id: "s-a", customerId: "c1", priority: 1, status: "active", products: ["codex"] },
      { id: "s-exp", customerId: "c1", priority: 0, status: "expired", products: ["codex"] },
      { id: "s-other", customerId: "c2", priority: 0, status: "active", products: ["codex"] },
    ]);
    const ids = store.listByCustomerSorted("c1").map((r) => r.id);
    expect(ids).toEqual(["s-a", "s-b"]); // 升序、排除 expired、排除 c2
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("setSubscriptionPriority — 写后即时刷新内存接力顺序", () => {
  it("更新已驻留 record 的 priority,listByCustomerSorted 立即反映新顺序", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-aks-prio-"));
    const store = new AccessKeyStore(path.join(tmp, "access-keys.json"));
    store.loadSubscriptionRecords([
      { id: "s-a", customerId: "c1", priority: 1, status: "active", products: ["codex"] },
      { id: "s-b", customerId: "c1", priority: 5, status: "active", products: ["codex"] },
    ]);
    expect(store.listByCustomerSorted("c1").map((r) => r.id)).toEqual(["s-a", "s-b"]);

    // 把 s-b 提到最前(priority 0)→ 接力顺序立即翻转,无需重启/resync。
    expect(store.setSubscriptionPriority("s-b", 0)).toBe(true);
    expect(store.listByCustomerSorted("c1").map((r) => r.id)).toEqual(["s-b", "s-a"]);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("订阅未驻留内存时返回 false,绝不往 Map 里塞半截 stub", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-aks-prio-miss-"));
    const store = new AccessKeyStore(path.join(tmp, "access-keys.json"));
    expect(store.setSubscriptionPriority("not-loaded", 0)).toBe(false);
    // 没命中 → 该 customer 名下依旧空,没被污染出一个无 key/无限额的残record。
    expect(store.listByCustomerSorted("c1")).toEqual([]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("findByKey 支持订阅卡(去文件化)", () => {
  it("订阅 record 带 backingKeyValue → findByKey(backingKeyValue) 查得到", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-aks-fbk-"));
    const store = new AccessKeyStore(path.join(tmp, "access-keys.json"));
    store.loadSubscriptionRecords([
      { id: "sub-x", key: "BCAI-SUB-XYZ", customerId: "c1", status: "active", products: ["codex"] },
    ]);
    expect(store.findByKey("BCAI-SUB-XYZ")?.id).toBe("sub-x");
    expect(store.findByKey("不存在")).toBeNull();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
