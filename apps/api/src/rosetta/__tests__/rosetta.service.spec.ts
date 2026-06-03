import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RosettaService } from "../rosetta.service";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function getFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = http.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function jwtWithPayload(payload: Record<string, unknown>) {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(payload)}.sig`;
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

  it("starts Codex OAuth, exchanges the callback code, and saves the account without exposing tokens in status", async () => {
    const port = await getFreePort();
    const tokenFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body as URLSearchParams;
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("callback-code");
      expect(body.get("code_verifier")).toBeTruthy();
      return new Response(JSON.stringify({
        id_token: jwtWithPayload({ email: "oauth-codex@example.com", name: "OAuth Codex" }),
        access_token: "access-from-oauth",
        refresh_token: "refresh-from-oauth",
        expires_in: 3600,
      }), { status: 200 });
    }) as typeof fetch;
    const svc = new RosettaService({ dataDir: tempDir, codexOAuthPort: port, codexOAuthFetch: tokenFetch });

    const started = await svc.startCodexOAuthLogin();
    expect(started.ok).toBe(true);
    expect(started.redirectUri).toBe(`http://localhost:${port}/auth/callback`);
    const authUrl = new URL(started.authUrl);
    expect(authUrl.hostname).toBe("auth.openai.com");
    expect(authUrl.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(authUrl.searchParams.get("scope")).toContain("offline_access");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");

    const state = authUrl.searchParams.get("state");
    const callback = await fetch(`http://127.0.0.1:${port}/auth/callback?code=callback-code&state=${state}`);
    expect(callback.status).toBe(200);

    const status = svc.getCodexOAuthLoginStatus(started.loginId);
    expect(status).toMatchObject({ ok: true, status: "completed", email: "oauth-codex@example.com" });
    expect(JSON.stringify(status)).not.toContain("refresh-from-oauth");
    expect(JSON.stringify(status)).not.toContain("access-from-oauth");

    const stored = JSON.parse(fs.readFileSync(path.join(tempDir, "codex-accounts.json"), "utf8"));
    expect(stored.accounts[0]).toMatchObject({
      email: "oauth-codex@example.com",
      alias: "OAuth Codex",
      refreshToken: "refresh-from-oauth",
      accessToken: "access-from-oauth",
      enabled: true,
    });
    svc.cancelCodexOAuthLogin(started.loginId);
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

  describe("static account binding (per-product map)", () => {
    it("binds a card to an account under a provider key and surfaces it in listAccessKeys", () => {
      const svc = new RosettaService({ dataDir: tempDir });
      svc.createAccessKey({ id: "c1", name: "x" });
      expect(svc.bindAccessKey({ id: "c1", provider: "codex", accountId: 7 })).toMatchObject({ ok: true });
      const key = svc.listAccessKeys({}).keys.find((k) => k.id === "c1") as any;
      expect(key.bindings).toMatchObject({ codex: 7 });
    });

    it("lets one card bind an account in EACH pool (universal card)", () => {
      const svc = new RosettaService({ dataDir: tempDir });
      svc.createAccessKey({ id: "c1" });
      svc.bindAccessKey({ id: "c1", provider: "codex", accountId: 7 });
      svc.bindAccessKey({ id: "c1", provider: "antigravity", accountId: 3 });
      const key = svc.listAccessKeys({}).keys.find((k) => k.id === "c1") as any;
      expect(key.bindings).toEqual({ codex: 7, antigravity: 3 });
    });

    it("rejects binding a 5th card to the same account (max 4)", () => {
      const svc = new RosettaService({ dataDir: tempDir });
      for (let i = 1; i <= 4; i++) {
        svc.createAccessKey({ id: `c${i}` });
        expect(svc.bindAccessKey({ id: `c${i}`, provider: "codex", accountId: 7 }).ok).toBe(true);
      }
      svc.createAccessKey({ id: "c5" });
      const r = svc.bindAccessKey({ id: "c5", provider: "codex", accountId: 7 });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("4");
    });

    it("scopes the 4-card limit by provider", () => {
      const svc = new RosettaService({ dataDir: tempDir });
      for (let i = 1; i <= 4; i++) {
        svc.createAccessKey({ id: `cx${i}` });
        svc.bindAccessKey({ id: `cx${i}`, provider: "codex", accountId: 1 });
      }
      svc.createAccessKey({ id: "ag1" });
      expect(svc.bindAccessKey({ id: "ag1", provider: "antigravity", accountId: 1 }).ok).toBe(true);
    });

    it("re-binding the same card to the same account does not count it twice", () => {
      const svc = new RosettaService({ dataDir: tempDir });
      svc.createAccessKey({ id: "c1" });
      expect(svc.bindAccessKey({ id: "c1", provider: "codex", accountId: 7 }).ok).toBe(true);
      expect(svc.bindAccessKey({ id: "c1", provider: "codex", accountId: 7 }).ok).toBe(true);
    });

    it("unbinds a single provider, leaving the other binding intact", () => {
      const svc = new RosettaService({ dataDir: tempDir });
      svc.createAccessKey({ id: "c1" });
      svc.bindAccessKey({ id: "c1", provider: "codex", accountId: 7 });
      svc.bindAccessKey({ id: "c1", provider: "antigravity", accountId: 3 });
      expect(svc.unbindAccessKey({ id: "c1", provider: "codex" }).ok).toBe(true);
      const key = svc.listAccessKeys({}).keys.find((k) => k.id === "c1") as any;
      expect(key.bindings).toEqual({ antigravity: 3 });
    });

    it("surfaces boundCardCount on codex accounts", () => {
      const svc = new RosettaService({ dataDir: tempDir });
      svc.addCodexAccount({ email: "a@x.com", refreshToken: "rt" });
      const id = svc.listCodexAccounts().accounts[0].id;
      svc.createAccessKey({ id: "c1" });
      svc.createAccessKey({ id: "c2" });
      svc.bindAccessKey({ id: "c1", provider: "codex", accountId: id });
      svc.bindAccessKey({ id: "c2", provider: "codex", accountId: id });
      expect((svc.listCodexAccounts().accounts[0] as any).boundCardCount).toBe(2);
    });

    it("clears orphan bindings when a codex account is deleted", () => {
      const svc = new RosettaService({ dataDir: tempDir });
      svc.addCodexAccount({ email: "a@x.com", refreshToken: "rt" });
      const id = svc.listCodexAccounts().accounts[0].id;
      svc.createAccessKey({ id: "c1" });
      svc.bindAccessKey({ id: "c1", provider: "codex", accountId: id });
      svc.deleteCodexAccount({ accountId: id });
      const key = svc.listAccessKeys({}).keys.find((k) => k.id === "c1") as any;
      expect(key.bindings?.codex).toBeFalsy();
    });
  });

  describe("per-card weight (份额 / 独享)", () => {
    it("an exclusive card (weight 4) fills the whole account — no other card fits", () => {
      const svc = new RosettaService({ dataDir: tempDir });
      svc.addCodexAccount({ email: "a@x.com", refreshToken: "rt" });
      const id = svc.listCodexAccounts().accounts[0].id;
      svc.createAccessKey({ id: "x", weight: 4 });
      expect(svc.bindAccessKey({ id: "x", provider: "codex", accountId: id }).ok).toBe(true);
      svc.createAccessKey({ id: "y", weight: 1 });
      expect(svc.bindAccessKey({ id: "y", provider: "codex", accountId: id }).ok).toBe(false);
    });

    it("four 1-share cards fit one account; the fifth does not", () => {
      const svc = new RosettaService({ dataDir: tempDir });
      svc.addCodexAccount({ email: "a@x.com", refreshToken: "rt" });
      const id = svc.listCodexAccounts().accounts[0].id;
      for (let i = 1; i <= 4; i++) {
        svc.createAccessKey({ id: `c${i}` }); // default weight 1
        expect(svc.bindAccessKey({ id: `c${i}`, provider: "codex", accountId: id }).ok).toBe(true);
      }
      svc.createAccessKey({ id: "c5" });
      expect(svc.bindAccessKey({ id: "c5", provider: "codex", accountId: id }).ok).toBe(false);
    });

    it("a 2-share + two 1-share cards fill the account (2+1+1=4)", () => {
      const svc = new RosettaService({ dataDir: tempDir });
      svc.addCodexAccount({ email: "a@x.com", refreshToken: "rt" });
      const id = svc.listCodexAccounts().accounts[0].id;
      svc.createAccessKey({ id: "a", weight: 2 });
      svc.createAccessKey({ id: "b", weight: 1 });
      svc.createAccessKey({ id: "c", weight: 1 });
      svc.createAccessKey({ id: "d", weight: 1 });
      expect(svc.bindAccessKey({ id: "a", provider: "codex", accountId: id }).ok).toBe(true);
      expect(svc.bindAccessKey({ id: "b", provider: "codex", accountId: id }).ok).toBe(true);
      expect(svc.bindAccessKey({ id: "c", provider: "codex", accountId: id }).ok).toBe(true);
      // 2+1+1 = 4 (full) → the 4th 1-share card no longer fits.
      expect(svc.bindAccessKey({ id: "d", provider: "codex", accountId: id }).ok).toBe(false);
    });

    it("defaults card weight to 1 and surfaces it; usedShares reflects the sum", () => {
      const svc = new RosettaService({ dataDir: tempDir });
      svc.addCodexAccount({ email: "a@x.com", refreshToken: "rt" });
      const id = svc.listCodexAccounts().accounts[0].id;
      svc.createAccessKey({ id: "c1" });
      expect((svc.listAccessKeys({}).keys[0] as any).weight).toBe(1);
      svc.bindAccessKey({ id: "c1", provider: "codex", accountId: id });
      expect((svc.listCodexAccounts().accounts[0] as any).usedShares).toBe(1);
    });

    it("auto-binds an exclusive card to a whole account (usedShares = 4)", () => {
      const svc = new RosettaService({ dataDir: tempDir });
      svc.addCodexAccount({ email: "a@x.com", refreshToken: "rt", planType: "pro" });
      const id = svc.listCodexAccounts().accounts[0].id;
      expect(svc.createAccessKey({ products: ["codex"], levels: { codex: "pro" }, weight: 4 }).ok).toBe(true);
      const key = svc.listAccessKeys({}).keys[0] as any;
      expect(key.weight).toBe(4);
      expect(key.bindings).toMatchObject({ codex: id });
      expect((svc.listCodexAccounts().accounts[0] as any).usedShares).toBe(4);
    });

    it("auto-binds to the best-fit (tightest) account, keeping whole accounts free for 独享", () => {
      const svc = new RosettaService({ dataDir: tempDir });
      svc.addCodexAccount({ email: "a@x.com", refreshToken: "rt", planType: "pro" }); // id 1
      svc.addCodexAccount({ email: "b@x.com", refreshToken: "rt", planType: "pro" }); // id 2
      const ids = svc.listCodexAccounts().accounts.map((a) => a.id);
      // Pre-fill account ids[0] to 3/4 with a 3-share card; ids[1] stays empty (4 free).
      svc.createAccessKey({ id: "big", weight: 3 });
      svc.bindAccessKey({ id: "big", provider: "codex", accountId: ids[0] });

      // A new 1-share card must go to ids[0] (free 1, tight fit) — NOT the empty ids[1].
      svc.createAccessKey({ id: "small", products: ["codex"], levels: { codex: "pro" }, weight: 1 });
      const small = svc.listAccessKeys({}).keys.find((k) => k.id === "small") as any;
      expect(small.bindings.codex).toBe(ids[0]);

      // The empty account is preserved → an exclusive (4-share) card still fits ids[1].
      svc.createAccessKey({ id: "excl", products: ["codex"], levels: { codex: "pro" }, weight: 4 });
      const excl = svc.listAccessKeys({}).keys.find((k) => k.id === "excl") as any;
      expect(excl.bindings.codex).toBe(ids[1]);
    });

    it("auto-bind fails when no account has room for the card's weight", () => {
      const svc = new RosettaService({ dataDir: tempDir });
      svc.addCodexAccount({ email: "a@x.com", refreshToken: "rt", planType: "pro" });
      // fill 3 shares with three 1-share cards…
      svc.createAccessKey({ products: ["codex"], levels: { codex: "pro" }, count: 3 });
      // …an exclusive (4-share) card no longer fits (only 1 share free).
      const res: any = svc.createAccessKey({ products: ["codex"], levels: { codex: "pro" }, weight: 4 });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("不足");
    });
  });

  describe("auto-bind on card creation", () => {
    it("auto-binds a new codex card to an account with an open seat", () => {
      const svc = new RosettaService({ dataDir: tempDir });
      svc.addCodexAccount({ email: "a@x.com", refreshToken: "rt", planType: "pro" });
      const id = svc.listCodexAccounts().accounts[0].id;
      const res: any = svc.createAccessKey({ products: ["codex"], levels: { codex: "pro" } });
      expect(res.ok).toBe(true);
      const key = svc.listAccessKeys({}).keys[0] as any;
      expect(key.bindings).toMatchObject({ codex: id });
    });

    it("auto-binds across both pools for a universal card", () => {
      const svc = new RosettaService({ dataDir: tempDir });
      svc.addCodexAccount({ email: "c@x.com", refreshToken: "rt", planType: "pro" });
      svc.addAccount({ email: "a@x.com", refreshToken: "rt", projectId: "p", planType: "ultra" });
      const cid = svc.listCodexAccounts().accounts[0].id;
      const aid = svc.listAccounts().accounts[0].id;
      svc.createAccessKey({ products: ["codex", "antigravity"], levels: { codex: "pro", antigravity: "ultra" } });
      const key = svc.listAccessKeys({}).keys[0] as any;
      expect(key.bindings).toEqual({ codex: cid, antigravity: aid });
    });

    it("spreads a batch across seats and fails when seats run out", () => {
      const svc = new RosettaService({ dataDir: tempDir });
      svc.addCodexAccount({ email: "a@x.com", refreshToken: "rt", planType: "pro" }); // 1 account = 4 seats
      // 4 cards fit…
      expect(svc.createAccessKey({ products: ["codex"], levels: { codex: "pro" }, count: 4 }).ok).toBe(true);
      const id = svc.listCodexAccounts().accounts[0].id;
      expect((svc.listCodexAccounts().accounts[0] as any).boundCardCount).toBe(4);
      // …a 5th has no seat → rejected, nothing minted.
      const res: any = svc.createAccessKey({ products: ["codex"], levels: { codex: "pro" } });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("不足");
      expect(svc.listAccessKeys({}).keys).toHaveLength(4);
      void id;
    });

    it("mints an unbound card when no products are selected (back-compat)", () => {
      const svc = new RosettaService({ dataDir: tempDir });
      const res: any = svc.createAccessKey({ name: "x" });
      expect(res.ok).toBe(true);
      const key = svc.listAccessKeys({}).keys[0] as any;
      expect(key.bindings || {}).toEqual({});
    });

    it("rejects a product without a chosen level (level is required)", () => {
      const svc = new RosettaService({ dataDir: tempDir });
      svc.addCodexAccount({ email: "a@x.com", refreshToken: "rt", planType: "pro" });
      const res: any = svc.createAccessKey({ products: ["codex"] });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("会员等级");
      expect(svc.listAccessKeys({}).keys).toHaveLength(0);
    });

    it("only binds accounts of the requested level", () => {
      const svc = new RosettaService({ dataDir: tempDir });
      svc.addAccount({ email: "prem@x.com", refreshToken: "rt", projectId: "p", planType: "premium" });
      svc.addAccount({ email: "ultra@x.com", refreshToken: "rt", projectId: "p", planType: "ultra" });
      const ultraId = svc.listAccounts().accounts.find((a) => a.planType === "ultra")!.id;
      svc.createAccessKey({ products: ["antigravity"], levels: { antigravity: "ultra" } });
      const key = svc.listAccessKeys({}).keys[0] as any;
      expect(key.bindings).toEqual({ antigravity: ultraId });
    });

    it("fails when no account matches the requested level", () => {
      const svc = new RosettaService({ dataDir: tempDir });
      svc.addCodexAccount({ email: "a@x.com", refreshToken: "rt", planType: "pro" });
      const res: any = svc.createAccessKey({ products: ["codex"], levels: { codex: "plus" } });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("plus");
      expect(svc.listAccessKeys({}).keys).toHaveLength(0);
    });

    it("skips an account whose quota is fully exhausted", () => {
      const svc = new RosettaService({ dataDir: tempDir });
      // Two pro accounts; the first is drained (codex fraction 0), the second has quota.
      svc.addCodexAccount({ email: "drained@x.com", refreshToken: "rt", planType: "pro" });
      svc.addCodexAccount({ email: "fresh@x.com", refreshToken: "rt", planType: "pro" });
      const accounts = svc.listCodexAccounts().accounts;
      const drainedId = accounts.find((a) => a.email === "drained@x.com")!.id;
      const freshId = accounts.find((a) => a.email === "fresh@x.com")!.id;
      // Drain the first account's codex window (no reset → stays exhausted).
      const file = path.join(tempDir, "codex-accounts.json");
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const drained = data.accounts.find((a: any) => a.id === drainedId);
      drained.modelQuotaFractions = { codex: 0 };
      fs.writeFileSync(file, JSON.stringify(data, null, 2));

      svc.createAccessKey({ products: ["codex"], levels: { codex: "pro" } });
      const key = svc.listAccessKeys({}).keys[0] as any;
      expect(key.bindings).toEqual({ codex: freshId });
    });
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
