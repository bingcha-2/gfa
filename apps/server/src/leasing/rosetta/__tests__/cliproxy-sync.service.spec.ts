import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CliProxySyncService } from "../cliproxy-sync.service";

const writeJson = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
};

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-cliproxy-sync-"));
  process.env.CLIPROXY_BASE_URL = "http://127.0.0.1:8317";
  process.env.CLIPROXY_MANAGEMENT_KEY = "mgmt";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CLIPROXY_BASE_URL;
  delete process.env.CLIPROXY_MANAGEMENT_KEY;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("CliProxySyncService", () => {
  it("uploads enabled antigravity accounts with a gfa-id remote name and stores sync metadata", async () => {
    writeJson(path.join(dir, "accounts.json"), {
      accounts: [
        {
          id: 7,
          email: "u@example.com",
          refreshToken: "rt",
          projectId: "p",
          enabled: true,
        },
      ],
    });

    let uploadedName = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const u = String(url);
        if (u.includes("/v0/management/auth-files?name=")) {
          uploadedName = decodeURIComponent(new URL(u).searchParams.get("name") || "");
          expect(JSON.parse(String(init?.body))).toMatchObject({
            type: "antigravity",
            email: "u@example.com",
            project_id: "p",
            gfa_account_id: 7,
            gfa_revision: 1,
          });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (u.includes("/v0/management/auth-files")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        return new Response("", { status: 404 });
      }),
    );

    const svc = new CliProxySyncService({ dataDir: dir, logger: console as any });
    const result = await svc.syncAccount(7, "antigravity");

    expect(result.ok).toBe(true);
    expect(uploadedName).toBe("antigravity-gfa-7-u@example.com.json");
    const stored = JSON.parse(fs.readFileSync(path.join(dir, "accounts.json"), "utf8"));
    expect(stored.accounts[0].cliproxySync).toMatchObject({
      desired: "enabled",
      remoteName: uploadedName,
      remoteProvider: "antigravity",
      revision: 1,
    });
  });

  it("ignores stale revision reports and accepts current invalid_grant reports", async () => {
    writeJson(path.join(dir, "accounts.json"), {
      accounts: [
        {
          id: 9,
          email: "bad@example.com",
          refreshToken: "rt",
          cliproxySync: {
            desired: "enabled",
            remoteProvider: "antigravity",
            remoteName: "antigravity-gfa-9-bad@example.com.json",
            revision: 3,
            tokenHash: "h",
            lastSyncedAt: 1,
            lastSeenAt: 1,
            lastError: "",
          },
        },
      ],
    });
    const lease = { applyExternalAccountFailure: vi.fn(() => ({ ok: true, action: "auth_dead" })) };
    const svc = new CliProxySyncService({ dataDir: dir, logger: console as any });

    expect(await svc.handleReport({
      gfaAccountId: 9,
      remoteName: "antigravity-gfa-9-bad@example.com.json",
      revision: 2,
      provider: "antigravity",
      model: "gemini-3.1-flash-image",
      status: 400,
      reason: "invalid_grant",
    }, lease as any)).toMatchObject({ ok: true, ignored: true, reason: "stale_revision" });

    expect(await svc.handleReport({
      gfaAccountId: 9,
      remoteName: "antigravity-gfa-9-bad@example.com.json",
      revision: 3,
      provider: "antigravity",
      model: "gemini-3.1-flash-image",
      status: 400,
      reason: "invalid_grant",
    }, lease as any)).toMatchObject({ ok: true, action: "auth_dead" });
    expect(lease.applyExternalAccountFailure).toHaveBeenCalledOnce();
  });

  it("reconcile uploads missing enabled accounts and marks unmanaged remote files", async () => {
    writeJson(path.join(dir, "accounts.json"), {
      accounts: [
        {
          id: 10,
          email: "sync@example.com",
          refreshToken: "rt",
          projectId: "p",
          enabled: true,
        },
      ],
    });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        calls.push(u);
        if (u.endsWith("/v0/management/auth-files")) {
          return new Response(JSON.stringify(["manual.json"]), { status: 200 });
        }
        if (u.includes("/v0/management/auth-files?name=")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response("", { status: 404 });
      }),
    );

    const svc = new CliProxySyncService({ dataDir: dir, logger: console as any });
    const out = await svc.reconcile();

    expect(out.uploaded).toContain(10);
    expect(out.unmanaged).toContain("manual.json");
    expect(calls.some((call) => decodeURIComponent(call).includes("antigravity-gfa-10-sync@example.com.json"))).toBe(true);
  });
});
