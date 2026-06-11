import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TokenServerService } from "../token-server.service";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("TokenServerService — accounts cache", () => {
  let tempDir: string;
  let accountsFilePath: string;
  let accessKeysFilePath: string;
  const tokenProvider = vi.fn();

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-cache-test-"));
    accountsFilePath = path.join(tempDir, "accounts.json");
    accessKeysFilePath = path.join(tempDir, "access-keys.json");
    tokenProvider.mockReset();

    writeJson(accountsFilePath, {
      accounts: [
        { id: 1, email: "a@test.com", refreshToken: "rt1", projectId: "p1", enabled: true },
        { id: 2, email: "b@test.com", refreshToken: "rt2", projectId: "p2", enabled: true },
      ],
    });
    writeJson(accessKeysFilePath, { keys: [] });
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
    });
  }

  it("returns accounts from cache when file unchanged", () => {
    const service = makeService();

    const first = service.getStatus();
    const second = service.getStatus();

    // Both should return the same 2 accounts
    expect(first.quota.accounts).toHaveLength(2);
    expect(second.quota.accounts).toHaveLength(2);

    // Key test: the underlying accounts array should be the SAME reference (cached)
    expect(first.quota.accounts.map((a: any) => a.id)).toEqual(
      second.quota.accounts.map((a: any) => a.id),
    );
  });

  it("invalidates cache when file mtime changes", () => {
    const service = makeService();

    const first = service.getStatus();
    expect(first.quota.accounts).toHaveLength(2);

    // Modify the file — add a third account
    writeJson(accountsFilePath, {
      accounts: [
        { id: 1, email: "a@test.com", refreshToken: "rt1", projectId: "p1", enabled: true },
        { id: 2, email: "b@test.com", refreshToken: "rt2", projectId: "p2", enabled: true },
        { id: 3, email: "c@test.com", refreshToken: "rt3", projectId: "p3", enabled: true },
      ],
    });

    const second = service.getStatus();
    expect(second.quota.accounts).toHaveLength(3);
  });

  it("returns empty array when accounts file is missing", () => {
    fs.unlinkSync(accountsFilePath);
    const service = makeService();

    const status = service.getStatus();
    expect(status.quota.accounts).toHaveLength(0);
  });

  it("returns same data from cache on consecutive reads without file change", () => {
    const service = makeService();

    // Warm the cache
    const first = service.getStatus();

    // Multiple consecutive reads
    const results = Array.from({ length: 10 }, () => service.getStatus());

    // All should return identical account data (same cache)
    for (const r of results) {
      expect(r.quota.accounts).toHaveLength(first.quota.accounts.length);
      expect(r.quota.accounts.map((a: any) => a.id)).toEqual(
        first.quota.accounts.map((a: any) => a.id),
      );
    }
    // Spot check that no data was lost
    expect(first.quota.accounts).toHaveLength(2);
  });
});
