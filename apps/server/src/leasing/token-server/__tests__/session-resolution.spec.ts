/**
 * session-resolution.spec.ts — AccessKeyStore session-JWT resolution.
 *
 * The lease hot path accepts ONLY a customer session JWT (typ "user-session")
 * in the Authorization header — the card-string runtime credential was removed
 * (force-upgrade). The store routes such bearers to an injected SessionResolver
 * which maps token → ACTIVE Subscription id, then validates the shadow record
 * through the shared validateRecord pipeline. Card strings presented as
 * credentials are rejected outright (card VALUES still resolve via findByKey
 * for bind-card redemption).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { AccessKeyStore } from '../access-key-store';

let tmpDir: string;
let accessKeysPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-resolution-test-'));
  accessKeysPath = path.join(tmpDir, 'access-keys.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeStore(keys: any[] = []) {
  fs.writeFileSync(accessKeysPath, JSON.stringify({ keys, updatedAt: '' }));
  return new AccessKeyStore(accessKeysPath);
}

/** Build an unsigned JWT-shaped token whose payload claims typ user-session. */
function fakeSessionJwt(payload: Record<string, unknown> = {}): string {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ typ: 'user-session', sub: 'cust-1', ...payload })}.signature`;
}

const sessionReq = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as any;

describe('AccessKeyStore — session-JWT routing', () => {
  it('routes a user-session-looking bearer to the resolver and resolves the shadow record by id', async () => {
    const store = makeStore([{ id: 'sub-1', key: 'sub_backing', status: 'active' }]);
    const resolve = vi.fn().mockResolvedValue({ ok: true, cardId: 'sub-1' });
    store.setSessionResolver({ resolve });

    const result = await store.resolveFromRequest(sessionReq(fakeSessionJwt()), {}, { product: 'antigravity' });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(expect.stringContaining('.'), { product: 'antigravity' });
    expect(result.record?.id).toBe('sub-1');
    expect(result.viaSession).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('an opaque card-key bearer is rejected WITHOUT hitting the resolver (card credential removed)', async () => {
    const store = makeStore([{ id: 'k1', key: 'BCAI-AAAA-BBBB', status: 'active' }]);
    const resolve = vi.fn();
    store.setSessionResolver({ resolve });

    const result = await store.resolveFromRequest(sessionReq('BCAI-AAAA-BBBB'), {});

    expect(resolve).not.toHaveBeenCalled();
    expect(result.record).toBeNull();
    expect(result.error).toBe('Invalid access key');
  });

  it('does NOT route a non-user-session JWT (admin token) to the resolver', async () => {
    const store = makeStore([{ id: 'k1', key: 'secret1', status: 'active' }]);
    const resolve = vi.fn();
    store.setSessionResolver({ resolve });
    const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const adminJwt = `${enc({ alg: 'HS256' })}.${enc({ sub: 'admin-1' })}.sig`;

    const result = await store.resolveFromRequest(sessionReq(adminJwt), {});

    expect(resolve).not.toHaveBeenCalled();
    // Not a user-session token → rejected as an invalid credential.
    expect(result.error).toBe('Invalid access key');
  });

  it('x-access-key requests are ignored entirely (no resolver, no record)', async () => {
    const store = makeStore([{ id: 'k1', key: 'secret1', status: 'active' }]);
    const resolve = vi.fn();
    store.setSessionResolver({ resolve });

    const result = await store.resolveFromRequest({ headers: { 'x-access-key': 'secret1' } } as any, {});

    expect(resolve).not.toHaveBeenCalled();
    expect(result.record).toBeNull();
    expect(result.error).toBe('Missing access key');
  });

  it('returns a clean error when the resolver is unset', async () => {
    const store = makeStore([{ id: 'sub-1', key: 'sub_backing', status: 'active' }]);

    const result = await store.resolveFromRequest(sessionReq(fakeSessionJwt()), {});

    expect(result.record).toBeNull();
    expect(result.error).toMatch(/session resolver unavailable/i);
  });

  it('propagates resolver failure as sessionError {statusCode, code}', async () => {
    const store = makeStore([{ id: 'sub-1', key: 'sub_backing', status: 'active' }]);
    store.setSessionResolver({
      resolve: vi.fn().mockResolvedValue({
        ok: false, statusCode: 403, error: 'DEVICE_REVOKED', message: '设备登录已失效，请重新登录',
      }),
    });

    const result = await store.resolveFromRequest(sessionReq(fakeSessionJwt()), {});

    expect(result.record).toBeNull();
    expect(result.viaSession).toBe(true);
    expect(result.error).toBe('设备登录已失效，请重新登录');
    expect(result.sessionError).toEqual({ statusCode: 403, code: 'DEVICE_REVOKED' });
  });

  it('treats a resolver hit with a missing shadow record as SUBSCRIPTION_EXPIRED (sync gap)', async () => {
    const store = makeStore([]);
    store.setSessionResolver({ resolve: vi.fn().mockResolvedValue({ ok: true, cardId: 'ghost-sub' }) });

    const result = await store.resolveFromRequest(sessionReq(fakeSessionJwt()), {});

    expect(result.record).toBeNull();
    expect(result.sessionError).toEqual({ statusCode: 403, code: 'SUBSCRIPTION_EXPIRED' });
  });

  it('validates a session-resolved record through the SAME pipeline: bucket cap → 429 with resetMs', async () => {
    const now = Date.now();
    const store = makeStore([{
      id: 'sub-1', key: 'sub_backing', status: 'active',
      bucketLimits: { 'antigravity-gemini': 1000 },
      windowStartedAt: now,
      tokenUsageEvents: [
        { at: now, inputTokens: 900, outputTokens: 200, modelKey: 'gemini-2.5-pro', product: 'antigravity' },
      ],
    }]);
    store.setSessionResolver({ resolve: vi.fn().mockResolvedValue({ ok: true, cardId: 'sub-1' }) });

    const result = await store.resolveFromRequest(
      sessionReq(fakeSessionJwt()),
      {},
      { enforceLimit: true, modelKey: 'gemini-2.5-pro', product: 'antigravity' },
    );

    expect(result.record).toBeNull();
    expect(result.limitExceeded).toBe(true);
    expect(result.resetMs).toBeGreaterThan(0);
    expect(result.viaSession).toBe(true);
    // Quota exhaustion keeps its 429 contract — NOT mapped to SUBSCRIPTION_EXPIRED.
    expect(result.sessionError).toBeUndefined();
  });

  it('an EXPIRED shadow record on the session path carries the SUBSCRIPTION_EXPIRED machine code (403)', async () => {
    const store = makeStore([{
      id: 'sub-1', key: 'sub_backing', status: 'active',
      keyExpiresAt: new Date(Date.now() - 1000).toISOString(),
    }]);
    store.setSessionResolver({ resolve: vi.fn().mockResolvedValue({ ok: true, cardId: 'sub-1' }) });

    const result = await store.resolveFromRequest(sessionReq(fakeSessionJwt()), {});

    expect(result.record).toBeNull();
    expect(result.error).toBe('Access key expired');
    expect(result.viaSession).toBe(true);
    expect(result.sessionError).toEqual({ statusCode: 403, code: 'SUBSCRIPTION_EXPIRED' });
  });

  it('a DISABLED shadow record on the session path carries the SUBSCRIPTION_EXPIRED machine code too', async () => {
    const store = makeStore([{ id: 'sub-1', key: 'sub_backing', status: 'expired' }]);
    store.setSessionResolver({ resolve: vi.fn().mockResolvedValue({ ok: true, cardId: 'sub-1' }) });

    const result = await store.resolveFromRequest(sessionReq(fakeSessionJwt()), {});

    expect(result.record).toBeNull();
    expect(result.error).toBe('Access key disabled');
    expect(result.sessionError).toEqual({ statusCode: 403, code: 'SUBSCRIPTION_EXPIRED' });
  });

});

describe('first-use expiry resync hook (onShadowRecordFirstUse)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it('arming firstUsedAt on a no-absolute-expiry record fires the hook ONCE with the effective expiry', async () => {
    // Migrated never-used card: no keyExpiresAt, no firstUsedAt, relative durationMs.
    const store = makeStore([{ id: 'sub-1', key: 'sub_backing', status: 'active', durationMs: 7 * DAY_MS }]);
    const onShadowRecordFirstUse = vi.fn();
    store.setSessionResolver({
      resolve: vi.fn().mockResolvedValue({ ok: true, cardId: 'sub-1' }),
      onShadowRecordFirstUse,
    });

    const first = await store.resolveFromRequest(sessionReq(fakeSessionJwt()), {}, { activate: true });

    expect(first.record?.id).toBe('sub-1');
    expect(onShadowRecordFirstUse).toHaveBeenCalledTimes(1);
    const [cardId, iso] = onShadowRecordFirstUse.mock.calls[0];
    expect(cardId).toBe('sub-1');
    // Effective expiry == the keyExpiresAt the engine uses (firstUsedAt + durationMs).
    expect(iso).toBe(new Date(Date.parse(first.record!.firstUsedAt!) + 7 * DAY_MS).toISOString());

    // Second lease: firstUsedAt already armed → hook NOT fired again.
    await store.resolveFromRequest(sessionReq(fakeSessionJwt()), {}, { activate: true });
    expect(onShadowRecordFirstUse).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire for records that already carry an absolute keyExpiresAt (plan-backed shadow)', async () => {
    const store = makeStore([{
      id: 'sub-1', key: 'sub_backing', status: 'active',
      keyExpiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    }]);
    const onShadowRecordFirstUse = vi.fn();
    store.setSessionResolver({
      resolve: vi.fn().mockResolvedValue({ ok: true, cardId: 'sub-1' }),
      onShadowRecordFirstUse,
    });

    await store.resolveFromRequest(sessionReq(fakeSessionJwt()), {}, { activate: true });

    expect(onShadowRecordFirstUse).not.toHaveBeenCalled();
  });

  it('does NOT fire on non-activating resolves (report path leaves the record unarmed)', async () => {
    const store = makeStore([{ id: 'sub-1', key: 'sub_backing', status: 'active', durationMs: 7 * DAY_MS }]);
    const onShadowRecordFirstUse = vi.fn();
    store.setSessionResolver({
      resolve: vi.fn().mockResolvedValue({ ok: true, cardId: 'sub-1' }),
      onShadowRecordFirstUse,
    });

    const result = await store.resolveFromRequest(sessionReq(fakeSessionJwt()), {});

    expect(result.record?.id).toBe('sub-1');
    expect(onShadowRecordFirstUse).not.toHaveBeenCalled();
  });

  it('does NOT fire when the record has no durationMs (no effective expiry to sync)', async () => {
    const store = makeStore([{ id: 'sub-1', key: 'sub_backing', status: 'active' }]);
    const onShadowRecordFirstUse = vi.fn();
    store.setSessionResolver({
      resolve: vi.fn().mockResolvedValue({ ok: true, cardId: 'sub-1' }),
      onShadowRecordFirstUse,
    });

    await store.resolveFromRequest(sessionReq(fakeSessionJwt()), {}, { activate: true });

    expect(onShadowRecordFirstUse).not.toHaveBeenCalled();
  });

  it('a resolver without the optional hook still resolves fine (backward compatible)', async () => {
    const store = makeStore([{ id: 'sub-1', key: 'sub_backing', status: 'active', durationMs: 7 * DAY_MS }]);
    store.setSessionResolver({ resolve: vi.fn().mockResolvedValue({ ok: true, cardId: 'sub-1' }) });

    const result = await store.resolveFromRequest(sessionReq(fakeSessionJwt()), {}, { activate: true });

    expect(result.record?.id).toBe('sub-1');
    expect(result.record?.firstUsedAt).toBeTruthy();
  });
});

describe('keyExpiresAt — absolute expiry for shadow records', () => {
  it('a record with an absolute keyExpiresAt in the future resolves normally', async () => {
    const store = makeStore([{
      id: 'sub-1', key: 'sub_backing', status: 'active',
      keyExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }]);
    store.setSessionResolver({ resolve: vi.fn().mockResolvedValue({ ok: true, cardId: 'sub-1' }) });

    const result = await store.resolveFromRequest(sessionReq(fakeSessionJwt()), {});
    expect(result.record?.id).toBe('sub-1');
  });

  it('publicStatus surfaces the absolute expiry', () => {
    const expires = new Date(Date.now() + 60_000).toISOString();
    const store = makeStore([{ id: 'sub-1', key: 'sub_backing', status: 'active', keyExpiresAt: expires }]);
    const status = store.publicStatus(store.findById('sub-1')!);
    expect(status.expiresAt).toBe(expires);
    expect(status.remainingMs).toBeGreaterThan(0);
  });

  it('relative expiry semantics (firstUsedAt + durationMs) hold on the session path', async () => {
    const store = makeStore([{
      id: 'k1', key: 'secret1', status: 'active',
      firstUsedAt: '2020-01-01T00:00:00.000Z', durationMs: 1000,
    }]);
    store.setSessionResolver({ resolve: vi.fn().mockResolvedValue({ ok: true, cardId: 'k1' }) });
    const result = await store.resolveFromRequest(sessionReq(fakeSessionJwt()), {});
    expect(result.record).toBeNull();
    expect(result.error).toBe('Access key expired');
  });
});
