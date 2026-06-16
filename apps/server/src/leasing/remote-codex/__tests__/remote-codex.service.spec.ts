import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RemoteCodexService } from "../service/remote-codex.service";
import { sessionReqFor, withSessionResolver } from "../../token-server/__tests__/session-test-util";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("RemoteCodexService", () => {
  let tempDir: string;
  let accountsFilePath: string;
  let accessKeysFilePath: string;
  const tokenProvider = vi.fn();
  let currentTime: number;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-remote-codex-"));
    accountsFilePath = path.join(tempDir, "codex-accounts.json");
    accessKeysFilePath = path.join(tempDir, "access-keys.json");
    currentTime = Date.parse("2026-05-29T01:00:00.000Z");
    tokenProvider.mockReset();

    writeJson(accountsFilePath, {
      accounts: [
        {
          id: 11,
          email: "codex-alpha@example.com",
          refreshToken: "refresh-alpha",
          enabled: true,
          planType: "plus",
        },
      ],
    });
    writeJson(accessKeysFilePath, {
      keys: [
        {
          id: "codex-card-1",
          key: "codex-secret-card",
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
    return withSessionResolver(new RemoteCodexService({
      accountsFilePath,
      accessKeysFilePath,
      tokenProvider,
      now: () => currentTime,
      randomId: () => "codex-lease-fixed",
      minClientVersion: "",
    }));
  }

  it("returns independent codex account and card status", () => {
    const status = makeService().getStatus();

    expect(status.running).toBe(true);
    expect(status.mode).toBe("remote-codex-server");
    expect(status.activeLeases).toBe(0);
    expect(status.accounts.total).toBe(1);
    expect(status.accounts.enabled).toBe(1);
    expect(status.accessKeys.total).toBe(1);
    // Codex model catalog is surfaced in status.
    expect(status.models.some((m: any) => m.key === "gpt-5-codex")).toBe(true);
  });

  it("rejects lease-token when the codex card header credential is presented (removed)", async () => {
    const service = makeService();

    await expect(
      service.leaseToken(
        { headers: { "x-token-server-secret": "bad-card" } },
        { clientId: "client-a", modelKey: "gpt-5-codex" },
      ),
    ).rejects.toMatchObject({ statusCode: 401, message: "Missing access key" });
    expect(tokenProvider).not.toHaveBeenCalled();
  });

  it("leases a Codex OAuth access token from an enabled account", async () => {
    tokenProvider.mockResolvedValue("codex-access-token-alpha");
    const service = makeService();

    const result = await service.leaseToken(
      sessionReqFor("codex-card-1"),
      { clientId: "client-a", modelKey: "gpt-5-codex", bodyBytes: 2500 },
    );

    expect(result.ok).toBe(true);
    expect(result.leaseId).toBe("codex-lease-fixed");
    expect(result.accountId).toBe(11);
    expect(result.emailHint).toBe("co***@example.com");
    expect(result.accessToken).toBe("codex-access-token-alpha");
    expect(result.accessKeySessionId).toBeTruthy();
    expect(tokenProvider).toHaveBeenCalledWith(
      expect.objectContaining({ id: 11, refreshToken: "refresh-alpha" }),
    );
  });

  it("records usage against the codex card", async () => {
    tokenProvider.mockResolvedValue("codex-access-token-alpha");
    const service = makeService();
    await service.leaseToken(
      sessionReqFor("codex-card-1"),
      { clientId: "client-a", modelKey: "gpt-5-codex" },
    );

    const report = await service.reportResult(
      sessionReqFor("codex-card-1"),
      {
        leaseId: "codex-lease-fixed",
        status: 200,
        modelKey: "gpt-5-codex",
        inputTokens: 120,
        outputTokens: 40,
        totalTokens: 160,
      },
    );

    expect(report.ok).toBe(true);
    // 累计计数已下线;用量进入限流窗口(内存)+ CardUsageHourly(DB,本测试未接)。
    expect(report.accessKeyStatus.recentWindowTokens).toBe(160);
    expect((service as any).accessKeyStore.findById("codex-card-1").tokenUsageEvents.length).toBe(1);
  });

  it("cools down a Codex account after quota status reports", async () => {
    tokenProvider.mockResolvedValue("codex-access-token-alpha");
    const service = makeService();
    await service.leaseToken(
      sessionReqFor("codex-card-1"),
      { clientId: "client-a", modelKey: "gpt-5-codex" },
    );

    await service.reportResult(
      sessionReqFor("codex-card-1"),
      { leaseId: "codex-lease-fixed", status: 429, modelKey: "gpt-5-codex" },
    );

    tokenProvider.mockClear();
    await expect(
      service.leaseToken(
        sessionReqFor("codex-card-1"),
        { clientId: "client-a", modelKey: "gpt-5-codex" },
      ),
    ).rejects.toMatchObject({ statusCode: 503, message: "No available Codex accounts" });
    expect(tokenProvider).not.toHaveBeenCalled();
  });
});

// ── Capabilities inherited from the generic LeaseService (new for Codex) ──────
describe("RemoteCodexService — inherited multi-account behavior", () => {
  let tempDir: string;
  let accountsFilePath: string;
  let accessKeysFilePath: string;
  const tokenProvider = vi.fn();
  let currentTime: number;
  let leaseCounter: number;

  const REQ = sessionReqFor("codex-card-1");

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-remote-codex-multi-"));
    accountsFilePath = path.join(tempDir, "codex-accounts.json");
    accessKeysFilePath = path.join(tempDir, "access-keys.json");
    currentTime = Date.parse("2026-05-29T01:00:00.000Z");
    leaseCounter = 0;
    tokenProvider.mockReset();

    writeJson(accountsFilePath, {
      accounts: [
        { id: 11, email: "codex-a@example.com", refreshToken: "rt-a", enabled: true },
        { id: 12, email: "codex-b@example.com", refreshToken: "rt-b", enabled: true },
        { id: 13, email: "codex-c@example.com", refreshToken: "rt-c", enabled: true },
      ],
    });
    writeJson(accessKeysFilePath, {
      keys: [{ id: "codex-card-1", key: "codex-secret-card", status: "active", durationMs: 24 * 60 * 60 * 1000, windowLimit: 100 }],
    });
  });

  afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  function makeService() {
    return withSessionResolver(new RemoteCodexService({
      accountsFilePath, accessKeysFilePath, tokenProvider,
      now: () => currentTime, randomId: () => `codex-lease-${++leaseCounter}`, minClientVersion: "",
    }));
  }

  it("retries the next Codex account when the first token refresh fails", async () => {
    tokenProvider
      .mockRejectedValueOnce(new Error("Transient network error"))
      .mockResolvedValueOnce("codex-token-ok");
    const service = makeService();

    const result = await service.leaseToken(REQ, { clientId: "c", modelKey: "gpt-5-codex" });

    expect(result.ok).toBe(true);
    expect(result.accessToken).toBe("codex-token-ok");
    expect(tokenProvider).toHaveBeenCalledTimes(2);
  });

  it("cools a Codex account per-model: blocked model 429 leaves other models usable", async () => {
    tokenProvider.mockResolvedValue("codex-token-ok");
    // Single account so selection is deterministic.
    writeJson(accountsFilePath, { accounts: [{ id: 11, email: "codex-a@example.com", refreshToken: "rt-a", enabled: true }] });
    const service = makeService();

    const r1 = await service.leaseToken(REQ, { clientId: "c", modelKey: "gpt-5-codex" });
    await service.reportResult(REQ, { leaseId: r1.leaseId, status: 429, modelKey: "gpt-5-codex" });

    // A different model on the same account is still usable (per-model gate).
    const r2 = await service.leaseToken(REQ, { clientId: "c", modelKey: "gpt-5.2-codex" });
    expect(r2.ok).toBe(true);
    expect(r2.accountId).toBe(11);

    // The blocked model is still 503 on the only account.
    await expect(
      service.leaseToken(REQ, { clientId: "c", modelKey: "gpt-5-codex" }),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});
