import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RosettaService } from "../rosetta.service";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("RosettaService — file cache", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-rosetta-cache-"));
    writeJson(path.join(tempDir, "access-keys.json"), {
      keys: [
        { id: "k1", key: "BCAI-KEY1", status: "active", name: "test1" },
        { id: "k2", key: "BCAI-KEY2", status: "active", name: "test2" },
      ],
    });
    writeJson(path.join(tempDir, "accounts.json"), {
      accounts: [
        { id: 1, email: "a@test.com", refreshToken: "rt1", projectId: "p1", enabled: true },
        { id: 2, email: "b@test.com", refreshToken: "rt2", projectId: "p2", enabled: true },
      ],
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeService() {
    return new RosettaService({ dataDir: tempDir });
  }

  it("listAccounts returns consistent data on repeat calls", () => {
    const service = makeService();

    const first = service.listAccounts();
    const second = service.listAccounts();

    expect(first.accounts).toHaveLength(2);
    expect(second.accounts).toHaveLength(2);
  });

  it("listAccounts reflects file changes", () => {
    const service = makeService();

    const first = service.listAccounts();
    expect(first.accounts).toHaveLength(2);

    writeJson(path.join(tempDir, "accounts.json"), {
      accounts: [
        { id: 1, email: "a@test.com", refreshToken: "rt1", projectId: "p1" },
      ],
    });

    const second = service.listAccounts();
    expect(second.accounts).toHaveLength(1);
  });
});
