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
    expect(result.projectId).toBeUndefined();
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
