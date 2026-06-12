import { describe, expect, it } from "vitest";

import { countBoundSeats, occupiedSharesByAccount } from "./seat";

describe("countBoundSeats — 座位占用从订阅数(不依赖文件)", () => {
  it("数 line=bind 且绑了该号该产品的订阅数", () => {
    const configs = [
      { line: "bind", bindings: { anthropic: 7 } },
      { line: "bind", bindings: { anthropic: 7 } },
      { line: "bind", bindings: { anthropic: 9 } }, // 别的号
      { line: "bind", bindings: { codex: 7 } }, // 别的产品
      { line: "pool" }, // 号池不占座位
    ];
    expect(countBoundSeats(configs, 7, "anthropic")).toBe(2);
  });

  it("号池订阅(line=pool)永不占座位 —— 只看 line,不靠 bindings 推断", () => {
    const configs = [
      { line: "pool", bindings: { anthropic: 7 } }, // 即便有 bindings,pool 也不算
    ];
    expect(countBoundSeats(configs, 7, "anthropic")).toBe(0);
  });
});

describe("occupiedSharesByAccount — 份额从 DB 订阅 config 的 weight 求和(去影子座位真相源)", () => {
  it("按号汇总 line=bind 订阅的 weight;号池与别的产品/号不计", () => {
    const configs = [
      { id: "a", line: "bind", bindings: { anthropic: 7 }, weight: 3 },
      { id: "b", line: "bind", bindings: { anthropic: 7 }, weight: 1 },
      { id: "c", line: "bind", bindings: { anthropic: 9 }, weight: 8 }, // 别的号
      { id: "d", line: "bind", bindings: { codex: 7 }, weight: 4 }, // 别的产品
      { id: "e", line: "pool", bindings: { anthropic: 7 }, weight: 8 }, // 号池不计
    ];
    const shares = occupiedSharesByAccount(configs, "anthropic");
    expect(shares.get(7)).toBe(4); // 3 + 1
    expect(shares.get(9)).toBe(8);
  });

  it("excludeId 排除自身(resync 不把自己算进容量)", () => {
    const configs = [
      { id: "self", line: "bind", bindings: { anthropic: 7 }, weight: 4 },
      { id: "other", line: "bind", bindings: { anthropic: 7 }, weight: 2 },
    ];
    expect(occupiedSharesByAccount(configs, "anthropic", "self").get(7)).toBe(2);
  });

  it("weight 缺省按 1 计", () => {
    const configs = [{ id: "a", line: "bind", bindings: { anthropic: 7 } }];
    expect(occupiedSharesByAccount(configs, "anthropic").get(7)).toBe(1);
  });
});
