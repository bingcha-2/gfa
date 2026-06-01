import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RosettaService } from "../rosetta.service";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("RosettaService", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-rosetta-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("lists access keys with full key, masked key, and token window totals", () => {
    writeJson(path.join(tempDir, "access-keys.json"), {
      keys: [
        {
          id: "card-1",
          key: "bcai_1234567890",
          name: "VIP",
          status: "active",
          tokenWindowLimit: 1000,
          tokenUsageEvents: [{ at: Date.now(), totalTokens: 120, modelKey: "gemini" }],
          totalRequests: 2,
          totalTokensUsed: 500,
        },
      ],
    });

    const result = new RosettaService({ dataDir: tempDir }).listAccessKeys({});

    expect(result.keys).toHaveLength(1);
    expect(result.keys[0]).toMatchObject({
      id: "card-1",
      name: "VIP",
      fullKey: "bcai_1234567890",
      key: "bc***90",
      status: "active",
      recentWindowTokens: 120,
      tokenWindowLimit: 1000,
      totalRequests: 2,
      totalTokensUsed: 500,
    });
  });

  it("mints a universal card with the token-window limit persisted", () => {
    const svc = new RosettaService({ dataDir: tempDir });
    svc.createAccessKey({ name: "VIP", tokenWindowLimit: 100000 });

    const stored = JSON.parse(fs.readFileSync(path.join(tempDir, "access-keys.json"), "utf8"));
    const rec = stored.keys[0];
    expect(rec.tokenWindowLimit).toBe(100000);
  });

  it("persists a configurable rate-limit window (windowMs), defaulting to 5h", () => {
    const svc = new RosettaService({ dataDir: tempDir });
    // Explicit window (e.g. 3 days from the UI's hours/days selector).
    svc.createAccessKey({ name: "3d", tokenWindowLimit: 100000, windowMs: 3 * 24 * 60 * 60 * 1000 });
    // Omitted → defaults to the 5h window.
    svc.createAccessKey({ name: "default" });

    const stored = JSON.parse(fs.readFileSync(path.join(tempDir, "access-keys.json"), "utf8"));
    expect(stored.keys[0].windowMs).toBe(3 * 24 * 60 * 60 * 1000);
    expect(stored.keys[1].windowMs).toBe(5 * 60 * 60 * 1000);

    // Editable after creation.
    svc.updateAccessKey({ id: stored.keys[0].id, windowMs: 2 * 60 * 60 * 1000 });
    const after = JSON.parse(fs.readFileSync(path.join(tempDir, "access-keys.json"), "utf8"));
    expect(after.keys[0].windowMs).toBe(2 * 60 * 60 * 1000);
  });

  it("manages codex accounts in codex-accounts.json (add/list/toggle/delete)", () => {
    const svc = new RosettaService({ dataDir: tempDir });
    expect(svc.listCodexAccounts().accounts).toHaveLength(0);

    svc.addCodexAccount({ email: "c@x.com", refreshToken: "rt", planType: "plus" });
    const listed = svc.listCodexAccounts().accounts;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ email: "c@x.com", enabled: true, planType: "plus", hasToken: true });

    const id = listed[0].id;
    svc.toggleCodexAccount({ accountId: id });
    expect(svc.listCodexAccounts().accounts[0].enabled).toBe(false);

    svc.deleteCodexAccount({ accountId: id });
    expect(svc.listCodexAccounts().accounts).toHaveLength(0);

    // Written to codex-accounts.json, NOT the antigravity accounts.json.
    const stored = JSON.parse(fs.readFileSync(path.join(tempDir, "codex-accounts.json"), "utf8"));
    expect(Array.isArray(stored.accounts)).toBe(true);
  });

  it("imports a codex account from pasted text and keeps only supported fields", () => {
    const svc = new RosettaService({ dataDir: tempDir });
    const result = svc.importCodexAccountFromText({
      text: `后台的 codex 池能否支持 {"WARNING_BANNER":"secret","user":{"email":"codex@example.com","name":"Codex User"},"expires":"2026-08-28T03:53:24.296Z","account":{"planType":"plus"},"accessToken":"access-token-value","sessionToken":"session-token-value","ignoredField":"ignored"}`,
    });

    expect(result).toMatchObject({ ok: true, email: "codex@example.com", isUpdate: false, totalAccounts: 1 });

    const stored = JSON.parse(fs.readFileSync(path.join(tempDir, "codex-accounts.json"), "utf8"));
    expect(stored.accounts).toHaveLength(1);
    expect(stored.accounts[0]).toMatchObject({
      email: "codex@example.com",
      alias: "Codex User",
      planType: "plus",
      accessToken: "access-token-value",
      accessTokenExpiresAt: Date.parse("2026-08-28T03:53:24.296Z"),
      sessionToken: "session-token-value",
      enabled: true,
    });
    expect(stored.accounts[0]).not.toHaveProperty("WARNING_BANNER");
    expect(stored.accounts[0]).not.toHaveProperty("ignoredField");
  });

  it("updates an existing codex account when importing the same email", () => {
    const svc = new RosettaService({ dataDir: tempDir });
    svc.addCodexAccount({ email: "codex@example.com", refreshToken: "old", planType: "plus", alias: "Old" });

    const result = svc.importCodexAccountFromText({
      text: JSON.stringify({
        user: { email: "CODEX@example.com", name: "New Name" },
        account: { planType: "pro" },
        refreshToken: "new-refresh-token",
        accessToken: "new-access-token",
      }),
    });

    expect(result).toMatchObject({ ok: true, email: "CODEX@example.com", isUpdate: true, totalAccounts: 1 });

    const stored = JSON.parse(fs.readFileSync(path.join(tempDir, "codex-accounts.json"), "utf8"));
    expect(stored.accounts).toHaveLength(1);
    expect(stored.accounts[0]).toMatchObject({
      id: 1,
      email: "codex@example.com",
      alias: "New Name",
      planType: "pro",
      refreshToken: "new-refresh-token",
      accessToken: "new-access-token",
    });
  });

  it("imports a codex account from a sub2api accounts export", () => {
    const svc = new RosettaService({ dataDir: tempDir });
    const result = svc.importCodexAccountFromText({
      text: JSON.stringify({
        exported_at: "2026-05-30T04:45:54Z",
        proxies: [],
        accounts: [
          {
            name: "sub2api@example.com",
            platform: "openai",
            type: "oauth",
            credentials: {
              email: "sub2api@example.com",
              access_token: "sub2api-access",
              refresh_token: "sub2api-refresh",
              expires_at: "2026-06-09T04:05:35.000Z",
              plan_type: "plus",
            },
          },
        ],
        type: "sub2api-data",
        version: 1,
      }),
    });

    expect(result).toMatchObject({ ok: true, email: "sub2api@example.com", totalAccounts: 1 });
    const stored = JSON.parse(fs.readFileSync(path.join(tempDir, "codex-accounts.json"), "utf8"));
    expect(stored.accounts[0]).toMatchObject({
      email: "sub2api@example.com",
      alias: "sub2api@example.com",
      planType: "plus",
      accessToken: "sub2api-access",
      refreshToken: "sub2api-refresh",
      accessTokenExpiresAt: Date.parse("2026-06-09T04:05:35.000Z"),
    });
  });

  it("imports a codex account from a top-level array export", () => {
    const svc = new RosettaService({ dataDir: tempDir });
    const result = svc.importCodexAccountFromText({
      text: JSON.stringify([
        {
          access_token: "array-access",
          refresh_token: "array-refresh",
          email: "array@example.com",
          type: "codex",
          expired: "2026-06-09T04:05:35.000Z",
        },
      ]),
    });

    expect(result).toMatchObject({ ok: true, email: "array@example.com", totalAccounts: 1 });
    const stored = JSON.parse(fs.readFileSync(path.join(tempDir, "codex-accounts.json"), "utf8"));
    expect(stored.accounts[0]).toMatchObject({
      email: "array@example.com",
      accessToken: "array-access",
      refreshToken: "array-refresh",
      accessTokenExpiresAt: Date.parse("2026-06-09T04:05:35.000Z"),
    });
  });

  it("imports a codex account from a flat object with snake_case fields", () => {
    const svc = new RosettaService({ dataDir: tempDir });
    const result = svc.importCodexAccountFromText({
      text: JSON.stringify({
        access_token: "flat-access",
        refresh_token: "flat-refresh",
        email: "flat@example.com",
        type: "codex",
        expired: "2026-06-09T04:05:35.000Z",
      }),
    });

    expect(result).toMatchObject({ ok: true, email: "flat@example.com", totalAccounts: 1 });
    const stored = JSON.parse(fs.readFileSync(path.join(tempDir, "codex-accounts.json"), "utf8"));
    expect(stored.accounts[0]).toMatchObject({
      email: "flat@example.com",
      accessToken: "flat-access",
      refreshToken: "flat-refresh",
      accessTokenExpiresAt: Date.parse("2026-06-09T04:05:35.000Z"),
    });
  });

  it("rejects codex imports that do not contain an email or usable token", () => {
    const svc = new RosettaService({ dataDir: tempDir });

    expect(svc.importCodexAccountFromText({ text: '{"user":{"name":"No Email"},"accessToken":"token"}' })).toMatchObject({
      ok: false,
      error: "email 不能为空",
    });
    expect(svc.importCodexAccountFromText({ text: '{"user":{"email":"codex@example.com"}}' })).toMatchObject({
      ok: false,
      error: "缺少可用 token",
    });
  });

  it("mints multiple cards when count > 1", () => {
    const svc = new RosettaService({ dataDir: tempDir });
    const result: any = svc.createAccessKey({ count: 3, tokenWindowLimit: 1000 });

    expect(result.ok).toBe(true);
    expect(Array.isArray(result.keys)).toBe(true);
    expect(result.keys).toHaveLength(3);
    // distinct keys
    const fullKeys = result.keys.map((k: any) => k.fullKey);
    expect(new Set(fullKeys).size).toBe(3);

    const stored = JSON.parse(fs.readFileSync(path.join(tempDir, "access-keys.json"), "utf8"));
    expect(stored.keys).toHaveLength(3);
  });

  it("updates tokenWindowLimit on an existing card", () => {
    const svc = new RosettaService({ dataDir: tempDir });
    svc.createAccessKey({ id: "c1", name: "x", tokenWindowLimit: 1 });
    svc.updateAccessKey({ id: "c1", tokenWindowLimit: 777 });

    const stored = JSON.parse(fs.readFileSync(path.join(tempDir, "access-keys.json"), "utf8"));
    expect(stored.keys[0].tokenWindowLimit).toBe(777);
  });

  it("filters access keys by search term", () => {
    writeJson(path.join(tempDir, "access-keys.json"), {
      keys: [
        { id: "card-1", key: "alpha", name: "Alpha", status: "active" },
        { id: "card-2", key: "beta", name: "Beta", status: "disabled" },
      ],
    });

    const result = new RosettaService({ dataDir: tempDir }).listAccessKeys({ search: "disabled" });

    expect(result.keys.map((item) => item.id)).toEqual(["card-2"]);
  });

  it("lists employees and submitted accounts with employee stats", () => {
    writeJson(path.join(tempDir, "employees.json"), {
      employees: [
        { id: "emp-1", email: "worker@example.com", status: "active", createdAt: "2026-01-01T00:00:00.000Z" },
      ],
      accounts: [
        { id: "acct-1", employeeId: "emp-1", email: "a@example.com", status: "accepted", projectId: "p1" },
        { id: "acct-2", employeeId: "emp-1", email: "b@example.com", status: "failed", projectId: "" },
      ],
      sessions: [],
    });

    const result = new RosettaService({ dataDir: tempDir }).listEmployees();

    expect(result.employees).toHaveLength(1);
    expect(result.employees[0].stats).toMatchObject({ total: 2, accepted: 1, failed: 1 });
    expect(result.accounts).toHaveLength(2);
  });

  it("adds, updates, toggles, and deletes rosetta accounts without exposing refresh tokens", () => {
    const service = new RosettaService({ dataDir: tempDir });

    expect(service.addAccount({
      email: "alpha@example.com",
      refreshToken: "refresh-alpha",
      alias: "Alpha",
      projectId: "project-alpha",
    })).toMatchObject({ ok: true, isUpdate: false, totalAccounts: 1 });

    const list = service.listAccounts();
    expect(list.accounts).toHaveLength(1);
    expect(list.accounts[0]).toMatchObject({
      email: "alpha@example.com",
      alias: "Alpha",
      projectId: "project-alpha",
      hasToken: true,
    });
    expect(list.accounts[0]).not.toHaveProperty("refreshToken");

    expect(service.addAccount({
      email: "alpha@example.com",
      refreshToken: "refresh-new",
      alias: "Renamed",
      enabled: false,
    })).toMatchObject({ ok: true, isUpdate: true, totalAccounts: 1 });
    expect(service.toggleAccount({ accountId: 1 })).toMatchObject({ ok: true, enabled: true });
    expect(service.deleteAccount({ accountId: 1 })).toMatchObject({ ok: true, totalAccounts: 0 });
  });

  it("creates, updates, and deletes access keys", () => {
    const service = new RosettaService({ dataDir: tempDir });

    const created = service.createAccessKey({
      name: "Ops",
      durationMs: 3600000,
      windowLimit: 10,
      tokenWindowLimit: 2000,
    });

    expect(created.ok).toBe(true);
    expect(created.key.fullKey).toMatch(/^BCAI-/);
    expect(service.listAccessKeys({}).keys).toHaveLength(1);

    expect(service.updateAccessKey({ id: created.key.id, name: "VIP", status: "disabled" })).toMatchObject({
      ok: true,
      key: { name: "VIP", status: "disabled" },
    });
    expect(service.deleteAccessKey({ id: created.key.id })).toMatchObject({ ok: true, totalKeys: 0 });
  });

  it("reads, saves, and deletes throttle config", () => {
    const service = new RosettaService({ dataDir: tempDir });

    expect(service.getThrottleConfig()).toMatchObject({ ok: true, config: null });
    expect(service.saveThrottleConfig({ config: { maxConcurrent: 2 } })).toMatchObject({ ok: true, saved: true });
    expect(service.getThrottleConfig()).toMatchObject({ ok: true, config: { maxConcurrent: 2 } });
    expect(service.saveThrottleConfig({ delete: true })).toMatchObject({ ok: true, deleted: true });
    expect(service.getThrottleConfig()).toMatchObject({ ok: true, config: null });
  });

  it("cleanupExpiredKeys removes expired keys and keeps active ones", () => {
    const now = Date.now();
    writeJson(path.join(tempDir, "access-keys.json"), {
      keys: [
        // Explicitly expired status
        { id: "k1", key: "key1", status: "expired", createdAt: new Date(now - 86400000).toISOString() },
        // Expired by firstUsedAt + durationMs (used 2 hours ago, duration 1 hour)
        {
          id: "k2", key: "key2", status: "active",
          firstUsedAt: new Date(now - 7200000).toISOString(),
          durationMs: 3600000,
          createdAt: new Date(now - 86400000).toISOString(),
        },
        // Still active (used 30 min ago, duration 1 hour)
        {
          id: "k3", key: "key3", status: "active",
          firstUsedAt: new Date(now - 1800000).toISOString(),
          durationMs: 3600000,
          createdAt: new Date(now - 86400000).toISOString(),
        },
        // Never used, no duration — should be kept
        { id: "k4", key: "key4", status: "active", createdAt: new Date(now).toISOString() },
      ],
    });

    const service = new RosettaService({ dataDir: tempDir });
    const result = service.cleanupExpiredKeys();

    expect(result).toMatchObject({ ok: true, deleted: 2 });
    const remaining = service.listAccessKeys({});
    expect(remaining.keys.map((k) => k.id)).toEqual(["k3", "k4"]);
  });

  it("cleanupExpiredKeys returns deleted:0 when no expired keys exist", () => {
    writeJson(path.join(tempDir, "access-keys.json"), {
      keys: [
        { id: "k1", key: "key1", status: "active", createdAt: new Date().toISOString() },
      ],
    });

    const result = new RosettaService({ dataDir: tempDir }).cleanupExpiredKeys();
    expect(result).toMatchObject({ ok: true, deleted: 0 });
  });

  it("cleanupUnboundKeys removes keys without sessionClientId", () => {
    writeJson(path.join(tempDir, "access-keys.json"), {
      keys: [
        // No sessionClientId
        { id: "k1", key: "key1", status: "active" },
        // Empty string sessionClientId
        { id: "k2", key: "key2", status: "active", sessionClientId: "" },
        // Whitespace-only sessionClientId
        { id: "k3", key: "key3", status: "active", sessionClientId: "  " },
        // Has a real sessionClientId — should be kept
        { id: "k4", key: "key4", status: "active", sessionClientId: "client-abc-123" },
      ],
    });

    const service = new RosettaService({ dataDir: tempDir });
    const result = service.cleanupUnboundKeys();

    expect(result).toMatchObject({ ok: true, deleted: 3 });
    const remaining = service.listAccessKeys({});
    expect(remaining.keys.map((k) => k.id)).toEqual(["k4"]);
  });

  it("cleanupUnboundKeys returns deleted:0 when all keys have clients", () => {
    writeJson(path.join(tempDir, "access-keys.json"), {
      keys: [
        { id: "k1", key: "key1", status: "active", sessionClientId: "client-1" },
      ],
    });

    const result = new RosettaService({ dataDir: tempDir }).cleanupUnboundKeys();
    expect(result).toMatchObject({ ok: true, deleted: 0 });
  });

  describe("adspowerImport", () => {
    function makeMocks(opts: { taskId?: string } = {}) {
      const automation = {
        startAutomation: vi.fn(async () => ({ taskId: opts.taskId ?? "task-1" })),
        getTaskStatus: vi.fn(async () => ({ status: "RUNNING" })),
      };
      const agentAccounts = {
        ensureAgentAccount: vi.fn(async () => "agent-1"),
        uploadToRosetta: vi.fn(async () => ({ added: 1 })),
      };
      return { automation, agentAccounts };
    }

    function readBatch() {
      return JSON.parse(fs.readFileSync(path.join(tempDir, "adspower-import.json"), "utf8"));
    }

    it("rejects an empty credentials array", async () => {
      const svc = new RosettaService({ dataDir: tempDir });
      expect(await svc.adspowerImport({ credentials: [] })).toMatchObject({ ok: false });
    });

    it("rejects when the automation service is unavailable", async () => {
      const svc = new RosettaService({ dataDir: tempDir });
      const result = await svc.adspowerImport({ credentials: [{ email: "a@x.com", password: "pw" }] });
      expect(result).toMatchObject({ ok: false, error: "automation service unavailable" });
    });

    it("ensures an agent account and enqueues an oauth task per credential", async () => {
      const { automation, agentAccounts } = makeMocks();
      const svc = new RosettaService({ dataDir: tempDir }, automation as any, agentAccounts as any);

      const result = await svc.adspowerImport({
        credentials: [
          { email: "a@x.com", password: "pw1", recoveryEmail: "r@x.com", totpSecret: "SEC" },
          { email: "b@x.com", password: "pw2", phones: [{ phoneNumber: "+123", smsUrl: "http://sms" }] },
        ],
      });

      expect(result.ok).toBe(true);
      expect(agentAccounts.ensureAgentAccount).toHaveBeenCalledTimes(2);
      expect(automation.startAutomation).toHaveBeenCalledTimes(2);
      // source must be the auto-import flag so the worker uses attempts:1 semantics
      expect(automation.startAutomation).toHaveBeenCalledWith(
        "oauth",
        expect.objectContaining({ email: "a@x.com", password: "pw1" }),
        undefined,
        undefined,
        expect.objectContaining({ source: "rosetta-account-auto-import" }),
      );

      const batch = readBatch();
      expect(batch.total).toBe(2);
      expect(batch.done).toBe(false);
      expect(batch.items).toHaveLength(2);
      expect(batch.items[0]).toMatchObject({ email: "a@x.com", taskId: "task-1", agentAccountId: "agent-1", status: "running" });
    });

    it("marks a credential failed (without enqueuing) when password is missing", async () => {
      const { automation, agentAccounts } = makeMocks();
      const svc = new RosettaService({ dataDir: tempDir }, automation as any, agentAccounts as any);

      await svc.adspowerImport({ credentials: [{ email: "a@x.com", password: "" }] });

      expect(automation.startAutomation).not.toHaveBeenCalled();
      const batch = readBatch();
      expect(batch.items[0]).toMatchObject({ email: "a@x.com", status: "failed" });
      expect(batch.done).toBe(true);
    });

    it("uploads to the pool when a task succeeds and reports completion", async () => {
      const { automation, agentAccounts } = makeMocks();
      const svc = new RosettaService({ dataDir: tempDir }, automation as any, agentAccounts as any);
      const { batchId } = await svc.adspowerImport({ credentials: [{ email: "a@x.com", password: "pw" }] });

      automation.getTaskStatus.mockResolvedValueOnce({ status: "SUCCESS" } as any);
      const status: any = await svc.adspowerImportStatus(batchId!);

      expect(agentAccounts.uploadToRosetta).toHaveBeenCalledWith(["agent-1"]);
      expect(status.items[0]).toMatchObject({ status: "success", uploaded: true });
      expect(status).toMatchObject({ ok: true, done: true, status: "completed" });
    });

    it("maps a failed task to a failed item with the error message", async () => {
      const { automation, agentAccounts } = makeMocks();
      const svc = new RosettaService({ dataDir: tempDir }, automation as any, agentAccounts as any);
      const { batchId } = await svc.adspowerImport({ credentials: [{ email: "a@x.com", password: "pw" }] });

      automation.getTaskStatus.mockResolvedValueOnce({ status: "FAILED_FINAL", lastErrorMessage: "boom" } as any);
      const status: any = await svc.adspowerImportStatus(batchId!);

      expect(agentAccounts.uploadToRosetta).not.toHaveBeenCalled();
      expect(status.items[0]).toMatchObject({ status: "failed", error: "boom" });
      expect(status).toMatchObject({ done: true });
    });

    it("surfaces a pool-upload failure as a failed item", async () => {
      const { automation, agentAccounts } = makeMocks();
      agentAccounts.uploadToRosetta = vi.fn(async () => {
        throw new Error("disk full");
      });
      const svc = new RosettaService({ dataDir: tempDir }, automation as any, agentAccounts as any);
      const { batchId } = await svc.adspowerImport({ credentials: [{ email: "a@x.com", password: "pw" }] });

      automation.getTaskStatus.mockResolvedValueOnce({ status: "SUCCESS" } as any);
      const status: any = await svc.adspowerImportStatus(batchId!);

      expect(status.items[0]).toMatchObject({ status: "failed" });
      expect(status.items[0].error).toContain("入池失败");
    });
  });
});
