import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClaudeAccountService } from "../claude-account.service";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const stubAccessKey = {
  boundCardCounts: () => new Map<number, number>(),
  boundSharesByAccount: () => new Map<number, number>(),
} as any;

/**
 * The console's account pages read this listing. The dead-account verdict is now
 * persisted onto the account record (by lease-service), so the listing must pass
 * it through — otherwise the panel can't show which accounts are dead.
 */
describe("listClaudeAccounts exposes persisted dead status", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-claude-list-"));
    writeJson(path.join(dataDir, "anthropic-accounts.json"), {
      accounts: [
        {
          id: 1,
          email: "dead@example.com",
          refreshToken: "rt-1",
          enabled: true,
          quotaStatus: "error",
          quotaStatusReason: "invalid_grant",
          blockedUntil: 1234567890,
        },
        { id: 2, email: "ok@example.com", refreshToken: "rt-2", enabled: true },
      ],
    });
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("includes quotaStatus / quotaStatusReason for each account", () => {
    const svc = new ClaudeAccountService({ dataDir } as any, stubAccessKey);
    const res = svc.listClaudeAccounts();

    const dead = res.accounts.find((a: any) => a.id === 1);
    const ok = res.accounts.find((a: any) => a.id === 2);

    expect(dead.quotaStatus).toBe("error");
    expect(dead.quotaStatusReason).toBe("invalid_grant");
    // A healthy account reports "ok" (not undefined) so the UI can render a green dot.
    expect(ok.quotaStatus).toBe("ok");
  });
});

describe("startAutoClaudeOAuth SK direct login", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-claude-sk-"));
    writeJson(path.join(dataDir, "anthropic-accounts.json"), { accounts: [] });
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("accepts sessionKey onboarding without a mailbox password", () => {
    const svc = new ClaudeAccountService({ dataDir } as any, stubAccessKey);
    const run = vi.spyOn(svc as any, "runAutoOAuth").mockResolvedValue(undefined);

    const res = svc.startAutoClaudeOAuth({
      email: "sk-user@example.com",
      password: "",
      proxyUrl: "",
      adspowerProfileId: "k1bvbavq",
      sessionKey: "sk-ant-sid02-AbCdEf1234567890",
    });

    expect(res.ok).toBe(true);
    expect(run).toHaveBeenCalledWith(
      expect.any(String),
      "sk-user@example.com",
      "",
      "",
      "k1bvbavq",
      undefined,
      undefined,
      "sk-ant-sid02-AbCdEf1234567890",
    );
  });
});
