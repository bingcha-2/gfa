import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ensureAdspowerProfileForAccount,
  parseProxyToAdsPowerUserConfig,
} from "../adspower-profile-manager";
import { writeJson } from "../store";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-adspower-profile-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function mockClient(overrides: Record<string, unknown> = {}) {
  return {
    listProfiles: vi.fn(async () => []),
    createProfile: vi.fn(async () => ({ profileId: "created-profile" })),
    deleteProfiles: vi.fn(async () => {}),
    checkProfile: vi.fn(async () => ({ active: false })),
    ...overrides,
  } as any;
}

describe("parseProxyToAdsPowerUserConfig", () => {
  it("maps a SOCKS5 proxy URL into AdsPower user_proxy_config", () => {
    expect(parseProxyToAdsPowerUserConfig("socks5://user:pass@198.51.100.10:443")).toMatchObject({
      proxy_soft: "other",
      proxy_type: "socks5",
      proxy_host: "198.51.100.10",
      proxy_port: "443",
      proxy_user: "user",
      proxy_password: "pass",
    });
  });

  it("normalizes socks5h to socks5 instead of dropping the proxy", () => {
    expect(parseProxyToAdsPowerUserConfig("socks5h://user:pass@198.51.100.10:443")).toMatchObject({
      proxy_type: "socks5",
      proxy_host: "198.51.100.10",
      proxy_port: "443",
    });
  });
});

describe("ensureAdspowerProfileForAccount", () => {
  it("creates and binds a new Codex profile from the account proxy", async () => {
    const account: any = {
      id: 1,
      email: "new@openai.test",
      proxyUrl: "socks5://user:pass@198.51.100.10:443",
    };
    const client = mockClient();

    const result = await ensureAdspowerProfileForAccount({
      dataDir,
      provider: "codex",
      account,
      client,
      now: () => new Date("2026-06-25T00:00:00.000Z"),
      profileCap: 10,
    });

    expect(result).toMatchObject({ ok: true, profileId: "created-profile", created: true });
    expect(account).toMatchObject({
      adspowerProfileId: "created-profile",
      adspowerProfileStatus: "active",
      adspowerProfileProvider: "codex",
    });
    expect(client.createProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.stringContaining("codex-new@openai.test"),
        domainName: "auth.openai.com",
        openUrls: ["https://auth.openai.com"],
        proxyConfig: expect.objectContaining({ proxy_type: "socks5" }),
      }),
    );
  });

  it("creates a per-account sticky Claude profile with the static IP baked into the profile", async () => {
    const account: any = {
      id: 0,
      email: "claude@pool.test",
      // Raw host:port:user:pass — the anthropic provider normalizes it to socks5 before baking in.
      proxyUrl: "198.51.100.10:443:user:pass",
    };
    const client = mockClient();

    const result = await ensureAdspowerProfileForAccount({
      dataDir,
      provider: "anthropic",
      account,
      client,
      now: () => new Date("2026-06-25T00:00:00.000Z"),
      profileCap: 10,
    });

    expect(result).toMatchObject({ ok: true, profileId: "created-profile", created: true });
    // Proxy is persisted into the profile (user_proxy_config) at create time, not injected per-run.
    expect(client.createProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.stringContaining("anthropic-claude@pool.test"),
        domainName: "claude.ai",
        proxyConfig: expect.objectContaining({
          proxy_type: "socks5",
          proxy_host: "198.51.100.10",
          proxy_port: "443",
        }),
      }),
    );
    // The account is bound to its own profile and the proxy is normalized back onto it.
    expect(account).toMatchObject({
      adspowerProfileId: "created-profile",
      adspowerProfileProvider: "anthropic",
      proxyUrl: "socks5://user:pass@198.51.100.10:443",
    });
  });

  it("rebuilds a fresh profile when the bound profile is missing and rebuild is allowed", async () => {
    const account: any = {
      id: 2,
      email: "evicted@claude.test",
      proxyUrl: "socks5://127.0.0.1:1080",
      adspowerProfileId: "trashed-profile",
    };
    const client = mockClient({ listProfiles: vi.fn(async () => [{ userId: "someone-else" }]) });

    const result = await ensureAdspowerProfileForAccount({
      dataDir,
      provider: "anthropic",
      account,
      client,
      now: () => new Date("2026-06-25T00:00:00.000Z"),
      profileCap: 10,
      allowRebuildOnMissing: true,
    });

    expect(result).toMatchObject({ ok: true, profileId: "created-profile", created: true });
    expect(client.createProfile).toHaveBeenCalled();
    expect(account.adspowerProfileId).toBe("created-profile");
  });

  it("migrates an account off a shared legacy profile to its own when rebuild is allowed", async () => {
    // Two accounts share one legacy profile (the old fixed Claude profile). Re-onboarding one of
    // them must mint a personal profile instead of reusing the shared one.
    writeJson(path.join(dataDir, "anthropic-accounts.json"), {
      accounts: [
        { id: 1, email: "a@claude.test", adspowerProfileId: "legacy-shared", proxyUrl: "socks5://127.0.0.1:1080" },
        { id: 2, email: "b@claude.test", adspowerProfileId: "legacy-shared", proxyUrl: "socks5://127.0.0.1:1080" },
      ],
    });
    const account: any = { id: 1, email: "a@claude.test", proxyUrl: "socks5://127.0.0.1:1080", adspowerProfileId: "legacy-shared" };
    const client = mockClient({ listProfiles: vi.fn(async () => [{ userId: "legacy-shared" }]) });

    const result = await ensureAdspowerProfileForAccount({
      dataDir,
      provider: "anthropic",
      account,
      client,
      now: () => new Date("2026-06-25T00:00:00.000Z"),
      profileCap: 10,
      allowRebuildOnMissing: true,
    });

    expect(result).toMatchObject({ ok: true, profileId: "created-profile", created: true });
    expect(account.adspowerProfileId).toBe("created-profile");
    // The shared legacy profile is not touched (still owned by account #2).
    expect(client.deleteProfiles).not.toHaveBeenCalled();
  });

  it("reuses a personal (unshared) bound profile without rebuilding even when rebuild is allowed", async () => {
    writeJson(path.join(dataDir, "anthropic-accounts.json"), {
      accounts: [{ id: 1, email: "solo@claude.test", adspowerProfileId: "personal-profile", proxyUrl: "socks5://127.0.0.1:1080" }],
    });
    const account: any = { id: 1, email: "solo@claude.test", proxyUrl: "socks5://127.0.0.1:1080", adspowerProfileId: "personal-profile" };
    const client = mockClient({ listProfiles: vi.fn(async () => [{ userId: "personal-profile" }]) });

    const result = await ensureAdspowerProfileForAccount({
      dataDir,
      provider: "anthropic",
      account,
      client,
      now: () => new Date("2026-06-25T00:00:00.000Z"),
      profileCap: 10,
      allowRebuildOnMissing: true,
    });

    expect(result).toMatchObject({ ok: true, profileId: "personal-profile", created: false });
    expect(client.createProfile).not.toHaveBeenCalled();
  });

  it("requires manual restore instead of silently creating a second profile when a bound profile is missing", async () => {
    const account: any = {
      id: 2,
      email: "bound@openai.test",
      proxyUrl: "socks5://127.0.0.1:1080",
      adspowerProfileId: "missing-profile",
    };
    const client = mockClient({ listProfiles: vi.fn(async () => [{ userId: "someone-else" }]) });

    const result = await ensureAdspowerProfileForAccount({
      dataDir,
      provider: "codex",
      account,
      client,
      now: () => new Date("2026-06-25T00:00:00.000Z"),
      profileCap: 10,
    });

    expect(result).toMatchObject({ ok: false, needsRestore: true, profileId: "missing-profile" });
    expect(account.adspowerProfileStatus).toBe("trashed");
    expect(client.createProfile).not.toHaveBeenCalled();
  });

  it("never evicts a profile shared by multiple accounts, even when it is the oldest idle one", async () => {
    // Claude accounts all share one fixed profile (N:1). Deleting it would break every Claude
    // account at once, so cross-provider cap eviction must skip shared profiles entirely.
    writeJson(path.join(dataDir, "anthropic-accounts.json"), {
      accounts: [
        { id: 1, email: "a@claude.test", adspowerProfileId: "shared-k1", adspowerProfileStatus: "active", adspowerProfileLastUsedAt: "2026-06-01T00:00:00.000Z" },
        { id: 2, email: "b@claude.test", adspowerProfileId: "shared-k1", adspowerProfileStatus: "active", adspowerProfileLastUsedAt: "2026-06-01T00:00:00.000Z" },
      ],
    });
    writeJson(path.join(dataDir, "codex-accounts.json"), {
      accounts: [
        { id: 9, email: "solo@openai.test", adspowerProfileId: "solo-codex", adspowerProfileStatus: "active", adspowerProfileLastUsedAt: "2026-06-20T00:00:00.000Z" },
      ],
    });
    const account: any = {
      id: 10,
      email: "fresh@openai.test",
      proxyUrl: "socks5://127.0.0.1:1080",
    };
    const client = mockClient({
      listProfiles: vi.fn(async () => [{ userId: "shared-k1" }, { userId: "solo-codex" }]),
    });

    const result = await ensureAdspowerProfileForAccount({
      dataDir,
      provider: "codex",
      account,
      client,
      now: () => new Date("2026-06-25T12:00:00.000Z"),
      profileCap: 2,
      protectMinutes: 60,
    });

    // The shared Claude profile is older, so the buggy version would delete it first.
    expect(client.deleteProfiles).toHaveBeenCalledWith(["solo-codex"]);
    expect(client.deleteProfiles).not.toHaveBeenCalledWith(["shared-k1"]);
    expect(result).toMatchObject({ ok: true, created: true, deletedProfileId: "solo-codex" });
  });

  it("deletes the oldest safe idle profile into Trash before creating when the profile cap is full", async () => {
    writeJson(path.join(dataDir, "codex-accounts.json"), {
      accounts: [
        {
          id: 9,
          email: "old@openai.test",
          adspowerProfileId: "old-profile",
          adspowerProfileStatus: "active",
          adspowerProfileLastUsedAt: "2026-06-20T00:00:00.000Z",
        },
      ],
    });
    const account: any = {
      id: 10,
      email: "fresh@openai.test",
      proxyUrl: "socks5://127.0.0.1:1080",
    };
    const client = mockClient({
      listProfiles: vi.fn(async () => [{ userId: "old-profile" }]),
    });

    const result = await ensureAdspowerProfileForAccount({
      dataDir,
      provider: "codex",
      account,
      client,
      now: () => new Date("2026-06-25T12:00:00.000Z"),
      profileCap: 1,
      protectMinutes: 60,
    });

    expect(result).toMatchObject({ ok: true, created: true, deletedProfileId: "old-profile" });
    expect(client.deleteProfiles).toHaveBeenCalledWith(["old-profile"]);
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, "codex-accounts.json"), "utf8"));
    expect(stored.accounts[0]).toMatchObject({
      adspowerProfileId: "old-profile",
      adspowerProfileStatus: "trashed",
    });
  });
});
