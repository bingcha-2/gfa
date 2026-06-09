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

function makeProvider(
  accountsFilePath: string,
  refreshTokenImpl: (account: any) => Promise<string> = async () => "tok",
): Provider<any> {
  return {
    id: "fake",
    accountsFilePath,
    refreshToken: vi.fn(refreshTokenImpl),
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
  } as unknown as Provider<any>;
}

const REQ = { headers: { "x-token-server-secret": "secret-card" } };

/**
 * A dead account (invalid_grant / repeated refresh failure) must have its
 * quotaStatus written to the accounts file — not just an in-memory Map — so it
 * survives a restart, stays out of the pool, and shows up red in the console.
 */
describe("dead account status persistence", () => {
  let tempDir: string;
  let accountsFilePath: string;
  let accessKeysFilePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-dead-acct-"));
    accountsFilePath = path.join(tempDir, "anthropic-accounts.json");
    accessKeysFilePath = path.join(tempDir, "access-keys.json");
    writeJson(accessKeysFilePath, {
      keys: [{ id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000 }],
    });
    writeJson(accountsFilePath, {
      accounts: [{ id: 1, email: "a@example.com", refreshToken: "rt-1", enabled: true }],
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes quotaStatus=error to the accounts file on invalid_grant", async () => {
    const provider = makeProvider(accountsFilePath, async () => {
      throw new Error('400 {"error":"invalid_grant","error_description":"refresh token revoked"}');
    });
    const service = new LeaseService(provider, { accessKeysFilePath, minClientVersion: "" });

    await expect(
      service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" }),
    ).rejects.toBeTruthy();

    service.flushAccounts();

    const onDisk = JSON.parse(fs.readFileSync(accountsFilePath, "utf8"));
    const a1 = onDisk.accounts.find((a: any) => a.id === 1);
    expect(a1.quotaStatus).toBe("error");
    expect(a1.quotaStatusReason).toBe("invalid_grant");
  });

  it("re-hydrates persisted dead status on init so the account stays out of the pool", async () => {
    // Restart scenario: the file already marks the only account dead.
    writeJson(accountsFilePath, {
      accounts: [
        {
          id: 1,
          email: "a@example.com",
          refreshToken: "rt-1",
          enabled: true,
          quotaStatus: "error",
          quotaStatusReason: "invalid_grant",
          blockedUntil: Date.now() + 60 * 60 * 1000,
        },
      ],
    });
    // Refresh WOULD succeed — proving the skip is driven by persisted status, not a live failure.
    const provider = makeProvider(accountsFilePath, async () => "access-token");
    const service = new LeaseService(provider, { accessKeysFilePath, minClientVersion: "" });
    await service.onModuleInit();

    await expect(
      service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" }),
    ).rejects.toBeTruthy();
  });

  it("retries a cooled-down dead account and clears its persisted status on success", async () => {
    // The cooldown window has already passed → the account deserves one retry.
    writeJson(accountsFilePath, {
      accounts: [
        {
          id: 1,
          email: "a@example.com",
          refreshToken: "rt-1",
          enabled: true,
          quotaStatus: "error",
          quotaStatusReason: "invalid_grant",
          blockedUntil: Date.now() - 1000,
        },
      ],
    });
    const provider = makeProvider(accountsFilePath, async () => "access-token"); // re-auth fixed it
    const service = new LeaseService(provider, { accessKeysFilePath, minClientVersion: "" });
    await service.onModuleInit();

    const res = await service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" });
    expect(res.ok).toBe(true); // cooled-down account is retried, not blocked forever

    service.flushAccounts();
    const onDisk = JSON.parse(fs.readFileSync(accountsFilePath, "utf8"));
    const a1 = onDisk.accounts.find((a: any) => a.id === 1);
    expect(a1.quotaStatus).not.toBe("error"); // success un-marked the dead status
  });
});
