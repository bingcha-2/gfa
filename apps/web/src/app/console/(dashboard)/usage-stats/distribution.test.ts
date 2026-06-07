import { describe, expect, it } from "vitest";
import { BANDS, visibleBars, type Distribution } from "./distribution";

const d: Distribution = { exhausted: 3, warn: 7, low: 11, healthy: 24, noData: 241 };

describe("visibleBars", () => {
  it("默认隐藏 noData,返回其余档", () => {
    const bars = visibleBars(d, new Set(["noData"]));
    expect(bars.map((b) => b.key)).toEqual(["exhausted", "warn", "low", "healthy"]);
    expect(bars.find((b) => b.key === "healthy")!.max).toBe(24); // 隐藏 noData 后最大=24
  });
  it("全显时 max=最大档(noData 241)", () => {
    const bars = visibleBars(d, new Set());
    expect(Math.max(...bars.map((b) => b.max))).toBe(241);
  });
});
