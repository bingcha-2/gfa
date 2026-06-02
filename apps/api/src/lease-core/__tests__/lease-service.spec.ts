import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LeaseService } from "../lease-service";
import type { Provider } from "../provider";

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
): Provider<any> {
  return {
    id: "fake",
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
    return new LeaseService(makeFakeProvider(accountsFilePath, refreshToken), {
      accessKeysFilePath,
      now: () => Date.now(),
      randomId: () => "lease-fixed",
      minClientVersion: "",
    });
  }

  const REQ = { headers: { "x-token-server-secret": "secret-card" } };

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

  // ── Static account binding (no fallback) ─────────────────────────────────

  function makeBoundService(busyMessage?: string) {
    return new LeaseService(makeFakeProvider(accountsFilePath, refreshToken), {
      accessKeysFilePath,
      now: () => Date.now(),
      randomId: () => "lease-fixed",
      minClientVersion: "",
      busyMessage,
    });
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

  it("a bound account out of quota stays bound — busy, never switches to another account", async () => {
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
    // The bound account hits its quota (429).
    await service.reportResult(REQ, {
      leaseId: lease.leaseId, reportId: "r1", status: 429, modelKey: "gpt-5-codex", reason: "quota",
    });
    refreshToken.mockClear();

    // Next lease → busy. Account 2 exists but is NEVER tried (no failover / no 切号).
    await expect(
      service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" }),
    ).rejects.toThrow("额度用完");
    expect(refreshToken).not.toHaveBeenCalled();
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
        modelQuotaResetTimes: { "claude-sonnet-4-6": "2026-06-10T00:00:00.000Z" },
      }],
    });
    writeJson(accessKeysFilePath, {
      keys: [{ id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000, bindings: { fake: 1 } }],
    });
    // A model-less warmup lease (as on activation) still returns ALL buckets.
    const r: any = await makeBoundService().leaseToken(REQ, { clientId: "c1" });
    expect(r.accountBuckets.opus.fraction).toBeCloseTo(0.3, 5);
    expect(r.accountBuckets.gemini.fraction).toBeCloseTo(0.9, 5);
    expect(r.accountBuckets.opus.resetAt).toBe(Date.parse("2026-06-10T00:00:00.000Z"));
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
    const service = new LeaseService(provider, {
      accessKeysFilePath, now: () => Date.now(), randomId: () => "lease-fixed", minClientVersion: "",
    });

    const r = await service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" });
    expect(r.boundAccount).toEqual({ id: 2, fraction: 0.42, resetAt: 1_900_000_000_000 });
  });

  it("does not enforce the GFA per-card token cap — usage over the old limit still leases", async () => {
    refreshToken.mockResolvedValue("tok");
    writeJson(accessKeysFilePath, {
      keys: [{
        id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000,
        provider: "fake", boundAccountId: 1,
        tokenWindowLimit: 1000, windowStartedAt: Date.now(),
        tokenUsageEvents: [
          { at: Date.now(), inputTokens: 5_000_000, outputTokens: 5_000_000, modelKey: "gpt-5-codex" },
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
    const service = new LeaseService(makeFakeProvider(accountsFilePath, refreshToken), {
      accessKeysFilePath, now: () => Date.now(), randomId: () => "lease-fixed",
    });

    // The previous floor (6.1.0) must now be rejected (426 upgrade required)…
    await expect(
      service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex", clientVersion: "6.1.0" }),
    ).rejects.toThrow();
    // …while the new client version is accepted.
    const ok = await service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex", clientVersion: "7.0.0" });
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
});
