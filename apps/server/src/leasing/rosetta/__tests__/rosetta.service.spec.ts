import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RosettaService, migrateClaudeProductToAnthropic } from "../rosetta.service";
import { AccessKeyStore } from "../../token-server/access-key-store";
import { proxyRequiredFetch } from "../../lease-core/egress";

// The anthropic refresh/probe/OAuth-exchange paths are fail-closed
// (proxyRequiredFetch); codex/gemini route through proxyAwareFetch. These tests
// drive the network via vi.stubGlobal("fetch"), so send the egress wrappers back
// to the (stubbed) global fetch — as spies, so tests can assert the routing.
// The proxy/fail-closed layer itself is covered in egress.spec.ts.
vi.mock("../../lease-core/egress", async (orig) => ({
  ...(await (orig as any)()),
  proxyRequiredFetch: vi.fn((_p: unknown, url: string, init: any) => fetch(url, init)),
  proxyAwareFetch: vi.fn((_p: unknown, url: string, init: any) => fetch(url, init)),
}));

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath: string, fallback: any): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
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
    vi.unstubAllGlobals();
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

  it("manages claude accounts in claude-accounts.json (add/list/toggle/delete)", () => {
    const svc = new RosettaService({ dataDir: tempDir });
    expect(svc.listClaudeAccounts().accounts).toHaveLength(0);

    svc.addClaudeAccount({ email: "cl@x.com", refreshToken: "rt", planType: "max" });
    const listed = svc.listClaudeAccounts().accounts;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ email: "cl@x.com", enabled: true, planType: "max", hasToken: true });
    // Missing legacy field is still presented as true for old clients.
    expect(listed[0].poolEnabled).toBe(true);

    const id = listed[0].id;
    svc.toggleClaudeAccount({ accountId: id });
    expect(svc.listClaudeAccounts().accounts[0].enabled).toBe(false);

    // poolEnabled is retained as legacy state only; it no longer gates runtime supply.
    expect(svc.toggleClaudeAccountPool({ accountId: id })).toMatchObject({
      poolEnabled: false,
      legacy: true,
      runtimeSupplyEffect: false,
    });
    expect(svc.listClaudeAccounts().accounts[0].poolEnabled).toBe(false);
    expect(svc.toggleClaudeAccountPool({ accountId: id })).toMatchObject({
      poolEnabled: true,
      legacy: true,
      runtimeSupplyEffect: false,
    });
    expect(svc.listClaudeAccounts().accounts[0].poolEnabled).toBe(true);

    svc.deleteClaudeAccount({ accountId: id });
    expect(svc.listClaudeAccounts().accounts).toHaveLength(0);

    // Written to anthropic-accounts.json, NOT the codex/antigravity pools.
    const stored = JSON.parse(fs.readFileSync(path.join(tempDir, "anthropic-accounts.json"), "utf8"));
    expect(Array.isArray(stored.accounts)).toBe(true);
  });

  it("migrateClaudeProductToAnthropic renames the pool file and rewrites card claude→anthropic keys (idempotent)", () => {
    writeJson(path.join(tempDir, "claude-accounts.json"), { accounts: [{ id: 1, email: "a@x.com", refreshToken: "rt" }] });
    writeJson(path.join(tempDir, "access-keys.json"), {
      keys: [
        { id: "c1", products: ["claude"], bindings: { claude: 1 }, levels: { claude: "pro" }, accountIds: { claude: 1 } },
        { id: "c2", products: ["codex"], bindings: { codex: 2 } },
      ],
    });

    const r = migrateClaudeProductToAnthropic(tempDir);
    expect(r).toMatchObject({ renamedPool: true, cardsRewritten: 1 });

    expect(fs.existsSync(path.join(tempDir, "claude-accounts.json"))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, "anthropic-accounts.json"))).toBe(true);

    const ak = JSON.parse(fs.readFileSync(path.join(tempDir, "access-keys.json"), "utf8"));
    expect(ak.keys[0]).toMatchObject({ products: ["anthropic"], bindings: { anthropic: 1 }, levels: { anthropic: "pro" }, accountIds: { anthropic: 1 } });
    expect(ak.keys[0].bindings).not.toHaveProperty("claude");
    expect(ak.keys[1]).toMatchObject({ products: ["codex"], bindings: { codex: 2 } });

    // Idempotent: second run does nothing.
    expect(migrateClaudeProductToAnthropic(tempDir)).toMatchObject({ renamedPool: false, cardsRewritten: 0 });
  });

  it("refreshClaudeAccountQuota refreshes the token, then writes 5h/周 remaining + 套餐 + modelQuotaFractions", async () => {
    const svc = new RosettaService({ dataDir: tempDir });
    svc.addClaudeAccount({ email: "max@x.com", refreshToken: "rt", planType: "" });
    // Stub the three upstream GETs/POSTs: token refresh, /api/oauth/usage, /api/oauth/profile.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/api/oauth/usage")) {
          return new Response(
            JSON.stringify({
              five_hour: { utilization: 0.2, resets_at: null }, // 80% remaining
              seven_day: { utilization: 0.5, resets_at: null }, // 50% remaining (binding)
            }),
            { status: 200 },
          );
        }
        if (u.includes("/api/oauth/profile")) {
          return new Response(JSON.stringify({ organization: { organization_type: "claude_max" } }), { status: 200 });
        }
        return new Response(JSON.stringify({ access_token: "fresh-at", expires_in: 3600 }), { status: 200 });
      }),
    );

    const r = await svc.refreshClaudeAccountQuota({ accountId: 1 });
    expect(r).toMatchObject({ ok: true, tokenValid: true, hourlyPercent: 80, weeklyPercent: 50, planType: "max" });

    const stored = JSON.parse(fs.readFileSync(path.join(tempDir, "anthropic-accounts.json"), "utf8"));
    const acc = stored.accounts[0];
    expect(acc).toMatchObject({ claudeHourlyPercent: 80, claudeWeeklyPercent: 50, planType: "max", accessToken: "fresh-at" });
    // Binding window = the more restrictive (weekly 50 < hourly 80) → claude fraction 0.5.
    expect(acc.modelQuotaFractions).toMatchObject({ claude: 0.5 });
  });

  it("refreshClaudeAccountQuota still succeeds (token refreshed) when usage has no windows", async () => {
    const svc = new RosettaService({ dataDir: tempDir });
    svc.addClaudeAccount({ email: "x@x.com", refreshToken: "rt" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/api/oauth/usage")) return new Response(JSON.stringify({ extra_usage: { is_enabled: false } }), { status: 200 });
        if (u.includes("/api/oauth/profile")) return new Response(JSON.stringify({}), { status: 200 });
        return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
      }),
    );
    const r = await svc.refreshClaudeAccountQuota({ accountId: 1 });
    expect(r).toMatchObject({ ok: true, tokenValid: true });
    expect((r as any).quotaError).toBeTruthy();
  });

  it("refreshClaudeAccountQuota keeps the prior weekly when upstream omits seven_day (no spurious 0/100)", async () => {
    const svc = new RosettaService({ dataDir: tempDir });
    // Seed a known-good weekly (98%) already on disk.
    writeJson(path.join(tempDir, "anthropic-accounts.json"), {
      accounts: [
        {
          id: 1,
          email: "max@x.com",
          refreshToken: "rt",
          enabled: true,
          planType: "max",
          claudeHourlyPercent: 10,
          claudeWeeklyPercent: 98,
          claudeWeeklyResetTime: "2026-06-16T14:00:00.000Z",
        },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/api/oauth/usage")) {
          // Partial probe: five_hour present, seven_day OMITTED, only a drained Opus
          // sub-cap — the exact shape that used to report 周剩余=0 and bench the号.
          return new Response(
            JSON.stringify({
              five_hour: { utilization: 0.06, resets_at: null }, // 94% remaining
              seven_day_opus: { utilization: 1.0, resets_at: null }, // drained → must be ignored
            }),
            { status: 200 },
          );
        }
        if (u.includes("/api/oauth/profile")) return new Response(JSON.stringify({ organization: { organization_type: "claude_max" } }), { status: 200 });
        return new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), { status: 200 });
      }),
    );

    const r = await svc.refreshClaudeAccountQuota({ accountId: 1 });
    // 5h updates to 94; weekly stays at the prior good 98 — NOT 0 (Opus sub-cap), NOT 100.
    expect(r).toMatchObject({ ok: true, hourlyPercent: 94, weeklyPercent: 98 });

    const stored = JSON.parse(fs.readFileSync(path.join(tempDir, "anthropic-accounts.json"), "utf8"));
    const acc = stored.accounts[0];
    expect(acc.claudeHourlyPercent).toBe(94);
    expect(acc.claudeWeeklyPercent).toBe(98); // preserved, not clobbered by a partial response
    expect(acc.claudeWeeklyResetTime).toBe("2026-06-16T14:00:00.000Z"); // preserved
    // Binding = the more restrictive known window: 5h 94 vs weekly 98 → 5h binds → 0.94.
    expect(acc.modelQuotaFractions).toMatchObject({ claude: 0.94 });
  });

  it("surfaces claude 5h/weekly percentages and bound-card counts in listClaudeAccounts", () => {
    const svc = new RosettaService({ dataDir: tempDir });
    writeJson(path.join(tempDir, "anthropic-accounts.json"), {
      accounts: [
        {
          id: 7,
          email: "max@x.com",
          refreshToken: "rt",
          enabled: true,
          planType: "max",
          claudeHourlyPercent: 80,
          claudeWeeklyPercent: 30,
        },
      ],
    });
    const acc = svc.listClaudeAccounts().accounts[0] as any;
    expect(acc.claudeHourlyPercent).toBe(80);
    expect(acc.claudeWeeklyPercent).toBe(30);
    expect(acc.boundCardCount).toBe(0);
    expect(acc.shareCapacity).toBeGreaterThan(0);
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

  it("exports all codex accounts (with tokens) in a re-importable shape", () => {
    const svc = new RosettaService({ dataDir: tempDir });
    svc.addCodexAccount({ email: "a@example.com", refreshToken: "ra", planType: "plus", alias: "A" });
    svc.addCodexAccount({ email: "b@example.com", refreshToken: "rb" });
    svc.toggleCodexAccount({ accountId: 2 });

    const result = svc.exportCodexAccounts();
    expect(result).toMatchObject({ ok: true, type: "codex-accounts-export", count: 2 });
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts[0]).toMatchObject({ id: 1, email: "a@example.com", refreshToken: "ra", planType: "plus", alias: "A", enabled: true });
    expect(result.accounts[1]).toMatchObject({ id: 2, email: "b@example.com", refreshToken: "rb", enabled: false });
  });

  it("bulk-imports an exported pool, upserting by email and honoring enabled flags", () => {
    const svc = new RosettaService({ dataDir: tempDir });
    svc.addCodexAccount({ email: "keep@example.com", refreshToken: "old-token", planType: "plus", alias: "Keep" });

    const result = svc.importCodexAccountsFromText({
      text: JSON.stringify({
        type: "codex-accounts-export",
        accounts: [
          { email: "keep@example.com", refreshToken: "new-token", planType: "pro", enabled: true },
          { email: "fresh@example.com", refreshToken: "fresh-token", enabled: false },
          { email: "", refreshToken: "no-email" },
        ],
      }),
    });

    expect(result).toMatchObject({ ok: true, bulk: true, added: 1, updated: 1, failed: 1 });

    const stored = JSON.parse(fs.readFileSync(path.join(tempDir, "codex-accounts.json"), "utf8"));
    expect(stored.accounts).toHaveLength(2);
    expect(stored.accounts[0]).toMatchObject({ id: 1, email: "keep@example.com", refreshToken: "new-token", planType: "pro", enabled: true });
    expect(stored.accounts[1]).toMatchObject({ email: "fresh@example.com", refreshToken: "fresh-token", enabled: false });
  });

  it("round-trips: export then re-import reproduces the same pool", () => {
    const src = new RosettaService({ dataDir: tempDir });
    src.addCodexAccount({ email: "x@example.com", refreshToken: "rx", planType: "plus", alias: "X" });
    src.addCodexAccount({ email: "y@example.com", refreshToken: "ry" });
    const exported = src.exportCodexAccounts();

    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-rosetta-dest-"));
    try {
      const dest = new RosettaService({ dataDir: destDir });
      const result = dest.importCodexAccountsFromText({ text: JSON.stringify(exported) });
      expect(result).toMatchObject({ ok: true, bulk: true, added: 2, updated: 0, failed: 0 });
      const stored = JSON.parse(fs.readFileSync(path.join(destDir, "codex-accounts.json"), "utf8"));
      expect(stored.accounts).toHaveLength(2);
      expect(stored.accounts.map((a: any) => a.email).sort()).toEqual(["x@example.com", "y@example.com"]);
      expect(stored.accounts.find((a: any) => a.email === "x@example.com")).toMatchObject({ refreshToken: "rx", planType: "plus", alias: "X" });
    } finally {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
  });

  it("losslessly round-trips quota/reset fields and still drops unknown junk", () => {
    // Seed a fully-populated account (as if refreshCodexAccountQuota had run).
    writeJson(path.join(tempDir, "codex-accounts.json"), {
      accounts: [
        {
          id: 1,
          email: "full@example.com",
          refreshToken: "rf",
          accessToken: "at",
          accessTokenExpiresAt: 1893456000000,
          sessionToken: "st",
          enabled: true,
          alias: "Full",
          planType: "pro",
          codexHourlyPercent: 73,
          codexWeeklyPercent: 41,
          codexHourlyResetTime: "2026-06-03T18:00:00Z",
          codexWeeklyResetTime: "2026-06-09T00:00:00Z",
          modelQuotaFractions: { codex: 0.73 },
          modelQuotaResetTimes: { codex: "2026-06-03T18:00:00Z" },
          modelQuotaRefreshedAt: 1717430400000,
          internalJunk: "should-not-survive",
        },
      ],
    });

    const src = new RosettaService({ dataDir: tempDir });
    const exported = src.exportCodexAccounts();
    // Export is verbatim/lossless — it keeps every stored field.
    expect(exported.accounts[0]).toMatchObject({ codexHourlyPercent: 73, modelQuotaFractions: { codex: 0.73 }, internalJunk: "should-not-survive" });

    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-rosetta-dest-"));
    try {
      const dest = new RosettaService({ dataDir: destDir });
      dest.importCodexAccountsFromText({ text: JSON.stringify(exported) });
      const stored = JSON.parse(fs.readFileSync(path.join(destDir, "codex-accounts.json"), "utf8"));
      expect(stored.accounts).toHaveLength(1);
      const acc = stored.accounts[0];
      // Allowlisted quota/reset fields survive the import.
      expect(acc).toMatchObject({
        email: "full@example.com",
        refreshToken: "rf",
        accessToken: "at",
        accessTokenExpiresAt: 1893456000000,
        sessionToken: "st",
        planType: "pro",
        alias: "Full",
        codexHourlyPercent: 73,
        codexWeeklyPercent: 41,
        codexHourlyResetTime: "2026-06-03T18:00:00Z",
        codexWeeklyResetTime: "2026-06-09T00:00:00Z",
        modelQuotaFractions: { codex: 0.73 },
        modelQuotaResetTimes: { codex: "2026-06-03T18:00:00Z" },
        modelQuotaRefreshedAt: 1717430400000,
      });
      // Non-allowlisted junk is left behind on import.
      expect(acc).not.toHaveProperty("internalJunk");
    } finally {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
  });

  it("still imports the legacy single pasted token JSON, dropping sensitive fields", () => {
    const svc = new RosettaService({ dataDir: tempDir });
    const result = svc.importCodexAccountsFromText({
      text: `随便一段文本 {"WARNING_BANNER":"secret","user":{"email":"legacy@example.com","name":"Legacy"},"account":{"planType":"plus"},"accessToken":"a","sessionToken":"s","ignoredField":"x"}`,
    });
    expect(result).toMatchObject({ ok: true });

    const stored = JSON.parse(fs.readFileSync(path.join(tempDir, "codex-accounts.json"), "utf8"));
    expect(stored.accounts).toHaveLength(1);
    expect(stored.accounts[0]).toMatchObject({ email: "legacy@example.com", alias: "Legacy", planType: "plus", accessToken: "a", sessionToken: "s" });
    expect(stored.accounts[0]).not.toHaveProperty("WARNING_BANNER");
    expect(stored.accounts[0]).not.toHaveProperty("ignoredField");
  });

  it("starts Claude OAuth, exchanges the pasted code, and saves the account", async () => {
    // The anthropic code→token exchange is fail-closed (proxyRequiredFetch), so
    // the network is driven via the stubbed global fetch (see the egress mock at
    // the top of this file), not a constructor-injected fetch.
    const tokenFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      expect(body.grant_type).toBe("authorization_code");
      expect(body.code).toBe("auth-code-123");
      expect(body.code_verifier).toBeTruthy();
      expect(body.client_id).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
      return new Response(JSON.stringify({
        access_token: "sk-ant-oat-access",
        refresh_token: "sk-ant-ort-refresh",
        expires_in: 3600,
        account: { email_address: "max-user@example.com", uuid: "acc-uuid" },
        organization: { name: "Max Org" },
      }), { status: 200 });
    }) as typeof fetch;
    vi.stubGlobal("fetch", tokenFetch);
    const svc = new RosettaService({ dataDir: tempDir });

    const started = await svc.startClaudeOAuthLogin();
    expect(started.ok).toBe(true);
    const authUrl = new URL(started.authUrl);
    expect(authUrl.searchParams.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("scope")).toContain("user:inference");
    expect(started.redirectUri).toBe("https://platform.claude.com/oauth/code/callback");

    const state = authUrl.searchParams.get("state");
    const exchangeCallsBefore = vi.mocked(proxyRequiredFetch).mock.calls.length;
    // Claude's manual flow returns "code#state" — the submit must parse that form too.
    const submit = await svc.submitClaudeOAuthCallback(started.loginId, `auth-code-123#${state}`);
    expect(submit).toMatchObject({ ok: true, status: "completed", email: "max-user@example.com" });
    expect(tokenFetch).toHaveBeenCalledTimes(1);
    // Egress policy: the exchange must leave through the fail-closed wrapper
    // (proxy required in production — covered in egress.spec.ts), never a
    // direct datacenter-IP fetch.
    const exchangeCalls = vi.mocked(proxyRequiredFetch).mock.calls.slice(exchangeCallsBefore);
    expect(exchangeCalls).toHaveLength(1);
    expect(String(exchangeCalls[0][1])).toContain("/v1/oauth/token");

    const stored = JSON.parse(fs.readFileSync(path.join(tempDir, "anthropic-accounts.json"), "utf8"));
    expect(stored.accounts[0]).toMatchObject({
      email: "max-user@example.com",
      refreshToken: "sk-ant-ort-refresh",
      accessToken: "sk-ant-oat-access",
      enabled: true,
    });
    // Status must never leak raw tokens.
    const status = svc.getClaudeOAuthLoginStatus(started.loginId);
    expect(JSON.stringify(status)).not.toContain("sk-ant-ort-refresh");
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
    const submit = await svc.submitCodexOAuthCallback(
      started.loginId,
      `http://localhost:${port}/auth/callback?code=callback-code&state=${state}`,
    );
    expect(submit).toMatchObject({ ok: true, status: "completed", email: "oauth-codex@example.com" });

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

  describe("adspowerImport", () => {
    function makeMocks(opts: { taskId?: string } = {}) {
      const automation = {
        startAutomation: vi.fn(async () => ({ taskId: opts.taskId ?? "task-1" })),
        getTaskStatus: vi.fn(async () => ({ status: "RUNNING" })),
      };
      const agentAccounts = {
        ensureAgentAccount: vi.fn(async () => "agent-1"),
        getStoredCredentialsByEmail: vi.fn(async () => ({
          loginEmail: "a@x.com",
          loginPassword: "pw",
          totpSecret: "SEC",
          recoveryEmail: "r@x.com",
        })),
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

    it("skips an AdsPower import when the email is already in the Antigravity pool with a refresh token", async () => {
      writeJson(path.join(tempDir, "accounts.json"), {
        accounts: [{ id: 7, email: "A@x.com", refreshToken: "existing-rt", enabled: true }],
      });
      const { automation, agentAccounts } = makeMocks();
      const svc = new RosettaService({ dataDir: tempDir }, automation as any, agentAccounts as any);

      const result = await svc.adspowerImport({
        credentials: [{ email: "a@x.com", password: "pw" }],
      });

      expect(result.ok).toBe(true);
      expect(agentAccounts.ensureAgentAccount).not.toHaveBeenCalled();
      expect(automation.startAutomation).not.toHaveBeenCalled();
      const batch = readBatch();
      expect(batch).toMatchObject({ total: 1, completed: 1, failed: 0, done: true, status: "completed" });
      expect(batch.items[0]).toMatchObject({
        email: "a@x.com",
        accountId: 7,
        status: "success",
        skipped: true,
        uploaded: true,
      });
    });

    it("still enqueues an AdsPower import when the matching pool account has no refresh token", async () => {
      writeJson(path.join(tempDir, "accounts.json"), {
        accounts: [{ id: 7, email: "a@x.com", enabled: true }],
      });
      const { automation, agentAccounts } = makeMocks();
      const svc = new RosettaService({ dataDir: tempDir }, automation as any, agentAccounts as any);

      await svc.adspowerImport({
        credentials: [{ email: "a@x.com", password: "pw" }],
      });

      expect(agentAccounts.ensureAgentAccount).toHaveBeenCalledTimes(1);
      expect(automation.startAutomation).toHaveBeenCalledTimes(1);
      const batch = readBatch();
      expect(batch).toMatchObject({ total: 1, completed: 0, failed: 0, done: false, status: "running" });
      expect(batch.items[0]).toMatchObject({
        email: "a@x.com",
        agentAccountId: "agent-1",
        taskId: "task-1",
        status: "running",
      });
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

    it("deduplicates concurrent pool uploads while import status is polled", async () => {
      const { automation, agentAccounts } = makeMocks();
      const svc = new RosettaService({ dataDir: tempDir }, automation as any, agentAccounts as any);
      const { batchId } = await svc.adspowerImport({ credentials: [{ email: "a@x.com", password: "pw" }] });
      automation.getTaskStatus.mockResolvedValue({ status: "SUCCESS" } as any);

      await Promise.all([
        svc.adspowerImportStatus(batchId!),
        svc.adspowerImportStatus(batchId!),
      ]);

      expect(agentAccounts.uploadToRosetta).toHaveBeenCalledTimes(1);
      expect(readBatch().items[0]).toMatchObject({ status: "success", uploaded: true });
    });

    it("does not re-upload from a stale concurrent status poll after a success is persisted", async () => {
      const { automation, agentAccounts } = makeMocks();
      const svc = new RosettaService({ dataDir: tempDir }, automation as any, agentAccounts as any);
      const { batchId } = await svc.adspowerImport({ credentials: [{ email: "a@x.com", password: "pw" }] });
      let taskStatusCalls = 0;
      let resolveSecondStatus: (() => void) | undefined;

      automation.getTaskStatus.mockImplementation(() => {
        taskStatusCalls += 1;
        if (taskStatusCalls === 1) return Promise.resolve({ status: "SUCCESS" } as any);
        return new Promise((resolve) => {
          resolveSecondStatus = () => resolve({ status: "SUCCESS" } as any);
        });
      });

      const firstPoll = svc.adspowerImportStatus(batchId!);
      const stalePoll = svc.adspowerImportStatus(batchId!);
      await firstPoll;

      expect(readBatch().items[0]).toMatchObject({ status: "success", uploaded: true });
      resolveSecondStatus?.();
      await stalePoll;

      expect(agentAccounts.uploadToRosetta).toHaveBeenCalledTimes(1);
      expect(readBatch().items[0]).toMatchObject({ status: "success", uploaded: true });
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

    it("starts an AdsPower reauthorization for an existing Antigravity account using stored AgentAccount credentials", async () => {
      const { automation, agentAccounts } = makeMocks({ taskId: "repair-task-1" });
      const svc = new RosettaService({ dataDir: tempDir }, automation as any, agentAccounts as any);
      svc.addAccount({ email: "a@x.com", refreshToken: "old-rt", projectId: "project-1", planType: "premium" });

      const result = await (svc as any).adspowerReauthorize({ accountId: 1 });

      expect(result).toMatchObject({ ok: true, batchId: expect.any(String) });
      expect(agentAccounts.getStoredCredentialsByEmail).toHaveBeenCalledWith("a@x.com");
      expect(automation.startAutomation).toHaveBeenCalledWith(
        "oauth",
        {
          email: "a@x.com",
          password: "pw",
          recoveryEmail: "r@x.com",
          totpSecret: "SEC",
        },
        undefined,
        undefined,
        expect.objectContaining({
          source: "rosetta-account-repair",
          keepBrowserOpenOnChallenge: true,
        }),
      );

      const batch = JSON.parse(fs.readFileSync(path.join(tempDir, "adspower-reauth.json"), "utf8"));
      expect(batch.items[0]).toMatchObject({
        accountId: 1,
        email: "a@x.com",
        taskId: "repair-task-1",
        status: "running",
      });
    });

    it("writes a successful AdsPower reauthorization token back to the same Antigravity account id", async () => {
      const { automation, agentAccounts } = makeMocks({ taskId: "repair-task-1" });
      const svc = new RosettaService({ dataDir: tempDir }, automation as any, agentAccounts as any);
      svc.addAccount({
        email: "a@x.com",
        refreshToken: "old-rt",
        projectId: "project-1",
        planType: "premium",
      });
      const { batchId } = await (svc as any).adspowerReauthorize({ accountId: 1 });

      automation.getTaskStatus.mockResolvedValueOnce({
        status: "SUCCESS",
        result: { refresh_token: "new-rt" },
      } as any);
      const status: any = await (svc as any).adspowerReauthorizeStatus(batchId);

      expect(agentAccounts.uploadToRosetta).not.toHaveBeenCalled();
      expect(status).toMatchObject({ ok: true, done: true, status: "completed" });
      expect(status.items[0]).toMatchObject({ accountId: 1, status: "success", uploaded: true });
      const stored = JSON.parse(fs.readFileSync(path.join(tempDir, "accounts.json"), "utf8"));
      expect(stored.accounts).toHaveLength(1);
      expect(stored.accounts[0]).toMatchObject({
        id: 1,
        email: "a@x.com",
        refreshToken: "new-rt",
        projectId: "project-1",
        planType: "premium",
        enabled: true,
      });
    });

    it("rejects AdsPower reauthorization when the stored AgentAccount credentials are missing", async () => {
      const { automation, agentAccounts } = makeMocks();
      agentAccounts.getStoredCredentialsByEmail.mockResolvedValueOnce(null);
      const svc = new RosettaService({ dataDir: tempDir }, automation as any, agentAccounts as any);
      svc.addAccount({ email: "missing@x.com", refreshToken: "old-rt", projectId: "project-1" });

      const result = await (svc as any).adspowerReauthorize({ accountId: 1 });

      expect(result).toMatchObject({ ok: false });
      expect(automation.startAutomation).not.toHaveBeenCalled();
    });
  });

  describe("CLIProxy management in RosettaService", () => {
    it("should retrieve cliproxy status correctly", async () => {
      // Mock fetch response for cliproxy status
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(["gemini-user@example.com-proj.json"]), { status: 200 })));
      process.env.CLIPROXY_BASE_URL = "http://127.0.0.1:8317";
      process.env.CLIPROXY_MANAGEMENT_KEY = "mock-key";

      const service = new RosettaService({ dataDir: tempDir });
      const status = await service.getCliProxyStatus();
      expect(status).toMatchObject({
        connected: true,
        baseUrl: "http://127.0.0.1:8317",
        files: ["gemini-user@example.com-proj.json"],
      });
    });

    it("resyncs a single account through the sync service and stores metadata", async () => {
      writeJson(path.join(tempDir, "accounts.json"), {
        accounts: [
          {
            id: 3,
            email: "resync@example.com",
            refreshToken: "rt-resync",
            enabled: true,
            projectId: "proj-resync",
          },
        ],
      });
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
      process.env.CLIPROXY_BASE_URL = "http://127.0.0.1:8317";
      process.env.CLIPROXY_MANAGEMENT_KEY = "mock-key";

      const service = new RosettaService({ dataDir: tempDir });
      const result = await (service as any).resyncCliProxyAccount({ accountId: 3, provider: "antigravity" });

      expect(result).toMatchObject({ ok: true, remoteName: "antigravity-gfa-3-resync@example.com.json" });
      const stored = readJson(path.join(tempDir, "accounts.json"), { accounts: [] });
      expect(stored.accounts[0].cliproxySync).toMatchObject({
        desired: "enabled",
        remoteName: "antigravity-gfa-3-resync@example.com.json",
      });
    });

    it("should upload Rosetta accounts to CLIProxy", async () => {
      writeJson(path.join(tempDir, "accounts.json"), {
        accounts: [
          {
            id: 1,
            email: "upload@example.com",
            refreshToken: "rt-1",
            enabled: true,
            projectId: "proj-1",
          },
        ],
      });

      // Mock fetch: first is token exchange, second is discover project (loadCodeAssist), third is upload
      let fetchCount = 0;
      vi.stubGlobal("fetch", vi.fn(async (url) => {
        fetchCount++;
        const u = String(url);
        if (u.includes("/token")) {
          return new Response(JSON.stringify({ access_token: "at-1", expires_in: 3600 }), { status: 200 });
        }
        if (u.includes("/v1internal:loadCodeAssist")) {
          return new Response(JSON.stringify({ cloudaicompanionProject: "proj-1" }), { status: 200 });
        }
        if (u.includes("/v0/management/auth-files")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response("", { status: 404 });
      }));

      process.env.CLIPROXY_BASE_URL = "http://127.0.0.1:8317";
      process.env.CLIPROXY_MANAGEMENT_KEY = "mock-key";

      const service = new RosettaService({ dataDir: tempDir });
      const result = await service.uploadToCliProxy([1]);
      expect(result).toMatchObject({
        total: 1,
        added: 1,
        updated: 0,
        failed: 0,
      });
    });

    it("should successfully upload to CLIProxy as antigravity provider", async () => {
      writeJson(path.join(tempDir, "accounts.json"), {
        accounts: [
          {
            id: 1,
            email: "upload@example.com",
            refreshToken: "mock-refresh-token",
            enabled: true,
            projectId: "",
          },
        ],
      });

      let uploadedBody: any = null;
      let uploadedFileName = "";

      vi.stubGlobal("fetch", vi.fn(async (url, init) => {
        const u = String(url);
        if (u.includes("/token")) {
          return new Response(JSON.stringify({ access_token: "at-antigravity", expires_in: 3600 }), { status: 200 });
        }
        if (u.includes("/v1internal:loadCodeAssist")) {
          return new Response(JSON.stringify({ cloudaicompanionProject: "proj-antigravity" }), { status: 200 });
        }
        if (u.includes("/v0/management/auth-files")) {
          uploadedFileName = decodeURIComponent(new URL(u).searchParams.get("name") || "");
          uploadedBody = JSON.parse(init?.body as string);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response("", { status: 404 });
      }));

      process.env.CLIPROXY_BASE_URL = "http://127.0.0.1:8317";
      process.env.CLIPROXY_MANAGEMENT_KEY = "mock-key";

      const service = new RosettaService({ dataDir: tempDir });
      const result = await service.uploadToCliProxy([1], undefined, undefined, "antigravity");
      expect(result).toMatchObject({
        total: 1,
        added: 1,
        updated: 0,
        failed: 0,
      });
      expect(uploadedFileName).toBe("antigravity-gfa-1-upload@example.com.json");
      expect(uploadedBody).toMatchObject({
        type: "antigravity",
        email: "upload@example.com",
        project_id: "proj-antigravity",
        access_token: "at-antigravity",
        refresh_token: "mock-refresh-token",
      });
    });
  });

  describe("setAccountProxy (通用出口代理路由)", () => {
    const readProxy = (dir: string, file: string) =>
      JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")).accounts[0].proxyUrl;

    it("routes each provider to its own pool file and normalizes the proxy", () => {
      const svc = new RosettaService({ dataDir: tempDir });
      // 写在构造之后,避免 claude→anthropic 迁移动到预置文件。
      writeJson(path.join(tempDir, "anthropic-accounts.json"), { accounts: [{ id: 1, email: "a@x.com", refreshToken: "r" }] });
      writeJson(path.join(tempDir, "codex-accounts.json"), { accounts: [{ id: 2, email: "c@x.com", refreshToken: "r" }] });
      writeJson(path.join(tempDir, "accounts.json"), { accounts: [{ id: 3, email: "g@x.com", refreshToken: "r" }] });

      expect(svc.setAccountProxy({ provider: "anthropic", accountId: 1, proxyUrl: "socks5://h:1" })).toMatchObject({ ok: true, proxyUrl: "socks5://h:1" });
      expect(svc.setAccountProxy({ provider: "codex", accountId: 2, proxyUrl: "1.2.3.4:8000:u:p" })).toMatchObject({ ok: true, proxyUrl: "http://u:p@1.2.3.4:8000" });
      expect(svc.setAccountProxy({ provider: "antigravity", accountId: 3, proxyUrl: "http://h:2" })).toMatchObject({ ok: true, proxyUrl: "http://h:2" });

      expect(readProxy(tempDir, "anthropic-accounts.json")).toBe("socks5://h:1");
      expect(readProxy(tempDir, "codex-accounts.json")).toBe("http://u:p@1.2.3.4:8000");
      expect(readProxy(tempDir, "accounts.json")).toBe("http://h:2");
    });

    it("rejects an unknown provider without touching any pool", () => {
      const svc = new RosettaService({ dataDir: tempDir });
      const res = svc.setAccountProxy({ provider: "bogus", accountId: 1, proxyUrl: "socks5://h:1" });
      expect(res.ok).toBe(false);
    });
  });

  describe("syncFromPayload (Rosetta 号池 API 同步)", () => {
    it("should successfully merge accounts and access keys", async () => {
      // Setup B's initial pools
      writeJson(path.join(tempDir, "accounts.json"), {
        accounts: [
          { id: 1, email: "exist@gemini.com", refreshToken: "rt-old", enabled: true },
          { id: 2, email: "other@gemini.com", refreshToken: "rt-other", enabled: true }
        ]
      });
      writeJson(path.join(tempDir, "codex-accounts.json"), {
        accounts: [
          { id: 2, email: "exist@codex.com", refreshToken: "rt-codex-old", enabled: true }
        ]
      });
      writeJson(path.join(tempDir, "access-keys.json"), {
        keys: [
          { id: "k-1", key: "key-1", name: "Card 1" }
        ]
      });

      const service = new RosettaService({ dataDir: tempDir });

      const res = await service.syncFromPayload({
        accounts: [
          { id: 1, email: "exist@gemini.com", refreshToken: "rt-new", enabled: false },
          { id: 2, email: "new2@gemini.com", refreshToken: "rt-new-gemini", enabled: true } // ID 2 is occupied by other@gemini.com on B
        ],
        codex: [
          { id: 2, email: "exist@codex.com", refreshToken: "rt-codex-new", enabled: true },
          { id: 3, email: "new@codex.com", refreshToken: "rt-new-codex", enabled: true }
        ],
        keys: [
          { id: "k-2", key: "key-2", name: "Card 2", bindings: { antigravity: 2, codex: 3 } }
        ]
      });

      expect(res.success).toBe(true);

      // Verify B's merged accounts.json
      const bGemini = readJson(path.join(tempDir, "accounts.json"), { accounts: [] }).accounts;
      expect(bGemini).toHaveLength(3);
      const existAcc = bGemini.find((a: any) => a.email === "exist@gemini.com");
      expect(existAcc.refreshToken).toBe("rt-new");
      expect(existAcc.enabled).toBe(false); // updated
      expect(existAcc.id).toBe(1); // kept remote ID

      const new2Acc = bGemini.find((a: any) => a.email === "new2@gemini.com");
      expect(new2Acc.refreshToken).toBe("rt-new-gemini");
      expect(new2Acc.id).toBe(3); // collision resolved: max(1, 2) + 1 = 3

      // Verify B's merged codex-accounts.json
      const bCodex = readJson(path.join(tempDir, "codex-accounts.json"), { accounts: [] }).accounts;
      expect(bCodex).toHaveLength(2);

      // Verify B's merged access-keys.json
      const bKeys = readJson(path.join(tempDir, "access-keys.json"), { keys: [] }).keys;
      expect(bKeys).toHaveLength(2); // k-1 (old) + k-2 (new)
      const k2 = bKeys.find((k: any) => k.id === "k-2");
      expect(k2.bindings).toMatchObject({
        antigravity: 3, // mapped: 2 -> new2@gemini.com -> 3
        codex: 3 // mapped: 3 -> new@codex.com -> 3 (no collision)
      });
    });
  });
});
