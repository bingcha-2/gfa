import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
});
