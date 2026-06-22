import { describe, expect, it } from "vitest";

import { cardWeight, cardWeightFor } from "../lib/access-key-util";
import { ACCOUNT_SHARE_CAPACITY } from "../../token-server/token-billing";

// 一张卡按【产品】分别设份额:anthropic 1 份、codex 2 份。老卡只有 weight → 各产品回退它。
// (卡密后台发卡已随激活码改造删除;此处只保留 cardWeightFor 份额解析的单元测试 ——
//  订阅/激活码座位会计仍依赖它,见 seat.ts / access-key.service。)
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
});
