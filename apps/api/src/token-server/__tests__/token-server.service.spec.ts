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
