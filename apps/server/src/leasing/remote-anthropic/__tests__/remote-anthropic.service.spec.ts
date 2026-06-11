import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RemoteAnthropicService } from "../service/remote-anthropic.service";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("RemoteAnthropicService", () => {
  let tempDir: string;
  let accountsFilePath: string;
  let accessKeysFilePath: string;
  const tokenProvider = vi.fn();
  let currentTime: number;

  const MODEL = "claude-opus-4-20250514";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-remote-anthropic-"));
    accountsFilePath = path.join(tempDir, "claude-accounts.json");
    accessKeysFilePath = path.join(tempDir, "access-keys.json");
    currentTime = Date.parse("2026-05-29T01:00:00.000Z");
    tokenProvider.mockReset();

    writeJson(accountsFilePath, {
      accounts: [
        {
          id: 21,
          email: "claude-alpha@example.com",
          refreshToken: "refresh-alpha",
          enabled: true,
          planType: "max",
        },
      ],
    });
    writeJson(accessKeysFilePath, {
      keys: [
        {
          id: "claude-card-1",
          key: "claude-secret-card",
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
    return new RemoteAnthropicService({
      accountsFilePath,
      accessKeysFilePath,
      tokenProvider,
      now: () => currentTime,
      randomId: () => "claude-lease-fixed",
      minClientVersion: "",
    });
  }

  it("returns independent claude account and card status", () => {
    const status = makeService().getStatus();

    expect(status.running).toBe(true);
    expect(status.mode).toBe("remote-anthropic-server");
    expect(status.activeLeases).toBe(0);
    expect(status.accounts.total).toBe(1);
    expect(status.accounts.enabled).toBe(1);
    expect(status.accessKeys.total).toBe(1);
    // Claude model catalog is surfaced in status.
    expect(status.models.some((m: any) => m.key === MODEL)).toBe(true);
  });

  it("rejects lease-token when the claude card is invalid", async () => {
    const service = makeService();

    await expect(
      service.leaseToken(
        { headers: { "x-token-server-secret": "bad-card" } },
        { clientId: "client-a", modelKey: MODEL },
      ),
    ).rejects.toMatchObject({ statusCode: 401, message: "Invalid access key" });
    expect(tokenProvider).not.toHaveBeenCalled();
  });

  it("leases a Claude OAuth access token from an enabled account", async () => {
    tokenProvider.mockResolvedValue("claude-access-token-alpha");
    const service = makeService();

    const result = await service.leaseToken(
      { headers: { "x-token-server-secret": "claude-secret-card" } },
      { clientId: "client-a", modelKey: MODEL, bodyBytes: 2500 },
    );

    expect(result.ok).toBe(true);
    expect(result.leaseId).toBe("claude-lease-fixed");
    expect(result.accountId).toBe(21);
    expect(result.accessToken).toBe("claude-access-token-alpha");
    expect(result.accessKeySessionId).toBeTruthy();
    // The provider now hands the refresher a disk re-reader (reload) so it can
    // adopt a token another writer just rotated instead of double-burning one.
    expect(tokenProvider).toHaveBeenCalledWith(
      expect.objectContaining({ id: 21, refreshToken: "refresh-alpha" }),
      expect.objectContaining({ reload: expect.any(Function) }),
    );
  });

  it("records usage against the claude card (opus bucket)", async () => {
    tokenProvider.mockResolvedValue("claude-access-token-alpha");
    const service = makeService();
    await service.leaseToken(
      { headers: { "x-token-server-secret": "claude-secret-card" } },
      { clientId: "client-a", modelKey: MODEL },
    );

    const report = await service.reportResult(
      { headers: { "x-token-server-secret": "claude-secret-card" } },
      {
        leaseId: "claude-lease-fixed",
        status: 200,
        modelKey: MODEL,
        inputTokens: 120,
        outputTokens: 40,
        totalTokens: 160,
      },
    );

    expect(report.ok).toBe(true);
    expect(report.accessKeyStatus.totalTokensUsed).toBe(160);
    service.flushAccessKeys();
    const stored = JSON.parse(fs.readFileSync(accessKeysFilePath, "utf8"));
    expect(stored.keys[0].totalTokensUsed).toBe(160);
    expect(stored.keys[0].totalRequests).toBe(1);
  });

  it("cools down a Claude account after a 429 quota status report", async () => {
    tokenProvider.mockResolvedValue("claude-access-token-alpha");
    const service = makeService();
    await service.leaseToken(
      { headers: { "x-token-server-secret": "claude-secret-card" } },
      { clientId: "client-a", modelKey: MODEL },
    );

    await service.reportResult(
      { headers: { "x-token-server-secret": "claude-secret-card" } },
      { leaseId: "claude-lease-fixed", status: 429, modelKey: MODEL },
    );

    tokenProvider.mockClear();
    await expect(
      service.leaseToken(
        { headers: { "x-token-server-secret": "claude-secret-card" } },
        { clientId: "client-a", modelKey: MODEL },
      ),
    ).rejects.toMatchObject({ statusCode: 503, message: "No available Claude accounts" });
    expect(tokenProvider).not.toHaveBeenCalled();
  });
});
