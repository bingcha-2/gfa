import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CodexService } from "../codex.service";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const stubAccessKey = {
  boundCardCounts: () => new Map<number, number>(),
  boundSharesByAccount: () => new Map<number, number>(),
} as any;

describe("listCodexAccounts exposes persisted dead status", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-codex-list-"));
    writeJson(path.join(dataDir, "codex-accounts.json"), {
      accounts: [
        {
          id: 1,
          email: "dead@example.com",
          refreshToken: "rt-1",
          enabled: true,
          quotaStatus: "error",
          quotaStatusReason: "consecutive_errors",
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
    const svc = new CodexService({ dataDir } as any, stubAccessKey);
    const res = svc.listCodexAccounts();

    const dead = res.accounts.find((a: any) => a.id === 1);
    const ok = res.accounts.find((a: any) => a.id === 2);

    expect(dead.quotaStatus).toBe("error");
    expect(dead.quotaStatusReason).toBe("consecutive_errors");
    expect(ok.quotaStatus).toBe("ok");
  });
});
