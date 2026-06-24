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
