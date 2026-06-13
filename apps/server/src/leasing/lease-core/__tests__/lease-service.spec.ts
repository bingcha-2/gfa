import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LeaseService } from "../lease-service";
import type { Provider } from "../provider";
import { sessionReqFor, withSessionResolver } from "../../token-server/__tests__/session-test-util";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * A minimal "codex-like" provider: accounts have NO projectId, and quota
 * snapshots are a no-op. This proves LeaseService is generic over the
 * antigravity-specific seams (projectId eligibility, quota snapshot,
 * lease-response extras).
 */
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
    isAccountEligible: () => true, // no projectId requirement
    applyQuotaSnapshot: (account: any) => ({ account, creditDelta: null }),
    egressPolicy: "optional" as const,
    leaseResponseExtras: () => ({}),
  };
}

describe("LeaseService (generic core)", () => {
  let tempDir: string;
  let accountsFilePath: string;
  let accessKeysFilePath: string;
  const refreshToken = vi.fn();

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-lease-core-"));
    accountsFilePath = path.join(tempDir, "codex-accounts.json");
    accessKeysFilePath = path.join(tempDir, "access-keys.json");
    refreshToken.mockReset();

    writeJson(accountsFilePath, {
      accounts: [
        { id: 1, email: "one@example.com", refreshToken: "rt-1", enabled: true },
        { id: 2, email: "two@example.com", refreshToken: "rt-2", enabled: true },
      ],
    });
    writeJson(accessKeysFilePath, {
      // Unbound "pool" card — exercises the dynamic-pool path (no static binding).
      keys: [{ id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000, windowLimit: 100 }],
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeService() {
    return withSessionResolver(new LeaseService(makeFakeProvider(accountsFilePath, refreshToken), {
      accessKeysFilePath,
      now: () => Date.now(),
      randomId: () => "lease-fixed",
      minClientVersion: "",
    }));
  }

  const REQ = sessionReqFor("card-1");

  it("leases a token from a projectId-less account", async () => {
    refreshToken.mockResolvedValue("access-token-1");
    const service = makeService();

    const result = await service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex", bodyBytes: 100 });

    expect(result.ok).toBe(true);
    expect(result.leaseId).toBe("lease-fixed");
    expect([1, 2]).toContain(result.accountId);
    expect(result.accessToken).toBe("access-token-1");
    // codex-like provider contributes no projectId
    expect((result as any).projectId).toBeUndefined();
  });

  it("下发账号绑定的出口代理 accountProxyUrl;optional provider 的 egressRequired=false", async () => {
    refreshToken.mockResolvedValue("tok");
    writeJson(accountsFilePath, {
      accounts: [
        { id: 1, email: "one@example.com", refreshToken: "rt-1", enabled: true, proxyUrl: "socks5://u:p@res.example:1080" },
      ],
    });
    const result = await makeService().leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" });

    expect(result.ok).toBe(true);
    expect((result as any).accountProxyUrl).toBe("socks5://u:p@res.example:1080");
    // makeFakeProvider 的 egressPolicy="optional" → 没绑定也能本地直连,故 false。
    expect((result as any).egressRequired).toBe(false);
  });

  it("账号未绑定代理时 accountProxyUrl 下发空串(不是 undefined)", async () => {
    refreshToken.mockResolvedValue("tok"); // beforeEach 的账号都没有 proxyUrl
    const result = await makeService().leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" });

    expect(result.ok).toBe(true);
    expect((result as any).accountProxyUrl).toBe("");
  });

  it("egressRequired 跟随 provider.egressPolicy:required provider 下发 true(anthropic fail-closed)", async () => {
    refreshToken.mockResolvedValue("tok");
    writeJson(accountsFilePath, {
      accounts: [{ id: 1, email: "one@example.com", refreshToken: "rt-1", enabled: true, proxyUrl: "socks5://res:1080" }],
    });
    const provider = { ...makeFakeProvider(accountsFilePath, refreshToken), egressPolicy: "required" as const };
    const service = withSessionResolver(new LeaseService(provider, {
      accessKeysFilePath, now: () => Date.now(), randomId: () => "lease-fixed", minClientVersion: "",
    }));
    const result = await service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" });

    expect(result.ok).toBe(true);
    expect((result as any).egressRequired).toBe(true);
  });

  it("retries the next account when the first token refresh fails", async () => {
    refreshToken
      .mockRejectedValueOnce(new Error("Transient network error"))
      .mockResolvedValueOnce("access-token-ok");
    const service = makeService();

    const result = await service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" });

    expect(result.ok).toBe(true);
    expect(result.accessToken).toBe("access-token-ok");
    expect(refreshToken).toHaveBeenCalledTimes(2);
  });

  it("records usage against the access key on report-result", async () => {
    refreshToken.mockResolvedValue("access-token-1");
    const service = makeService();

    const lease = await service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" });
    const report = await service.reportResult(REQ, {
      leaseId: lease.leaseId, status: 200, modelKey: "gpt-5-codex",
      inputTokens: 100, outputTokens: 50, totalTokens: 150,
    });

    expect(report.ok).toBe(true);
    expect(report.accessKeyStatus.totalTokensUsed).toBe(150);
  });

  it("不再用请求体大小估算:0-token 生成上报记 0,绝不把整段请求体当一次用量", async () => {
    refreshToken.mockResolvedValue("access-token-1");
    const service = makeService();

    const lease = await service.leaseToken(REQ, {
      clientId: "c1", modelKey: "gpt-5-codex", bodyBytes: 8000,
    });
    // 生成请求成功但 usage 未解析到(无 token 字段)→ 旧逻辑会按 requestBodyBytes/4=2000 凭空计费
    const report = await service.reportResult(REQ, {
      leaseId: lease.leaseId, status: 200, modelKey: "gpt-5-codex",
    });

    expect(report.ok).toBe(true);
    expect(report.accessKeyStatus.totalTokensUsed).toBe(0);
  });

  // ── Static account binding (no fallback) ─────────────────────────────────

  function makeBoundService(busyMessage?: string) {
    return withSessionResolver(new LeaseService(makeFakeProvider(accountsFilePath, refreshToken), {
      accessKeysFilePath,
      now: () => Date.now(),
      randomId: () => "lease-fixed",
      minClientVersion: "",
      busyMessage,
    }));
  }

  it("leases only from the account the card is bound to", async () => {
    refreshToken.mockResolvedValue("tok");
    writeJson(accessKeysFilePath, {
      keys: [{
        id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000,
        provider: "fake", boundAccountId: 2,
      }],
    });
    const service = makeBoundService();

    for (let i = 0; i < 3; i++) {
      const r = await service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" });
      expect(r.accountId).toBe(2);
    }
  });

  it("fails with the busy message and does NOT scan other accounts when the bound account's token refresh fails", async () => {
    refreshToken.mockRejectedValue(new Error("Transient network error"));
    writeJson(accessKeysFilePath, {
      keys: [{
        id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000,
        provider: "fake", boundAccountId: 1,
      }],
    });
    const service = makeBoundService("当前账号繁忙，请稍后重试");

    await expect(
      service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" }),
    ).rejects.toThrow("当前账号繁忙");
    // bound account 1 is tried once; account 2 is never touched.
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(refreshToken).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it("fails with the busy message when the bound account is disabled (no fallback)", async () => {
    refreshToken.mockResolvedValue("tok");
    writeJson(accountsFilePath, {
      accounts: [
        { id: 1, email: "one@example.com", refreshToken: "rt-1", enabled: false },
        { id: 2, email: "two@example.com", refreshToken: "rt-2", enabled: true },
      ],
    });
    writeJson(accessKeysFilePath, {
      keys: [{
        id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000,
        provider: "fake", boundAccountId: 1,
      }],
    });
    const service = makeBoundService("当前账号繁忙，请稍后重试");

    // Disabled bound account → "不可用", NOT the misleading "额度恢复中" busy text.
    await expect(
      service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" }),
    ).rejects.toThrow(/不可用/);
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it("reports a clear 'account unavailable' (not busy) when the bound account no longer exists", async () => {
    refreshToken.mockResolvedValue("tok");
    // Card bound to account 99, which is not in the pool (deleted / empty pool).
    writeJson(accessKeysFilePath, {
      keys: [{
        id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000,
        bindings: { fake: 99 },
      }],
    });
    const service = makeBoundService("当前账号繁忙，请稍后重试");

    await expect(
      service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" }),
    ).rejects.toThrow(/不可用/);
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it("clears the account's cached access token on a 401 so the next lease refreshes a fresh one", async () => {
    refreshToken.mockResolvedValue("tok");
    // Account has a cached access token that is NOT expired but was invalidated upstream.
    writeJson(accountsFilePath, {
      accounts: [{
        id: 1, email: "a@example.com", refreshToken: "rt-1",
        accessToken: "STALE-INVALIDATED", accessTokenExpiresAt: Date.now() + 3_600_000, enabled: true,
      }],
    });
    writeJson(accessKeysFilePath, {
      keys: [{ id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000, bindings: { fake: 1 } }],
    });
    const service = makeBoundService();

    const lease = await service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" });
    await service.reportResult(REQ, { leaseId: lease.leaseId, status: 401, modelKey: "gpt-5-codex" });

    service.flushAccounts();
    const stored = JSON.parse(fs.readFileSync(accountsFilePath, "utf8"));
    expect(stored.accounts[0].accessToken).toBe("");
    expect(stored.accounts[0].accessTokenExpiresAt).toBe(0);
  });

  it("serves an unbound (pool-mode) card from the dynamic pool", async () => {
    refreshToken.mockResolvedValue("tok");
    writeJson(accessKeysFilePath, {
      keys: [{ id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000 }],
    });
    const service = makeBoundService();

    const r = await service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" });
    expect(r.ok).toBe(true);
    expect([1, 2]).toContain(r.accountId);
  });

  it("rejects a card sold for the other pool only (has a binding, but not for this pool)", async () => {
    refreshToken.mockResolvedValue("tok");
    // Card bound only in the antigravity pool; the (fake=codex-like) service must reject it.
    writeJson(accessKeysFilePath, {
      keys: [{
        id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000,
        bindings: { antigravity: 1 },
      }],
    });
    const service = makeBoundService();

    await expect(
      service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it("a bound account on cooldown re-leases the SAME account (ignores cooldown, never switches)", async () => {
    // 绑定卡只有这一个号、无号可换 → 429/503 冷却对它毫无意义,预先拦只会害卡白白不可用。
    // 所以绑定卡一律忽略冷却,直接重租同一个号去试真上游;绝不切到 acct 2(无 failover)。
    refreshToken.mockResolvedValue("tok");
    writeJson(accessKeysFilePath, {
      keys: [{
        id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000,
        bindings: { fake: 1 },
      }],
    });
    const service = makeBoundService("额度用完，请稍后再试");

    const lease = await service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" });
    expect(lease.accountId).toBe(1);
    // The bound account hits its quota (429) → would normally cool down.
    await service.reportResult(REQ, {
      leaseId: lease.leaseId, reportId: "r1", status: 429, modelKey: "gpt-5-codex", reason: "quota",
    });
    refreshToken.mockClear();

    // Next lease → ignores the cooldown, re-leases acct 1. Account 2 is NEVER tried.
    const second = await service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" });
    expect(second.accountId).toBe(1);
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(refreshToken).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it("gives a bound card a much longer lease than a pool card (fewer re-leases)", async () => {
    refreshToken.mockResolvedValue("tok"); // not a JWT → bound falls back to BOUND_LEASE_TTL_MS

    // Pool card → capped at the 10-minute pool default.
    writeJson(accessKeysFilePath, {
      keys: [{ id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000 }],
    });
    const poolLease = await makeBoundService().leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" });
    const poolTtl = Date.parse(poolLease.expiresAt) - Date.now();
    // Pool default is 15 min (short → keeps the scheduler rebalancing/failover responsive).
    expect(poolTtl).toBeGreaterThan(13 * 60 * 1000);
    expect(poolTtl).toBeLessThanOrEqual(15 * 60 * 1000 + 2000);

    // Bound card → much longer (account is fixed, no rebalancing needed).
    writeJson(accessKeysFilePath, {
      keys: [{ id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000, bindings: { fake: 1 } }],
    });
    const boundLease = await makeBoundService().leaseToken(REQ, { clientId: "c2", modelKey: "gpt-5-codex" });
    const boundTtl = Date.parse(boundLease.expiresAt) - Date.now();
    // Bound default is 40 min (token undecodable → falls back to BOUND_LEASE_TTL_MS).
    expect(boundTtl).toBeGreaterThan(38 * 60 * 1000);
    expect(boundTtl).toBeLessThanOrEqual(40 * 60 * 1000 + 2000);
  });

  it("marks a bound lease bound:true so the client skips cross-account rotation", async () => {
    refreshToken.mockResolvedValue("tok");
    writeJson(accessKeysFilePath, {
      keys: [{ id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000, bindings: { fake: 1 } }],
    });
    const r = await makeBoundService().leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" });
    expect((r as any).bound).toBe(true);
  });

  it("marks a pool lease bound:false (client may still rotate across accounts)", async () => {
    refreshToken.mockResolvedValue("tok");
    writeJson(accessKeysFilePath, {
      keys: [{ id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000 }],
    });
    const r = await makeBoundService().leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" });
    expect((r as any).bound).toBe(false);
  });

  it("returns the leased account's per-bucket quotas so every bar has real data on activation", async () => {
    refreshToken.mockResolvedValue("tok");
    // Account 1 has known per-model quotas (claude→opus, gemini→gemini), as if
    // populated by earlier (shared) usage.
    writeJson(accountsFilePath, {
      accounts: [{
        id: 1, email: "a@example.com", refreshToken: "rt-1", enabled: true,
        modelQuotaFractions: { "claude-sonnet-4-6": 0.3, "gemini-2.5-pro": 0.9 },
        modelQuotaResetTimes: { "claude-sonnet-4-6": "2099-06-10T00:00:00.000Z" },
      }],
    });
    writeJson(accessKeysFilePath, {
      keys: [{ id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000, bindings: { fake: 1 } }],
    });
    // A model-less warmup lease (as on activation) still returns ALL buckets.
    // Buckets are composite `<product>-<family>`; the fake provider's id is "fake".
    const r: any = await makeBoundService().leaseToken(REQ, { clientId: "c1" });
    expect(r.accountBuckets["fake-claude"].fraction).toBeCloseTo(0.3, 5);
    expect(r.accountBuckets["fake-gemini"].fraction).toBeCloseTo(0.9, 5);
    expect(r.accountBuckets["fake-claude"].resetAt).toBe(Date.parse("2099-06-10T00:00:00.000Z"));
  });

  it("keys account buckets by product — anthropic-claude never collides with antigravity-claude (root cause B)", async () => {
    refreshToken.mockResolvedValue("tok");
    // Same Claude model fraction stored on an account; the product prefix (from
    // provider.id) is what keeps the two products' blood bars separate.
    writeJson(accountsFilePath, {
      accounts: [{
        id: 1, email: "a@example.com", refreshToken: "rt-1", enabled: true,
        modelQuotaFractions: { claude: 0.3 },
      }],
    });
    writeJson(accessKeysFilePath, {
      keys: [{ id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000, bindings: { anthropic: 1 } }],
    });
    const service = withSessionResolver(new LeaseService(
      makeFakeProvider(accountsFilePath, refreshToken, "anthropic"),
      { accessKeysFilePath, now: () => Date.now(), randomId: () => "lease-fixed", minClientVersion: "" },
    ));
    const r: any = await service.leaseToken(REQ, { clientId: "c1" });
    expect(r.accountBuckets["anthropic-claude"].fraction).toBeCloseTo(0.3, 5);
    // The old flat "opus" key and the other product's bucket must NOT appear.
    expect(r.accountBuckets["opus"]).toBeUndefined();
    expect(r.accountBuckets["antigravity-claude"]).toBeUndefined();
  });

  it("surfaces the bound account's blood-bar fraction in the lease response", async () => {
    refreshToken.mockResolvedValue("tok");
    const provider = makeFakeProvider(accountsFilePath, refreshToken);
    provider.bloodBarFraction = (account: any) => ({
      fraction: account.id === 2 ? 0.42 : 1,
      resetAt: 1_900_000_000_000,
    });
    writeJson(accessKeysFilePath, {
      keys: [{
        id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000,
        provider: "fake", boundAccountId: 2,
      }],
    });
    const service = withSessionResolver(new LeaseService(provider, {
      accessKeysFilePath, now: () => Date.now(), randomId: () => "lease-fixed", minClientVersion: "",
    }));

    const r = await service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" });
    expect(r.boundAccount).toEqual({ id: 2, fraction: 0.42, resetAt: 1_900_000_000_000 });
  });

  it("enforces the per-card token cap at lease — usage over the cap is rejected with 429", async () => {
    refreshToken.mockResolvedValue("tok");
    writeJson(accessKeysFilePath, {
      keys: [{
        id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000,
        provider: "fake", boundAccountId: 1,
        bucketLimits: { "fake-gpt": 1000 }, windowStartedAt: Date.now(),
        tokenUsageEvents: [
          { at: Date.now(), inputTokens: 5_000_000, outputTokens: 5_000_000, modelKey: "gpt-5-codex", product: "fake" },
        ],
      }],
    });
    const service = makeBoundService();

    // Server-side backup enforcement: over-cap usage → 429 (not 401, not a silent lease).
    await expect(
      service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" }),
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it("leases normally for a bound card under its cap (cap set but not exceeded)", async () => {
    refreshToken.mockResolvedValue("tok");
    writeJson(accessKeysFilePath, {
      keys: [{
        id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000,
        provider: "fake", boundAccountId: 1,
        bucketLimits: { "fake-gpt": 5_000_000 }, windowStartedAt: Date.now(),
        tokenUsageEvents: [
          { at: Date.now(), inputTokens: 100, outputTokens: 50, modelKey: "gpt-5-codex", product: "fake" },
        ],
      }],
    });
    const service = makeBoundService();

    const r = await service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" });
    expect(r.ok).toBe(true);
    expect(r.accountId).toBe(1);
  });

  it("rejects clients below the new default minimum version, forcing the binding upgrade", async () => {
    refreshToken.mockResolvedValue("tok");
    writeJson(accessKeysFilePath, {
      keys: [{
        id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000,
        provider: "fake", boundAccountId: 1,
      }],
    });
    // No minClientVersion option → falls back to the in-code default floor.
    const service = withSessionResolver(new LeaseService(makeFakeProvider(accountsFilePath, refreshToken), {
      accessKeysFilePath, now: () => Date.now(), randomId: () => "lease-fixed",
    }));

    // Below the in-code floor (now 9.5.0) must be rejected (426 upgrade required) —
    // even the previous floor 9.4.0 is now below the new minimum…
    await expect(
      service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex", clientVersion: "9.4.0" }),
    ).rejects.toThrow();
    // …while the floor version is accepted.
    const ok = await service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex", clientVersion: "9.5.0" });
    expect(ok.ok).toBe(true);
  });

  it("keeps a per-model-cooled account available to a model-less probe and to other models", async () => {
    refreshToken.mockResolvedValue("access-token-1");
    const service = makeService();

    // Cool BOTH accounts for "claude-sonnet" via 503 capacity reports. Each report
    // needs a unique reportId — the randomId stub reuses one leaseId, so without it
    // the second report would dedup against the first and never cool the 2nd account.
    for (const n of [1, 2]) {
      const lease = await service.leaseToken(REQ, { clientId: "c1", modelKey: "claude-sonnet" });
      await service.reportResult(REQ, {
        leaseId: lease.leaseId, reportId: `r${n}`, status: 503, modelKey: "claude-sonnet", reason: "capacity",
      });
    }

    // The cooled model itself must be blocked on every account.
    await expect(
      service.leaseToken(REQ, { clientId: "c1", modelKey: "claude-sonnet" }),
    ).rejects.toThrow();

    // A model-less probe (activation/warmup) must still succeed — a per-model
    // cooldown must not make the whole account look unavailable.
    const probe = await service.leaseToken(REQ, { clientId: "c1" });
    expect(probe.ok).toBe(true);

    // A different model on the same accounts is unaffected by the claude cooldown.
    const other = await service.leaseToken(REQ, { clientId: "c1", modelKey: "gemini-pro" });
    expect(other.ok).toBe(true);
  });

  // ── poolEnabled (出池) 运行时门槛 ─────────────────────────────────────────
  // 出池号(poolEnabled:false)只服务"绑定它的卡",不进动态池;绑定卡钉号不受影响。

  it("pool card fails when the only account is out of pool (poolEnabled:false)", async () => {
    refreshToken.mockResolvedValue("tok");
    writeJson(accountsFilePath, {
      accounts: [
        { id: 1, email: "out@example.com", refreshToken: "rt-1", enabled: true, poolEnabled: false },
      ],
    });
    // default beforeEach 写的是 pool 卡(无绑定)。
    const service = makeService();
    await expect(
      service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" }),
    ).rejects.toThrow();
    // 出池号根本不该被尝试刷新 token。
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it("pool card only draws from in-pool accounts, skipping the out-of-pool one", async () => {
    refreshToken.mockResolvedValue("tok");
    writeJson(accountsFilePath, {
      accounts: [
        { id: 1, email: "out@example.com", refreshToken: "rt-1", enabled: true, poolEnabled: false },
        { id: 2, email: "in@example.com", refreshToken: "rt-2", enabled: true, poolEnabled: true },
      ],
    });
    const service = makeService();
    for (let i = 0; i < 5; i++) {
      const r = await service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" });
      expect(r.accountId).toBe(2);
    }
  });

  it("bound card STILL leases from its account even if it is out of pool", async () => {
    refreshToken.mockResolvedValue("tok");
    writeJson(accountsFilePath, {
      accounts: [
        { id: 1, email: "out@example.com", refreshToken: "rt-1", enabled: true, poolEnabled: false },
        { id: 2, email: "in@example.com", refreshToken: "rt-2", enabled: true, poolEnabled: true },
      ],
    });
    writeJson(accessKeysFilePath, {
      keys: [{
        id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000,
        provider: "fake", boundAccountId: 1,
      }],
    });
    const service = makeService();
    const r = await service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" });
    // 出池,但是绑定卡 → 仍然用 1 号(仅绑定卡可用)。
    expect(r.accountId).toBe(1);
  });

  it("订阅接力:优先订阅桶满 → 自动切到下一个有额度的订阅", async () => {
    const { AccessKeyStore } = await import("../../token-server/access-key-store");
    const store = new AccessKeyStore(accessKeysFilePath);
    // s1: bucket "fake-gpt" limit=1, already used 5 → exceeded
    // s2: bucket "fake-gpt" limit=100000, no usage → available
    store.loadSubscriptionRecords([
      { id: "s1", key: "s1-key", customerId: "cust-1", priority: 1, status: "active", products: ["fake"],
        bucketLimits: { "fake-gpt": 1 }, windowMs: 18_000_000, windowStartedAt: Date.now(),
        tokenUsageEvents: [{ at: Date.now(), status: 200, modelKey: "gpt-5-codex", product: "fake", totalTokens: 5 }] },
      { id: "s2", key: "s2-key", customerId: "cust-1", priority: 2, status: "active", products: ["fake"],
        bucketLimits: { "fake-gpt": 100000 }, windowMs: 18_000_000 },
    ]);
    const service = withSessionResolver(new LeaseService(
      makeFakeProvider(accountsFilePath, refreshToken),
      { accessKeysFilePath, accessKeyStore: store, now: () => Date.now(), randomId: () => "lease-fixed", minClientVersion: "" },
    ));
    refreshToken.mockResolvedValue("tok");
    const lease: any = await service.leaseToken(sessionReqFor("s1"), { clientId: "c1", modelKey: "gpt-5-codex" });
    expect(lease.ok).toBe(true);
    expect(lease.activeSubscriptionId).toBe("s2");
  });

  it("账户所有订阅都满 → 429", async () => {
    const { AccessKeyStore } = await import("../../token-server/access-key-store");
    const store = new AccessKeyStore(accessKeysFilePath);
    store.loadSubscriptionRecords([
      { id: "s1", key: "s1-key", customerId: "cust-1", priority: 1, status: "active", products: ["fake"],
        bucketLimits: { "fake-gpt": 1 }, windowMs: 18_000_000, windowStartedAt: Date.now(),
        tokenUsageEvents: [{ at: Date.now(), status: 200, modelKey: "gpt-5-codex", product: "fake", totalTokens: 5 }] },
    ]);
    const service = withSessionResolver(new LeaseService(
      makeFakeProvider(accountsFilePath, refreshToken),
      { accessKeysFilePath, accessKeyStore: store, now: () => Date.now(), randomId: () => "lease-fixed", minClientVersion: "" },
    ));
    refreshToken.mockResolvedValue("tok");
    await expect(service.leaseToken(sessionReqFor("s1"), { clientId: "c1", modelKey: "gpt-5-codex" }))
      .rejects.toMatchObject({ statusCode: 429 });
  });

  it("写入点把订阅 record 的 customerId 带进用量事件", async () => {
    const { AccessKeyStore } = await import("../../token-server/access-key-store");
    const recordSpy = vi.fn();
    const fakeTracker = {
      record: recordSpy, flush: vi.fn(), destroy: vi.fn(), getQueueForTesting: () => [],
    } as any;
    const store = new AccessKeyStore(accessKeysFilePath);
    // 池子订阅 record:无 binding → 走 dynamic pool;带 customerId。
    // keyExpiresAt 设为未来时间确保不过期;key 字段供认证用(session path 用 id 查,key 供 validateRecord)。
    store.loadSubscriptionRecords([
      {
        id: "sub-c1", key: "sub-c1-key", customerId: "cust-42", status: "active",
        keyExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        products: ["fake"],
      },
    ]);
    const service = withSessionResolver(new LeaseService(
      makeFakeProvider(accountsFilePath, refreshToken),
      { accessKeysFilePath, accessKeyStore: store, tokenUsageTracker: fakeTracker,
        now: () => Date.now(), randomId: () => "lease-fixed", minClientVersion: "" },
    ));
    refreshToken.mockResolvedValue("tok");
    const req = sessionReqFor("sub-c1");

    const lease = await service.leaseToken(req, { clientId: "c1", modelKey: "gpt-5-codex" });
    expect(lease.ok).toBe(true);
    await service.reportResult(req, {
      leaseId: lease.leaseId, status: 200, modelKey: "gpt-5-codex",
      inputTokens: 100, outputTokens: 50, totalTokens: 150,
    });

    expect(recordSpy).toHaveBeenCalledWith(expect.objectContaining({
      accessKeyId: "sub-c1", customerId: "cust-42",
    }));
  });
});
