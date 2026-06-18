import { describe, it, expect } from "vitest";

import {
  accountCapacity,
  oversellFactor,
  oversellCeiling,
  DEFAULT_OVERSELL_FACTOR,
} from "./unified-entitlement";

// 统一容量 C:全局一个数(替掉过去 seat 层 8 / fair-share N 10 两套口径)。
// 来源链:catalog.accountCapacity(后台可配覆盖)→ fallback(调用方传 ACCOUNT_SHARE_CAPACITY)。
describe("accountCapacity (统一容量 C)", () => {
  it("无 catalog override → 用 fallback", () => {
    expect(accountCapacity({}, 8)).toBe(8);
  });
  it("catalog.accountCapacity 覆盖 fallback", () => {
    expect(accountCapacity({ accountCapacity: 12 }, 8)).toBe(12);
  });
  it("非法 / <1 的 override → 回退 fallback", () => {
    expect(accountCapacity({ accountCapacity: 0 }, 8)).toBe(8);
    expect(accountCapacity({ accountCapacity: -3 }, 8)).toBe(8);
    expect(accountCapacity({ accountCapacity: 1.9 }, 8)).toBe(1); // 向下取整
  });
});

// 超卖系数:后台可配,默认 1.5;拼车封顶 = ceil(C × factor)。独享不走这条(永不超卖)。
describe("oversellFactor (后台可配超卖系数)", () => {
  it("无 override → 默认 1.5", () => {
    expect(oversellFactor({})).toBe(DEFAULT_OVERSELL_FACTOR);
  });
  it("catalog 覆盖", () => {
    expect(oversellFactor({ oversellFactor: 2 })).toBe(2);
  });
  it("不能 < 1(系数至少 1 = 不超卖,不能比基准还少卖)", () => {
    expect(oversellFactor({ oversellFactor: 0.5 })).toBe(1);
  });
});

describe("oversellCeiling = ceil(C × factor)", () => {
  it("C=8 factor=1.5 → 12", () => {
    expect(oversellCeiling({ accountCapacity: 8, oversellFactor: 1.5 }, 8)).toBe(12);
  });
  it("非整数向上取整(C=10 factor=1.25 → 12.5 → 13)", () => {
    expect(oversellCeiling({ accountCapacity: 10, oversellFactor: 1.25 }, 8)).toBe(13);
  });
});
