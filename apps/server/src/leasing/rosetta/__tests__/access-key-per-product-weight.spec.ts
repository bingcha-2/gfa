import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AccessKeyService } from "../access-key.service";
import { cardWeight, cardWeightFor } from "../lib/access-key-util";
import { ACCOUNT_SHARE_CAPACITY } from "../../token-server/token-billing";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// 一张卡按【产品】分别设份额:anthropic 1 份、codex 2 份(= 1/4 号)。老卡只有 weight → 各产品回退它。
describe("per-product share weight (weights[product])", () => {
  describe("cardWeightFor 解析", () => {
    it("per-product 覆盖优先,缺省回退卡级 weight,夹到 [1,8]", () => {
      const k = { weight: 1, weights: { anthropic: 1, codex: 2 } };
      expect(cardWeightFor(k, "anthropic")).toBe(1);
      expect(cardWeightFor(k, "codex")).toBe(2);
      expect(cardWeightFor(k, "antigravity")).toBe(1); // 未设 → 回退 weight=1
      expect(cardWeightFor({ weight: 4 }, "codex")).toBe(4); // 老卡:无 weights → 卡级 4
      expect(cardWeightFor({ weight: 1, weights: { codex: 99 } }, "codex")).toBe(ACCOUNT_SHARE_CAPACITY); // 夹到容量上限
      expect(cardWeight({ weight: 3 })).toBe(3); // 卡级默认不受影响
    });
  });

  describe("createAccessKey 落库 + 按产品份额会计", () => {
    let dataDir: string;
    let keysFile: string;

    beforeEach(() => {
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-perprod-weight-"));
      keysFile = path.join(dataDir, "access-keys.json");
      writeJson(keysFile, { keys: [] });
      // 手动绑号路径只校验"号存在 + 份额容量",不查等级/配额 → 池子放最小账号即可。
      writeJson(path.join(dataDir, "anthropic-accounts.json"), { accounts: [{ id: 1, email: "a@x.com", planType: "max" }] });
      writeJson(path.join(dataDir, "codex-accounts.json"), { accounts: [{ id: 1, email: "c@x.com", planType: "pro" }] });
    });
    afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

    it("anthropic=1 份 / codex=2 份:落库 weights,且 boundShares 按产品计", () => {
      const svc = new AccessKeyService({ dataDir } as any);
      try {
        svc.createAccessKey({
          products: ["anthropic", "codex"],
          levels: { anthropic: "max", codex: "pro" },
          accountIds: { anthropic: 1, codex: 1 },
          weights: { anthropic: 1, codex: 2 },
          weight: 1,
        });
      } catch {
        // 返回值经 listAccessKeys 格式化需要更完整的 ctx;持久化(我们要验的)已先发生。
      }

      const card = JSON.parse(fs.readFileSync(keysFile, "utf8")).keys[0];
      expect(card.weights).toEqual({ anthropic: 1, codex: 2 });
      expect(card.bindings).toEqual({ anthropic: 1, codex: 1 });

      const svc2 = new AccessKeyService({ dataDir } as any);
      expect(svc2.boundSharesByAccount("anthropic").get(1)).toBe(1);
      expect(svc2.boundSharesByAccount("codex").get(1)).toBe(2);
    });

    it("codex 份额超容量(已用 7 + 需 2 > 8)→ 拒绝", () => {
      // 预置一张已占 codex 号 7 份的卡。
      writeJson(keysFile, { keys: [{ id: "pre", key: "p", status: "active", bindings: { codex: 1 }, weight: 7 }] });
      const svc = new AccessKeyService({ dataDir } as any);
      const res = svc.createAccessKey({
        products: ["codex"],
        levels: { codex: "pro" },
        accountIds: { codex: 1 },
        weights: { codex: 2 },
      });
      expect(res.ok).toBe(false);
      expect(String(res.error)).toContain("份额不足");
    });
  });
});
