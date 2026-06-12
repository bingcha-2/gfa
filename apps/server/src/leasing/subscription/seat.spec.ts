import { describe, expect, it } from "vitest";

import { countBoundSeats } from "./seat";

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
