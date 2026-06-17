import { describe, expect, it } from "vitest";
import { isOversold, filterOversold } from "@/lib/console/pool-occupancy";

describe("pool-occupancy", () => {
  it("isOversold: 占用 > 容量 才算超卖", () => {
    expect(isOversold(9, 8)).toBe(true);
    expect(isOversold(8, 8)).toBe(false);
    expect(isOversold(3, 8)).toBe(false);
  });
  it("filterOversold: 只留超卖号", () => {
    const accts = [
      { id: 1, usedShares: 9, shareCapacity: 8 },
      { id: 2, usedShares: 4, shareCapacity: 8 },
    ];
    expect(filterOversold(accts).map((a) => a.id)).toEqual([1]);
  });
});
