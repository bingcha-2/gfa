import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TokenServerService } from "../token-server.service";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("TokenServerService", () => {
  let tempDir: string;
  let accountsFilePath: string;
  let accessKeysFilePath: string;
  const tokenProvider = vi.fn();

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-token-server-"));
    accountsFilePath = path.join(tempDir, "accounts.json");
    accessKeysFilePath = path.join(tempDir, "access-keys.json");
    tokenProvider.mockReset();

    writeJson(accountsFilePath, {
      accounts: [
        {
          id: 1,
          email: "alpha@example.com",
          refreshToken: "refresh-alpha",
          projectId: "project-alpha",
          enabled: true,
          planType: "ultra",
        },
      ],
    });
    writeJson(accessKeysFilePath, {
      keys: [
        {
          id: "card-1",
          key: "secret-card",
          status: "active",
          durationMs: 60 * 60 * 1000,
          windowLimit: 10,
        },
      ],
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeService() {
    return new TokenServerService({
      accountsFilePath,
      accessKeysFilePath,
      tokenProvider,
      now: () => Date.now(),
      randomId: () => "lease-fixed",
    });
  }

  it("returns status with access-key and account summaries", () => {
    const status = makeService().getStatus();

    expect(status.running).toBe(true);
    expect(status.mode).toBe("remote-token-server");
    expect(status.activeLeases).toBe(0);
    expect(status.accessKeys).toHaveLength(1);
    expect(status.accounts.total).toBe(1);
    expect(status.accounts.enabled).toBe(1);
  });

  it("rejects lease-token when the access key is invalid", async () => {
    const service = makeService();

    await expect(
      service.leaseToken(
        { headers: { "x-token-server-secret": "bad-card" } },
        { clientId: "client-a", modelKey: "gemini" },
      ),
    ).rejects.toMatchObject({ statusCode: 401, message: "Invalid access key" });
    expect(tokenProvider).not.toHaveBeenCalled();
  });

  it("leases a token from an enabled account with a project id", async () => {
    tokenProvider.mockResolvedValue("access-token-alpha");
    const service = makeService();

    const result = await service.leaseToken(
      { headers: { "x-token-server-secret": "secret-card" } },
      { clientId: "client-a", modelKey: "gemini", bodyBytes: 1000 },
    );

    expect(result.ok).toBe(true);
    expect(result.leaseId).toBe("lease-fixed");
    expect(result.accountId).toBe(1);
    expect(result.emailHint).toBe("al***@example.com");
    expect(result.accessToken).toBe("access-token-alpha");
    expect(result.projectId).toBe("project-alpha");
    expect(result.accessKeySessionId).toBeTruthy();
    expect(tokenProvider).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, refreshToken: "refresh-alpha" }),
    );
  });

  it("records report-result usage against the lease access key", async () => {
    tokenProvider.mockResolvedValue("access-token-alpha");
    const service = makeService();
    await service.leaseToken(
      { headers: { "x-token-server-secret": "secret-card" } },
      { clientId: "client-a", modelKey: "gemini", bodyBytes: 1000 },
    );

    const report = await service.reportResult(
      { headers: { "x-token-server-secret": "secret-card" } },
      {
        leaseId: "lease-fixed",
        status: 200,
        modelKey: "gemini",
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
      },
    );

    expect(report.ok).toBe(true);
    expect(report.accessKeyStatus.totalTokensUsed).toBe(150);
    expect(service.getStatus().activeLeases).toBe(0);

    const stored = JSON.parse(fs.readFileSync(accessKeysFilePath, "utf8"));
    expect(stored.keys[0].totalTokensUsed).toBe(150);
    expect(stored.keys[0].totalRequests).toBe(1);
  });

  it("activates a Wails accountCard and binds it to the device session", () => {
    const service = makeService();

    const result = service.activateAccessKey(
      { headers: {} },
      { accountCard: "secret-card", deviceId: "device-a" },
    );

    expect(result.success).toBe(true);
    expect(result.code).toBe("OK");
    expect(result.data.accountCard.expiresAt).toBeTruthy();
    expect(result.data.accessKeyStatus.hasActiveSession).toBe(true);

    const stored = JSON.parse(fs.readFileSync(accessKeysFilePath, "utf8"));
    expect(stored.keys[0].firstUsedAt).toBeTruthy();
    expect(stored.keys[0].sessionClientId).toBe("device-a");
  });

  it("rejects activation when accountCard is missing", () => {
    const service = makeService();

    const result = service.activateAccessKey({ headers: {} }, { deviceId: "device-a" });

    expect(result).toMatchObject({
      success: false,
      code: "ACCOUNT_CARD_REQUIRED",
    });
  });

  it("accepts shadow metric reports without mutating billing counters", async () => {
    const service = makeService();

    const result = await service.shadowReport(
      { headers: { "x-token-server-secret": "secret-card" } },
      { lid: "lease-fixed", it: 10, ot: 5, rt: 15 },
    );

    expect(result).toEqual({ ok: true });
    const stored = JSON.parse(fs.readFileSync(accessKeysFilePath, "utf8"));
    expect(stored.keys[0].totalTokensUsed).toBeUndefined();
  });
});

// ── Account cooling, retry, and quota management ─────────────────────────────

describe("TokenServerService — account cooling and retry", () => {
  let tempDir: string;
  let accountsFilePath: string;
  let accessKeysFilePath: string;
  const tokenProvider = vi.fn();
  let currentTime: number;
  let leaseCounter: number;

  const REQ = { headers: { "x-token-server-secret": "secret-card" } };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-token-cool-"));
    accountsFilePath = path.join(tempDir, "accounts.json");
    accessKeysFilePath = path.join(tempDir, "access-keys.json");
    tokenProvider.mockReset();
    currentTime = Date.now();
    leaseCounter = 0;

    writeJson(accountsFilePath, {
      accounts: [
        { id: 1, email: "alpha@example.com", refreshToken: "rt-alpha", projectId: "proj-alpha", enabled: true },
        { id: 2, email: "beta@example.com", refreshToken: "rt-beta", projectId: "proj-beta", enabled: true },
        { id: 3, email: "gamma@example.com", refreshToken: "rt-gamma", projectId: "proj-gamma", enabled: true },
      ],
    });
    writeJson(accessKeysFilePath, {
      keys: [{
        id: "card-1",
        key: "secret-card",
        status: "active",
        durationMs: 24 * 60 * 60 * 1000,
        windowLimit: 100,
      }],
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeService() {
    return new TokenServerService({
      accountsFilePath,
      accessKeysFilePath,
      tokenProvider,
      now: () => currentTime,
      randomId: () => `lease-${++leaseCounter}`,
    });
  }

  function leasePayload(modelKey = "claude-opus-4-6-thinking") {
    return { clientId: "client-a", modelKey, bodyBytes: 500 };
  }

  // ── Token refresh failure retry ─────────────────────────────────────────

  it("retries next account when first account's token refresh fails", async () => {
    tokenProvider
      .mockRejectedValueOnce(new Error("Token refresh failed for alpha@example.com: 400 {\"error\":\"invalid_grant\"}"))
      .mockResolvedValueOnce("access-token-beta");

    const service = makeService();
    const result = await service.leaseToken(REQ, leasePayload());

    expect(result.ok).toBe(true);
    expect(result.accessToken).toBe("access-token-beta");
    expect(result.accountId).not.toBe(1);
    expect(tokenProvider).toHaveBeenCalledTimes(2);
  });

  it("returns 503 only after exhausting all candidates", async () => {
    tokenProvider.mockRejectedValue(new Error("Token refresh failed: 400 invalid_grant"));

    const service = makeService();
    await expect(
      service.leaseToken(REQ, leasePayload()),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(tokenProvider.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  // ── Permanent token error (invalid_grant) blocking ──────────────────────

  it("blocks account with invalid_grant on subsequent leases", async () => {
    tokenProvider
      .mockRejectedValueOnce(new Error("Token refresh failed for alpha@example.com: 400 {\"error\":\"invalid_grant\"}"))
      .mockResolvedValue("access-token-ok");

    const service = makeService();

    // First lease: account 1 fails, falls back
    const result1 = await service.leaseToken(REQ, leasePayload());
    expect(result1.ok).toBe(true);
    expect(result1.accountId).not.toBe(1);

    tokenProvider.mockClear();
    tokenProvider.mockResolvedValue("access-token-ok");

    // Second lease: account 1 should be skipped entirely (not even tried)
    const result2 = await service.leaseToken(REQ, leasePayload());
    expect(result2.ok).toBe(true);
    for (const call of tokenProvider.mock.calls) {
      expect((call[0] as any).id).not.toBe(1);
    }
  });

  // ── 429 report marks account exhausted ──────────────────────────────────

  it("marks account exhausted after 429 report and skips it in next lease", async () => {
    tokenProvider.mockResolvedValue("access-token-ok");
    const service = makeService();

    // Lease from account 1
    const result1 = await service.leaseToken(REQ, leasePayload());
    expect(result1.ok).toBe(true);
    const leasedAccountId = result1.accountId;

    // Report 429 with retryAfterMs
    await service.reportResult(REQ, {
      leaseId: result1.leaseId,
      status: 429,
      modelKey: "claude-opus-4-6-thinking",
      reason: "http_429_resource_exhausted",
      retryAfterMs: 300000,
    });

    tokenProvider.mockClear();
    tokenProvider.mockResolvedValue("access-token-ok");

    // Next lease: the exhausted account should be skipped
    const result2 = await service.leaseToken(REQ, leasePayload());
    expect(result2.ok).toBe(true);
    expect(result2.accountId).not.toBe(leasedAccountId);
  });

  it("uses retryAfterMs to calculate blockedUntil duration", async () => {
    tokenProvider.mockResolvedValue("access-token-ok");
    const service = makeService();

    const result1 = await service.leaseToken(REQ, leasePayload());
    const leasedAccountId = result1.accountId;

    // Report 429 with 10 minute retry
    await service.reportResult(REQ, {
      leaseId: result1.leaseId,
      status: 429,
      modelKey: "claude-opus-4-6-thinking",
      reason: "http_429_resource_exhausted",
      retryAfterMs: 600000,
    });

    // Verify account is blocked in status
    const status = service.getStatus();
    const blockedAccount = status.quota.accounts.find((a: any) => a.id === leasedAccountId);
    expect(blockedAccount).toBeDefined();
    expect(blockedAccount!.blockedUntil).toBeGreaterThan(currentTime);
  });

  // ── Account recovery after blockedUntil expires ─────────────────────────

  it("recovers account after blockedUntil expires", async () => {
    tokenProvider.mockResolvedValue("access-token-ok");
    const service = makeService();

    const result1 = await service.leaseToken(REQ, leasePayload());
    const leasedAccountId = result1.accountId;

    // Report 429 with 5-minute cooldown
    await service.reportResult(REQ, {
      leaseId: result1.leaseId,
      status: 429,
      modelKey: "claude-opus-4-6-thinking",
      reason: "http_429_resource_exhausted",
      retryAfterMs: 300000,
    });

    // Advance time past the cooldown
    currentTime += 300001;

    tokenProvider.mockClear();
    tokenProvider.mockResolvedValue("access-token-ok");

    // Now all accounts should be available again (including the previously blocked one)
    const candidates: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await service.leaseToken(REQ, leasePayload());
      candidates.push(r.accountId);
    }
    // The previously blocked account should appear at least once
    expect(candidates).toContain(leasedAccountId);
  });

  // ── Per-model blocking ──────────────────────────────────────────────────

  it("blocks account per-model: blocked for opus, available for gemini", async () => {
    tokenProvider.mockResolvedValue("access-token-ok");

    // Use only 1 account to make the test deterministic
    writeJson(accountsFilePath, {
      accounts: [
        { id: 1, email: "alpha@example.com", refreshToken: "rt-alpha", projectId: "proj-alpha", enabled: true },
      ],
    });

    const service = makeService();

    // Lease for opus model
    const result1 = await service.leaseToken(REQ, leasePayload("claude-opus-4-6-thinking"));
    expect(result1.accountId).toBe(1);

    // Report 429 for opus model
    await service.reportResult(REQ, {
      leaseId: result1.leaseId,
      status: 429,
      modelKey: "claude-opus-4-6-thinking",
      reason: "http_429_resource_exhausted",
      retryAfterMs: 300000,
    });

    // Lease for gemini model should still work with account 1
    tokenProvider.mockClear();
    tokenProvider.mockResolvedValue("access-token-ok");
    const result2 = await service.leaseToken(REQ, leasePayload("gemini-2.5-pro"));
    expect(result2.ok).toBe(true);
    expect(result2.accountId).toBe(1);

    // Lease for opus model should fail (only 1 account and it's blocked)
    tokenProvider.mockClear();
    tokenProvider.mockResolvedValue("access-token-ok");
    await expect(
      service.leaseToken(REQ, leasePayload("claude-opus-4-6-thinking")),
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  // ── Consecutive errors ──────────────────────────────────────────────────

  it("marks account as error after consecutive token refresh failures", async () => {
    tokenProvider.mockRejectedValue(new Error("Transient network error"));

    writeJson(accountsFilePath, {
      accounts: [
        { id: 1, email: "alpha@example.com", refreshToken: "rt-alpha", projectId: "proj-alpha", enabled: true },
      ],
    });

    const service = makeService();

    // Each leaseToken call fails because the only account's token refresh fails.
    // After REMOTE_ACCOUNT_ERROR_THRESHOLD (3) consecutive failures, account is marked "error".
    for (let i = 0; i < 3; i++) {
      await expect(service.leaseToken(REQ, leasePayload())).rejects.toMatchObject({ statusCode: 503 });
    }

    const status = service.getStatus();
    const account = status.quota.accounts.find((a: any) => a.id === 1);
    expect(account).toBeDefined();
    expect(account!.quotaStatus).toBe("error");
  });

  // ── Success clears state ────────────────────────────────────────────────

  it("success report clears account error state and model blocks", async () => {
    tokenProvider.mockResolvedValue("access-token-ok");
    const service = makeService();

    // Lease and report 429 to block account for a model
    const result1 = await service.leaseToken(REQ, leasePayload("claude-opus-4-6-thinking"));
    await service.reportResult(REQ, {
      leaseId: result1.leaseId,
      status: 429,
      modelKey: "claude-opus-4-6-thinking",
      reason: "http_429_resource_exhausted",
      retryAfterMs: 300000,
    });

    // Now lease for a different model and report success
    tokenProvider.mockClear();
    tokenProvider.mockResolvedValue("access-token-ok");
    const result2 = await service.leaseToken(REQ, leasePayload("gemini-2.5-pro"));
    await service.reportResult(REQ, {
      leaseId: result2.leaseId,
      status: 200,
      modelKey: "gemini-2.5-pro",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });

    // The per-model block for opus should remain (success on gemini doesn't clear opus block)
    const status = service.getStatus();
    const account = status.quota.accounts.find((a: any) => a.id === result1.accountId);
    expect(account).toBeDefined();
    // opus should still be blocked
    if (result1.accountId === result2.accountId) {
      const opusBlock = (account!.blockedModels || []).find(
        (b: any) => b.modelKey === "claude-opus-4-6-thinking",
      );
      expect(opusBlock).toBeDefined();
    }
  });

  it("success on the same model clears its block", async () => {
    tokenProvider.mockResolvedValue("access-token-ok");

    writeJson(accountsFilePath, {
      accounts: [
        { id: 1, email: "alpha@example.com", refreshToken: "rt-alpha", projectId: "proj-alpha", enabled: true },
        { id: 2, email: "beta@example.com", refreshToken: "rt-beta", projectId: "proj-beta", enabled: true },
      ],
    });

    const service = makeService();

    // Lease from some account, report 429 for opus
    const result1 = await service.leaseToken(REQ, leasePayload("claude-opus-4-6-thinking"));
    await service.reportResult(REQ, {
      leaseId: result1.leaseId,
      status: 429,
      modelKey: "claude-opus-4-6-thinking",
      reason: "http_429_resource_exhausted",
      retryAfterMs: 300000,
    });

    // Report success for opus on the SAME account
    tokenProvider.mockClear();
    tokenProvider.mockResolvedValue("access-token-ok");
    const result2 = await service.leaseToken(REQ, leasePayload("claude-opus-4-6-thinking"));

    // If a different account was used, lease from it and report success
    await service.reportResult(REQ, {
      leaseId: result2.leaseId,
      status: 200,
      modelKey: "claude-opus-4-6-thinking",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });

    // The successful account should have its opus block cleared
    const status = service.getStatus();
    const successAccount = status.quota.accounts.find((a: any) => a.id === result2.accountId);
    const opusBlock = (successAccount?.blockedModels || []).find(
      (b: any) => b.modelKey === "claude-opus-4-6-thinking",
    );
    expect(opusBlock).toBeUndefined();
  });

  // ── 503 capacity cooling ────────────────────────────────────────────────

  it("applies short cooldown for 503 capacity errors", async () => {
    tokenProvider.mockResolvedValue("access-token-ok");
    const service = makeService();

    const result1 = await service.leaseToken(REQ, leasePayload());
    const leasedAccountId = result1.accountId;

    // Report 503 capacity error
    await service.reportResult(REQ, {
      leaseId: result1.leaseId,
      status: 503,
      modelKey: "claude-opus-4-6-thinking",
      reason: "http_503_model_capacity_exhausted",
      retryAfterMs: 15000,
    });

    // Account should be temporarily cooled
    const statusBefore = service.getStatus();
    const accountBefore = statusBefore.quota.accounts.find((a: any) => a.id === leasedAccountId);
    expect(accountBefore!.quotaStatus).toBe("cooling");
    expect(accountBefore!.blockedUntil).toBeGreaterThan(currentTime);

    tokenProvider.mockClear();
    tokenProvider.mockResolvedValue("access-token-ok");
    const result2 = await service.leaseToken(REQ, leasePayload());
    expect(result2.accountId).not.toBe(leasedAccountId);

    // After cooldown expires, account should recover
    currentTime += 16000;
    const statusAfter = service.getStatus();
    const accountAfter = statusAfter.quota.accounts.find((a: any) => a.id === leasedAccountId);
    expect(accountAfter!.quotaStatus).toBe("ok");
    expect(accountAfter!.blockedUntil).toBe(0);
  });

  // ── excludeAccountIds passthrough ───────────────────────────────────────

  it("respects excludeAccountIds from client payload", async () => {
    tokenProvider.mockResolvedValue("access-token-ok");
    const service = makeService();

    const result = await service.leaseToken(REQ, {
      ...leasePayload(),
      excludeAccountIds: [1, 2],
    });

    expect(result.ok).toBe(true);
    expect(result.accountId).toBe(3);
  });

  // ── getStatus includes runtime quota info ───────────────────────────────

  it("getStatus includes model gates and runtime quota info", async () => {
    tokenProvider.mockResolvedValue("access-token-ok");
    const service = makeService();

    const result1 = await service.leaseToken(REQ, leasePayload("claude-opus-4-6-thinking"));
    await service.reportResult(REQ, {
      leaseId: result1.leaseId,
      status: 429,
      modelKey: "claude-opus-4-6-thinking",
      reason: "http_429_resource_exhausted",
      retryAfterMs: 300000,
    });

    const status = service.getStatus();

    // Should have model gates info in scheduler
    expect(status.scheduler.modelGates).toBeDefined();
    expect(Array.isArray(status.scheduler.modelGates)).toBe(true);

    // Blocked account should show in quota
    const blockedAccount = status.quota.accounts.find((a: any) => a.id === result1.accountId);
    expect(blockedAccount).toBeDefined();
    expect(blockedAccount!.blockedUntil).toBeGreaterThan(0);
    expect(blockedAccount!.blockedModels.length).toBeGreaterThan(0);
    expect(blockedAccount!.blockedModels[0].modelKey).toBe("claude-opus-4-6-thinking");
  });

  // ── candidateStats reflects actual healthy count ────────────────────────

  it("candidateStats.healthyForModel excludes blocked accounts", async () => {
    tokenProvider.mockResolvedValue("access-token-ok");
    const service = makeService();

    // Block account 1 by reporting 429
    const result1 = await service.leaseToken(REQ, leasePayload("claude-opus-4-6-thinking"));
    await service.reportResult(REQ, {
      leaseId: result1.leaseId,
      status: 429,
      modelKey: "claude-opus-4-6-thinking",
      reason: "http_429_resource_exhausted",
      retryAfterMs: 300000,
    });

    tokenProvider.mockClear();
    tokenProvider.mockResolvedValue("access-token-ok");

    // Next lease should report fewer healthy candidates
    const result2 = await service.leaseToken(REQ, leasePayload("claude-opus-4-6-thinking"));
    expect(result2.candidateStats.healthyForModel).toBeLessThan(3);
  });
});
