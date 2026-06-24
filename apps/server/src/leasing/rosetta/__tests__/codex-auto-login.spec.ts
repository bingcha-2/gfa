import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodexService } from "../codex.service";
import { writeJson } from "../lib/store";
import { runCodexBrowserLogin } from "../lib/codex-login-browser";

vi.mock("../lib/codex-login-browser", async (orig) => ({
  ...(await (orig as any)()),
  runCodexBrowserLogin: vi.fn(async () => ({ ok: false, error: "stop-after-validation" })),
}));

const stubAccessKey = {
  boundCardCounts: () => new Map<number, number>(),
  boundSharesByAccount: () => new Map<number, number>(),
} as any;

describe("Codex automated login", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-codex-auto-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("allows phoneNumber and smsUrl to be omitted until the flow reaches phone verification", async () => {
    const svc = new CodexService({ dataDir, codexOAuthPort: 1455 } as any, stubAccessKey);

    const result = svc.startAutomatedCodexLogin({
      email: "outlook-user@example.test",
      password: "mail-password",
      proxyUrl: "socks5://user:pass@198.51.100.10:443",
      adspowerProfileId: "profile-1",
    });

    expect(result).toMatchObject({ ok: true, jobId: expect.any(String) });
    await vi.waitFor(() => expect(runCodexBrowserLogin).toHaveBeenCalled());
    expect(runCodexBrowserLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "outlook-user@example.test",
        phoneNumber: "",
        smsUrl: "",
        adspowerProfileId: "profile-1",
      }),
    );
  });

  it("persists the AdsPower profile id on the saved Codex account after OAuth exchange", async () => {
    const tokenFetch = vi.fn(async () => new Response(JSON.stringify({
      id_token: "eyJhbGciOiJub25lIn0.eyJlbWFpbCI6ImF1dG9Ab3BlbmFpLnRlc3QifQ.sig",
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
    }), { status: 200 }));
    vi.mocked(runCodexBrowserLogin).mockResolvedValueOnce({ ok: true, code: "oauth-code" });
    const svc = new CodexService({ dataDir, codexOAuthPort: 1455, codexOAuthFetch: tokenFetch } as any, stubAccessKey);

    const result = svc.startAutomatedCodexLogin({
      email: "auto@openai.test",
      password: "mail-password",
      proxyUrl: "socks5://user:pass@198.51.100.10:443",
      adspowerProfileId: "profile-1",
    });

    expect(result).toMatchObject({ ok: true });
    await vi.waitFor(() => {
      const stored = JSON.parse(fs.readFileSync(path.join(dataDir, "codex-accounts.json"), "utf8"));
      expect(stored.accounts[0]).toMatchObject({
        email: "auto@openai.test",
        adspowerProfileId: "profile-1",
        proxyUrl: "socks5://user:pass@198.51.100.10:443",
      });
    });
  });

  it("exposes profile metadata in listCodexAccounts", () => {
    writeJson(path.join(dataDir, "codex-accounts.json"), {
      accounts: [{
        id: 3,
        email: "listed@openai.test",
        refreshToken: "rt",
        adspowerProfileId: "profile-3",
        adspowerProfileStatus: "active",
      }],
    });
    const svc = new CodexService({ dataDir } as any, stubAccessKey);

    expect(svc.listCodexAccounts().accounts[0]).toMatchObject({
      adspowerProfileId: "profile-3",
      adspowerProfileStatus: "active",
    });
  });
});
