/**
 * session-lease.spec.ts — LeaseService behavior for customer-session leases.
 *
 * Session leases (Authorization: Bearer <user-session JWT>) skip the per-card
 * single-session machinery: multi-device is governed by Device rows +
 * Subscription.deviceLimit, so two clients may lease the same shadow record
 * concurrently. Session auth failures surface machine codes (SESSION_INVALID /
 * DEVICE_REVOKED / SUBSCRIPTION_EXPIRED) in the error body for the client's
 * fatal-error matching.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LeaseService } from "../lease-service";
import { AccessKeyStore } from "../../token-server/access-key-store";
import type { Provider } from "../provider";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeFakeProvider(
  accountsFilePath: string,
  refreshToken: (account: any) => Promise<string>,
  id = "fake",
): Provider<any> {
  return {
    id,
    accountsFilePath,
    refreshToken,
    normalizeAccount: (raw: any) => ({
      ...raw,
      id: Number(raw.id),
      email: String(raw.email || ""),
      refreshToken: String(raw.refreshToken || ""),
      enabled: raw.enabled !== false,
    }),
    isAccountEligible: () => true,
    applyQuotaSnapshot: (account: any) => ({ account, creditDelta: null }),
    egressPolicy: "optional" as const,
    leaseResponseExtras: () => ({}),
  };
}

function fakeSessionJwt(sub = "cust-1"): string {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ typ: "user-session", sub })}.sig`;
}

describe("LeaseService — session-JWT leases", () => {
  let tempDir: string;
  let accountsFilePath: string;
  let accessKeysFilePath: string;
  const refreshToken = vi.fn();
  let leaseSeq = 0;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-session-lease-"));
    accountsFilePath = path.join(tempDir, "accounts.json");
    accessKeysFilePath = path.join(tempDir, "access-keys.json");
    refreshToken.mockReset();
    refreshToken.mockResolvedValue("tok");
    leaseSeq = 0;

    writeJson(accountsFilePath, {
      accounts: [
        { id: 1, email: "one@example.com", refreshToken: "rt-1", enabled: true },
        { id: 2, email: "two@example.com", refreshToken: "rt-2", enabled: true },
      ],
    });
    writeJson(accessKeysFilePath, {
      keys: [{ id: "sub-1", key: "sub_backing_value", status: "active" }],
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeService(resolver: any) {
    const store = new AccessKeyStore(accessKeysFilePath);
    if (resolver) store.setSessionResolver(resolver);
    const service = new LeaseService(makeFakeProvider(accountsFilePath, refreshToken), {
      accessKeyStore: store,
      now: () => Date.now(),
      randomId: () => `lease-${++leaseSeq}`,
      minClientVersion: "",
    });
    return { service, store };
  }

  const SESSION_REQ = { headers: { authorization: `Bearer ${fakeSessionJwt()}` } };

  it("session lease skips validateSession — two clientIds lease the same shadow record without 409", async () => {
    const { service, store } = makeService({
      resolve: vi.fn().mockResolvedValue({ ok: true, cardId: "sub-1" }),
    });

    const first = await service.leaseToken(SESSION_REQ, { clientId: "client-A", modelKey: "gpt-5-codex" });
    const second = await service.leaseToken(SESSION_REQ, { clientId: "client-B", modelKey: "gpt-5-codex" });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // No per-card session was minted — the record carries no session lock.
    expect(store.findById("sub-1")?.activeSessionId).toBeUndefined();
    // Stable per-client lease session ids for downstream bookkeeping.
    expect(first.accessKeySessionId).toBe("sess:client-A");
    expect(second.accessKeySessionId).toBe("sess:client-B");
  });

  it("card path regression: second clientId still 409s on a card-key lease", async () => {
    const { service } = makeService(null);
    const cardReq = { headers: { "x-access-key": "sub_backing_value" } };

    const first = await service.leaseToken(cardReq, { clientId: "client-A", modelKey: "gpt-5-codex" });
    expect(first.ok).toBe(true);

    await expect(
      service.leaseToken(cardReq, { clientId: "client-B", modelKey: "gpt-5-codex" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it.each([
    [401, "SESSION_INVALID", "登录状态无效，请重新登录"],
    [403, "DEVICE_REVOKED", "设备登录已失效，请在客户端重新登录"],
    [403, "SUBSCRIPTION_EXPIRED", "无有效订阅或已到期"],
  ])("maps resolver failure to %i {ok:false, error:%s}", async (statusCode, code, message) => {
    const { service } = makeService({
      resolve: vi.fn().mockResolvedValue({ ok: false, statusCode, error: code, message }),
    });

    await expect(
      service.leaseToken(SESSION_REQ, { clientId: "c1", modelKey: "gpt-5-codex" }),
    ).rejects.toMatchObject({
      statusCode,
      message,
      body: { ok: false, error: code },
    });
  });

  it("reportResult for a session lease records usage to record.id and skips refreshSession", async () => {
    const { service, store } = makeService({
      resolve: vi.fn().mockResolvedValue({ ok: true, cardId: "sub-1" }),
    });

    const lease = await service.leaseToken(SESSION_REQ, { clientId: "client-A", modelKey: "gpt-5-codex" });
    const report = await service.reportResult(SESSION_REQ, {
      leaseId: lease.leaseId, status: 200, modelKey: "gpt-5-codex",
      inputTokens: 100, outputTokens: 50, totalTokens: 150,
    });

    expect(report.ok).toBe(true);
    // Usage attributed to the shadow record (record.id == lease.accessKeyId == sub id).
    const record = store.findById("sub-1")!;
    expect(record.totalTokensUsed).toBe(150);
    expect(record.totalRequests).toBe(1);
    // refreshSession skipped — no per-card session state was created.
    expect(record.activeSessionId).toBeUndefined();
    expect(record.sessionExpiresAt).toBeUndefined();
  });

  it("ACTIVE sub + EXPIRED shadow record + session token → 403 with the SUBSCRIPTION_EXPIRED machine code (drift surfaced, not a generic 401)", async () => {
    writeJson(accessKeysFilePath, {
      keys: [{
        id: "sub-1", key: "sub_backing_value", status: "active",
        keyExpiresAt: new Date(Date.now() - 1000).toISOString(),
      }],
    });
    // Resolver says the sub row is ACTIVE — only the record is expired.
    const { service } = makeService({
      resolve: vi.fn().mockResolvedValue({ ok: true, cardId: "sub-1" }),
    });

    await expect(
      service.leaseToken(SESSION_REQ, { clientId: "c1", modelKey: "gpt-5-codex" }),
    ).rejects.toMatchObject({
      statusCode: 403,
      body: { ok: false, error: "SUBSCRIPTION_EXPIRED" },
    });
  });

  it("card path with an expired key keeps the generic 401 (no machine code)", async () => {
    writeJson(accessKeysFilePath, {
      keys: [{
        id: "card-1", key: "card_secret", status: "active",
        firstUsedAt: "2020-01-01T00:00:00.000Z", durationMs: 1000,
      }],
    });
    const { service } = makeService(null);

    await expect(
      service.leaseToken({ headers: { "x-access-key": "card_secret" } }, { clientId: "c1", modelKey: "gpt-5-codex" }),
    ).rejects.toMatchObject({
      statusCode: 401,
      message: "Access key expired",
    });
  });

  // ── M13b: seat-exhausted plan records must NOT fall through to the pool ──
  // entitlement-sync marks every plan-backed shadow record requiresBinding.
  // When seat assignment failed for ALL products the record has no bindings;
  // before M13b it leased from the broad dynamic pool — access the plan never
  // sold. Cards and legacy pool records never carry the flag (byte-identical).

  it("requiresBinding record with NO binding for this pool → 409 capacity message, NO upstream lease attempted", async () => {
    writeJson(accessKeysFilePath, {
      keys: [{ id: "sub-1", key: "sub_backing_value", status: "active", requiresBinding: true }],
    });
    const { service } = makeService({
      resolve: vi.fn().mockResolvedValue({ ok: true, cardId: "sub-1" }),
    });

    await expect(
      service.leaseToken(SESSION_REQ, { clientId: "c1", modelKey: "gpt-5-codex" }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "服务开通中，请稍后重试或联系客服", // capacity wording, NOT "未开通该服务"
    });
    // The pool was never touched — no upstream token refresh attempted.
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it("requiresBinding record WITH a seat in this pool → leases normally from its bound account", async () => {
    writeJson(accessKeysFilePath, {
      keys: [{
        id: "sub-1", key: "sub_backing_value", status: "active",
        requiresBinding: true, bindings: { fake: 1 }, // provider id is "fake"
      }],
    });
    const { service } = makeService({
      resolve: vi.fn().mockResolvedValue({ ok: true, cardId: "sub-1" }),
    });

    const lease = await service.leaseToken(SESSION_REQ, { clientId: "c1", modelKey: "gpt-5-codex" });
    expect(lease.ok).toBe(true);
    expect(lease.accountId).toBe(1); // the bound seat, not a pool pick
    expect(lease.bound).toBe(true);
  });

  it("legacy POOL card (no requiresBinding, no bindings) still leases from the dynamic pool — regression guard", async () => {
    const { service } = makeService(null);

    const lease = await service.leaseToken(
      { headers: { "x-access-key": "sub_backing_value" } },
      { clientId: "c1", modelKey: "gpt-5-codex" },
    );
    expect(lease.ok).toBe(true);
    expect(lease.bound).toBe(false);
    expect(refreshToken).toHaveBeenCalled(); // pool lease really happened
  });

  it("card bound for a DIFFERENT pool only keeps the unchanged wrong-product 409", async () => {
    writeJson(accessKeysFilePath, {
      keys: [{ id: "card-1", key: "card_secret", status: "active", bindings: { otherpool: 3 } }],
    });
    const { service } = makeService(null);

    await expect(
      service.leaseToken({ headers: { "x-access-key": "card_secret" } }, { clientId: "c1", modelKey: "gpt-5-codex" }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "此卡未开通该服务，请联系客服",
    });
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it("session lease over a bucket cap still 429s with retryAfterMs (shared pipeline)", async () => {
    const now = Date.now();
    writeJson(accessKeysFilePath, {
      keys: [{
        id: "sub-1", key: "sub_backing_value", status: "active",
        bucketLimits: { "fake-gpt": 1000 }, windowStartedAt: now,
        tokenUsageEvents: [
          { at: now, inputTokens: 900, outputTokens: 200, modelKey: "gpt-5-codex", product: "fake" },
        ],
      }],
    });
    const { service } = makeService({
      resolve: vi.fn().mockResolvedValue({ ok: true, cardId: "sub-1" }),
    });

    await expect(
      service.leaseToken(SESSION_REQ, { clientId: "c1", modelKey: "gpt-5-codex" }),
    ).rejects.toMatchObject({ statusCode: 429 });
  });
});
