import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AccountLevelsService } from "../account-levels.service";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * AccountLevelsService 把"该产品账号池里实际存在的 planType"去重列出,供 console 套餐配置
 * 页绑定线等级从下拉里选(账号池里没有的等级选不了)—— 根除"档名对不上→绑不上"。
 * 池文件:anthropic→anthropic-accounts.json,codex→codex-accounts.json,antigravity→accounts.json。
 */
describe("AccountLevelsService.listLevels", () => {
  let dataDir: string;
  let svc: AccountLevelsService;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-acct-levels-"));
    svc = new AccountLevelsService(dataDir);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns the distinct, non-empty planTypes in an anthropic pool", () => {
    writeJson(path.join(dataDir, "anthropic-accounts.json"), {
      accounts: [
        { id: 1, email: "a@x.com", planType: "max-20x" },
        { id: 2, email: "b@x.com", planType: "max-5x" },
        { id: 3, email: "c@x.com", planType: "max-20x" }, // dup
        { id: 4, email: "d@x.com", planType: "pro" },
      ],
    });

    const res = svc.listLevels("anthropic");

    expect(res.ok).toBe(true);
    // 去重 + 排序(稳定可断言)。
    expect(res.levels).toEqual(["max-20x", "max-5x", "pro"]);
  });

  it("excludes empty / whitespace / missing planType values", () => {
    writeJson(path.join(dataDir, "codex-accounts.json"), {
      accounts: [
        { id: 1, email: "a@x.com", planType: "plus" },
        { id: 2, email: "b@x.com", planType: "" }, // empty
        { id: 3, email: "c@x.com", planType: "   " }, // whitespace
        { id: 4, email: "d@x.com" }, // missing
        { id: 5, email: "e@x.com", planType: "pro" },
      ],
    });

    const res = svc.listLevels("codex");

    expect(res.levels).toEqual(["plus", "pro"]);
  });

  it("maps antigravity to accounts.json", () => {
    writeJson(path.join(dataDir, "accounts.json"), {
      accounts: [
        { id: 1, email: "a@x.com", planType: "ultra" },
        { id: 2, email: "b@x.com", planType: "pro" },
      ],
    });

    const res = svc.listLevels("antigravity");

    expect(res.levels).toEqual(["pro", "ultra"]);
  });

  it("returns an empty list (ok) when the pool file is missing", () => {
    const res = svc.listLevels("anthropic");
    expect(res.ok).toBe(true);
    expect(res.levels).toEqual([]);
  });

  it("rejects an unknown product", () => {
    const res = svc.listLevels("bogus");
    expect(res.ok).toBe(false);
    expect(res.levels).toEqual([]);
  });

  it("trims surrounding whitespace on planType before dedup", () => {
    writeJson(path.join(dataDir, "anthropic-accounts.json"), {
      accounts: [
        { id: 1, email: "a@x.com", planType: " pro " },
        { id: 2, email: "b@x.com", planType: "pro" },
      ],
    });

    const res = svc.listLevels("anthropic");
    expect(res.levels).toEqual(["pro"]);
  });
});
