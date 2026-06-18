import { describe, expect, it } from "vitest";

import { countBoundSeats, exclusiveLockedByAccount, isExclusive, occupiedSharesByAccount } from "./seat";

// 独享锁定号集合:某产品下被「line=bind 且 exclusive」订阅独占的上游号 id。
// 分配器据此对所有新绑定隐藏这些号(独享号别人不得绑入)。
describe("exclusiveLockedByAccount — 独享锁定的号集合", () => {
  it("只收 line=bind 且 exclusive 的订阅所绑的本产品号", () => {
    const configs = [
      { id: "a", line: "bind", exclusive: true, bindings: { anthropic: 7 } },
      { id: "b", line: "bind", bindings: { anthropic: 8 } }, // 非独享,不锁
      { id: "c", line: "bind", exclusive: true, bindings: { codex: 7 } }, // 别的产品,不算
      { id: "d", line: "pool", exclusive: true, bindings: { anthropic: 9 } }, // 号池不占座,不锁
    ];
    const locked = exclusiveLockedByAccount(configs, "anthropic");
    expect([...locked].sort()).toEqual([7]);
  });

  it("excludeId 排除自身(resync 不把自己锁住)", () => {
    const configs = [{ id: "self", line: "bind", exclusive: true, bindings: { anthropic: 7 } }];
    expect(exclusiveLockedByAccount(configs, "anthropic", "self").has(7)).toBe(false);
  });
});

// 独享判定:显式 exclusive 字段(不再靠 weight==capacity 隐式推断,避免与容量数脱钩)。
describe("isExclusive — 显式独享标记", () => {
  it("exclusive:true → 独享", () => {
    expect(isExclusive({ exclusive: true })).toBe(true);
  });
  it("缺省 → 非独享(拼车)", () => {
    expect(isExclusive({})).toBe(false);
  });
  it("exclusive:false → 非独享", () => {
    expect(isExclusive({ exclusive: false })).toBe(false);
  });
});

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
