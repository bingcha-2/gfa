import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setAccountEnabled } from "../pool";
import { readJson, writeJson } from "../store";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-spec-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("setAccountEnabled", () => {
  it("flips the enabled flag of the matching account", () => {
    const file = "codex-accounts.json";
    writeJson(path.join(dir, file), { accounts: [{ id: 1, enabled: true }, { id: 2, enabled: true }] });

    setAccountEnabled(dir, file, 1, false);

    const data = readJson(path.join(dir, file), { accounts: [] });
    expect(data.accounts.find((a: any) => a.id === 1).enabled).toBe(false);
    expect(data.accounts.find((a: any) => a.id === 2).enabled).toBe(true);
    expect(typeof data.updatedAt).toBe("string");
  });

  it("is a no-op when the account id is not found", () => {
    const file = "accounts.json";
    writeJson(path.join(dir, file), { accounts: [{ id: 1, enabled: true }] });
    const before = fs.readFileSync(path.join(dir, file), "utf8");

    setAccountEnabled(dir, file, 999, false);

    expect(fs.readFileSync(path.join(dir, file), "utf8")).toBe(before); // unchanged
  });

  it("is a no-op (no throw) when the pool file does not exist", () => {
    expect(() => setAccountEnabled(dir, "missing.json", 1, false)).not.toThrow();
    expect(fs.existsSync(path.join(dir, "missing.json"))).toBe(false);
  });
});
