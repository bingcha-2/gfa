import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import { describe, it, expect, vi } from "vitest";
import { codexFingerprintLease, codexFingerprintProbeHeaders, assertCodexFingerprintProxy, CODEX_FINGERPRINT_CLIENT_V1, codexUpstreamFetch } from "../codex-fingerprint";
import { proxyAwareFetch, proxyRequiredFetch } from "../../lease-core/egress";
import { refreshCodexAccessToken } from "../auth/codex-token-provider";
import { fetchCodexQuotaUpstream } from "../auth/codex-usage";
import { fetchCodexSubscription } from "../auth/codex-subscription";
import { fetchCodexResetCredits, consumeCodexResetCredit } from "../auth/codex-reset-credits";

vi.mock("../../lease-core/egress", () => ({ proxyAwareFetch: vi.fn(), proxyRequiredFetch: vi.fn() }));
import { CodexProvider } from "../codex.provider";
import { RosettaService } from "../../rosetta/rosetta.service";

describe("Codex fingerprint identity lifecycle", () => {
  it("defaults off, rejects invalid seeds, and does not expose its storage seed", () => {
    expect(codexFingerprintLease({})).toBeUndefined();
    expect(codexFingerprintLease({ codexFingerprintMode: "session", codexFingerprintSeed: "1" })).toBeUndefined();
    const account = { id: 1, email: "a", refreshToken: "rt", codexFingerprintMode: "session", codexFingerprintSeed: randomUUID() };
    const extras = new CodexProvider().leaseIdentityExtras(account);
    expect(extras.codexFingerprint).toEqual(codexFingerprintLease(account));
    expect(JSON.stringify(extras)).not.toContain(account.codexFingerprintSeed);
    expect(codexFingerprintProbeHeaders(account)).toEqual({
      "x-codex-installation-id": codexFingerprintLease(account)!.installationId,
      "User-Agent": CODEX_FINGERPRINT_CLIENT_V1.userAgent, Originator: CODEX_FINGERPRINT_CLIENT_V1.originator, Version: CODEX_FINGERPRINT_CLIENT_V1.version,
    });
  });

  it("persists across restart, edits and disabling; isolates accounts and deployments with reused numeric IDs", () => {
    const dirs = [fs.mkdtempSync(path.join(os.tmpdir(), "gfa-fp-")), fs.mkdtempSync(path.join(os.tmpdir(), "gfa-fp-"))];
    try {
      const identities = dirs.map(dataDir => {
        const service = new RosettaService({ dataDir });
        service.addCodexAccount({ email: "test@example.test", refreshToken: "rt", proxyUrl: "http://exit.test:8080" });
        expect(service.setCodexFingerprint({ accountId: 1, mode: "bad" }).ok).toBe(false);
        expect(service.setCodexFingerprint({ accountId: 999, mode: "device" }).ok).toBe(false);
        expect(service.setCodexFingerprint({ accountId: 1, mode: "session", codexFingerprintSeed: randomUUID() }).ok).toBe(true);
        const read = () => JSON.parse(fs.readFileSync(path.join(dataDir, "codex-accounts.json"), "utf8")).accounts[0];
        const before = codexFingerprintLease(read());
        const restarted = new RosettaService({ dataDir });
        expect(restarted.listCodexAccounts().accounts[0].codexFingerprintMode).toBe("session");
        expect(JSON.stringify(restarted.listCodexAccounts())).not.toContain(read().codexFingerprintSeed);
        restarted.setCodexFingerprint({ accountId: 1, mode: "off" });
        expect(codexFingerprintLease(read())).toBeUndefined();
        restarted.setCodexFingerprint({ accountId: 1, mode: "session" });
        expect(codexFingerprintLease(read())).toEqual(before);
        restarted.importCodexAccountFromText({ text: JSON.stringify({ email: "test@example.test", refresh_token: "new-token" }) });
        expect(codexFingerprintLease(read())).toEqual(before);
        return before;
      });
      expect(identities[0]!.installationId).not.toBe(identities[1]!.installationId);
    } finally {
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires a supported bound exit even with a cached token, and never calls the direct fetch on failure", async () => {
    vi.clearAllMocks();
    const account = { id: 1, email: "a", refreshToken: "rt", codexFingerprintMode: "device", accessToken: "cached", accessTokenExpiresAt: Date.now() + 3600_000 };
    for (const proxyUrl of [undefined, "direct", "ftp://exit:21", "http://", "http://exit:0", "http://exit:99999", "http://exit/path", "socks4://exit:1080"]) {
      expect(() => assertCodexFingerprintProxy({ ...account, proxyUrl })).toThrow();
      await expect(refreshCodexAccessToken({ ...account, proxyUrl })).rejects.toThrow();
    }
    for (const proxyUrl of ["http://exit:8080", "https://exit:443", "socks5://user:pass@exit:1080", "socks5h://exit:1080"]) {
      expect(() => assertCodexFingerprintProxy({ ...account, proxyUrl })).not.toThrow();
    }
    vi.mocked(proxyRequiredFetch).mockRejectedValueOnce(new Error("proxy unavailable"));
    await expect(codexUpstreamFetch("http://exit:8080", "https://example.test", {}, account)).rejects.toThrow("proxy unavailable");
    expect(proxyRequiredFetch).toHaveBeenCalledTimes(1);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("rejects enabling without a proxy without changing the stored setting; off remains available", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-fp-egress-"));
    try {
      const service = new RosettaService({ dataDir });
      service.addCodexAccount({ email: "a@example.test", refreshToken: "rt" });
      expect(service.setCodexFingerprint({ accountId: 1, mode: "device" })).toMatchObject({ ok: false });
      expect(service.listCodexAccounts().accounts[0].codexFingerprintMode).toBe("off");
      expect(service.setCodexFingerprint({ accountId: 1, mode: "off" }).ok).toBe(true);
    } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  });

  it("carries the fixed profile on token refresh and keeps every management probe on the bound exit", async () => {
    vi.clearAllMocks();
    const account = { email: "test@example.test", refreshToken: "rt", proxyUrl: "http://exit:8080", codexFingerprintMode: "device", codexFingerprintSeed: randomUUID() };
    vi.mocked(proxyRequiredFetch).mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { status: 200 }));
    expect(await refreshCodexAccessToken(account)).toBe("access");
    expect(proxyRequiredFetch).toHaveBeenCalledWith(account.proxyUrl, "https://auth.openai.com/oauth/token", expect.objectContaining({ headers: expect.objectContaining(codexFingerprintProbeHeaders(account)) }));
    vi.mocked(proxyRequiredFetch).mockRejectedValue(new Error("exit unavailable"));
    expect(await fetchCodexQuotaUpstream("access", account.proxyUrl, account)).toBeNull();
    await expect(fetchCodexSubscription("access", account.proxyUrl, account)).rejects.toThrow();
    await expect(fetchCodexResetCredits("access", account.proxyUrl, account)).rejects.toThrow();
    await expect(consumeCodexResetCredit("access", account.proxyUrl, account)).rejects.toThrow();
    expect(proxyRequiredFetch).toHaveBeenCalledTimes(5);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });
});
