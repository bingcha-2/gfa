import { describe, expect, it } from "vitest";

import { toBindableAccounts } from "./bindable-accounts";

describe("toBindableAccounts", () => {
  it("tags each pool with its provider and lists codex first, carrying shares + level", () => {
    const result = toBindableAccounts(
      [{ id: 7, email: "c@x.com", usedShares: 2, shareCapacity: 4, planType: "Plus" }],
      [{ id: 1, email: "a@x.com", usedShares: 0, shareCapacity: 4 }],
    );
    expect(result).toEqual([
      { provider: "codex", id: 7, email: "c@x.com", usedShares: 2, shareCapacity: 4, planType: "Plus" },
      { provider: "antigravity", id: 1, email: "a@x.com", usedShares: 0, shareCapacity: 4, planType: "" },
    ]);
  });

  it("defaults missing usedShares to 0 and shareCapacity to 4", () => {
    const result = toBindableAccounts([{ id: 7, email: "c@x.com" } as any], []);
    expect(result[0].usedShares).toBe(0);
    expect(result[0].shareCapacity).toBe(4);
  });

  it("tolerates undefined pools", () => {
    expect(toBindableAccounts(undefined, undefined)).toEqual([]);
  });
});
