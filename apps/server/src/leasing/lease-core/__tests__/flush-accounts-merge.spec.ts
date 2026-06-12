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

/**
 * Regression: a refresh rotates the account's refresh_token into the in-memory
 * cache (via mutateAccount). If an external writer (the admin panel) touches the
 * same accounts file before the debounced flush lands, flushAccounts must NOT
 * discard the buffer — the rotated refresh_token would be lost and the account
 * dies a few days later (invalid_grant). The flush must MERGE: disk as base,
 * in-memory token fields layered back on top.
 */
describe("flushAccounts merge-on-external-change", () => {
  let tempDir: string;
  let accountsFilePath: string;
  let accessKeysFilePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-flush-merge-"));
    accountsFilePath = path.join(tempDir, "anthropic-accounts.json");
    accessKeysFilePath = path.join(tempDir, "access-keys.json");
    writeJson(accessKeysFilePath, { keys: [] });
    writeJson(accountsFilePath, {
      accounts: [
        { id: 1, email: "a@example.com", refreshToken: "rt-1", enabled: true },
        { id: 2, email: "b@example.com", refreshToken: "rt-2", enabled: true },
      ],
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeService() {
    return withSessionResolver(new LeaseService(makeProvider(accountsFilePath), {
      accessKeysFilePath,
      minClientVersion: "",
    }));
  }

  it("keeps the in-memory rotated refreshToken AND the external field after flush", () => {
    const service = makeService();

    // A refresh rotated account 1's refresh_token into the in-memory cache.
    service.mutateAccount(1, (a: any) => ({ ...a, refreshToken: "rt-1-rotated" }));

    // The admin panel writes the SAME file (e.g. sets a proxy on account 2),
    // bumping its mtime so the next flush sees an "external modification".
    writeJson(accountsFilePath, {
      accounts: [
        { id: 1, email: "a@example.com", refreshToken: "rt-1", enabled: true },
        { id: 2, email: "b@example.com", refreshToken: "rt-2", enabled: true, proxyUrl: "socks5://x" },
      ],
    });
    const future = Date.now() / 1000 + 10;
    fs.utimesSync(accountsFilePath, future, future);

    service.flushAccounts();

    const onDisk = JSON.parse(fs.readFileSync(accountsFilePath, "utf8"));
    const a1 = onDisk.accounts.find((a: any) => a.id === 1);
    const a2 = onDisk.accounts.find((a: any) => a.id === 2);

    // In-memory rotated token must survive (today it is discarded → "rt-1").
    expect(a1.refreshToken).toBe("rt-1-rotated");
    // The external writer's field must survive too (proves it merged, not clobbered).
    expect(a2.proxyUrl).toBe("socks5://x");
  });
});

/**
 * A rotated refresh_token must reach disk immediately on a successful lease, not
 * sit in the 60s debounce window where a crash (or an external write that the
 * merge can't see yet) could still lose it.
 */
describe("leaseToken persists a rotated refreshToken immediately", () => {
  let tempDir: string;
  let accountsFilePath: string;
  let accessKeysFilePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-flush-rotate-"));
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

  it("writes the rotated refreshToken to disk without waiting for the debounce", async () => {
    const provider = makeProvider(accountsFilePath, async (account: any) => {
      account.refreshToken = "rt-1-rotated"; // upstream rotated the refresh_token
      account.accessTokenExpiresAt = Date.now() + 60 * 60 * 1000;
      return "access-token";
    });
    const service = withSessionResolver(new LeaseService(provider, { accessKeysFilePath, minClientVersion: "" }));

    const res = await service.leaseToken(
      sessionReqFor("card-1"),
      { clientId: "c1", modelKey: "gpt-5-codex" },
    );
    expect(res.ok).toBe(true);

    // Do NOT call flushAccounts(): the rotation must already be persisted.
    const onDisk = JSON.parse(fs.readFileSync(accountsFilePath, "utf8"));
    expect(onDisk.accounts.find((a: any) => a.id === 1).refreshToken).toBe("rt-1-rotated");
  });
});
