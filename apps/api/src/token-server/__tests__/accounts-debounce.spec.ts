import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TokenServerService } from "../token-server.service";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

describe("TokenServerService — debounced accounts writes", () => {
  let tempDir: string;
  let accountsFilePath: string;
  let accessKeysFilePath: string;
  const tokenProvider = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-debounce-test-"));
    accountsFilePath = path.join(tempDir, "accounts.json");
    accessKeysFilePath = path.join(tempDir, "access-keys.json");
    tokenProvider.mockReset();

    writeJson(accountsFilePath, {
      accounts: [
        { id: 1, email: "a@test.com", refreshToken: "rt1", projectId: "p1", enabled: true },
        { id: 2, email: "b@test.com", refreshToken: "rt2", projectId: "p2", enabled: true },
      ],
    });
    writeJson(accessKeysFilePath, {
      keys: [{ id: "k1", key: "secret", status: "active", durationMs: 3600000, windowLimit: 10 }],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeService() {
    return new TokenServerService({
      accountsFilePath,
      accessKeysFilePath,
      tokenProvider,
      now: () => Date.now(),
    });
  }

  it("mutateAccount modifies in-memory data without writing to disk", () => {
    const service = makeService();

    // Read initial file mtime
    const mtimeBefore = fs.statSync(accountsFilePath).mtimeMs;

    // mutateAccount should change memory but not disk
    service.mutateAccount(1, (account: any) => ({ ...account, planType: "ultra" }));

    // Disk should be unchanged
    const mtimeAfter = fs.statSync(accountsFilePath).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);

    // But memory should reflect the change
    const status = service.getStatus();
    const acct = status.quota.accounts.find((a: any) => a.id === 1);
    expect(acct.planType).toBe("ultra");
  });

  it("flushAccounts writes dirty data to disk", () => {
    const service = makeService();

    service.mutateAccount(1, (account: any) => ({ ...account, planType: "ultra" }));

    // Flush to disk
    service.flushAccounts();

    // Verify disk has the update
    const data = readJson(accountsFilePath);
    const acct = data.accounts.find((a: any) => a.id === 1);
    expect(acct.planType).toBe("ultra");
  });

  it("multiple mutates within flush window produce only one disk write", () => {
    const service = makeService();
    const mtimeBefore = fs.statSync(accountsFilePath).mtimeMs;

    // Multiple mutations
    service.mutateAccount(1, (a: any) => ({ ...a, planType: "ultra" }));
    service.mutateAccount(2, (a: any) => ({ ...a, planType: "free" }));
    service.mutateAccount(1, (a: any) => ({ ...a, planType: "premium" }));

    // Disk unchanged before flush
    expect(fs.statSync(accountsFilePath).mtimeMs).toBe(mtimeBefore);

    // Manual flush
    service.flushAccounts();

    // Disk has latest state for both accounts
    const data = readJson(accountsFilePath);
    expect(data.accounts.find((a: any) => a.id === 1).planType).toBe("premium");
    expect(data.accounts.find((a: any) => a.id === 2).planType).toBe("free");
  });

  it("does not write to disk when no mutations happened", () => {
    const service = makeService();
    const mtimeBefore = fs.statSync(accountsFilePath).mtimeMs;

    // Flush with nothing dirty
    service.flushAccounts();

    expect(fs.statSync(accountsFilePath).mtimeMs).toBe(mtimeBefore);
  });

  it("discards dirty buffer when external file modification detected during flush", () => {
    const service = makeService();

    // Mutate in memory
    service.mutateAccount(1, (a: any) => ({ ...a, planType: "ultra" }));

    // Simulate external file replacement (e.g., user manually editing)
    writeJson(accountsFilePath, {
      accounts: [
        { id: 1, email: "a@test.com", refreshToken: "rt1", projectId: "p1", enabled: true, planType: "external" },
        { id: 2, email: "b@test.com", refreshToken: "rt2", projectId: "p2", enabled: true },
        { id: 3, email: "c@test.com", refreshToken: "rt3", projectId: "p3", enabled: true },
      ],
    });

    // Flush should detect mtime mismatch and reload from disk instead
    service.flushAccounts();

    // Memory should now reflect the external file (3 accounts, planType "external")
    const status = service.getStatus();
    expect(status.quota.accounts).toHaveLength(3);
    const acct = status.quota.accounts.find((a: any) => a.id === 1);
    expect(acct.planType).toBe("external");
  });

  it("after external modification, next mutate uses fresh data", () => {
    const service = makeService();

    // Mutate + detect external change via flush
    service.mutateAccount(1, (a: any) => ({ ...a, planType: "stale" }));

    // External replacement adds account 3
    writeJson(accountsFilePath, {
      accounts: [
        { id: 1, email: "a@test.com", refreshToken: "rt1", projectId: "p1", enabled: true },
        { id: 2, email: "b@test.com", refreshToken: "rt2", projectId: "p2", enabled: true },
        { id: 3, email: "c@test.com", refreshToken: "rt3", projectId: "p3", enabled: true },
      ],
    });

    // Flush discards dirty buffer
    service.flushAccounts();

    // New mutation should work on the fresh 3-account data
    service.mutateAccount(3, (a: any) => ({ ...a, planType: "new" }));
    service.flushAccounts();

    const data = readJson(accountsFilePath);
    expect(data.accounts).toHaveLength(3);
    expect(data.accounts.find((a: any) => a.id === 3).planType).toBe("new");
  });
});
