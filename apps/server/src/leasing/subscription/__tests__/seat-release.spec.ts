import { describe, expect, it } from "vitest";
import { occupiedSharesByAccount } from "../seat";

describe("seat occupancy excludes non-active subscriptions", () => {
  it("counts a bind subscription's weight against its bound account", () => {
    const activeConfigs = [
      { id: "a", line: "bind", bindings: { anthropic: 15 }, weight: 4 },
    ];
    const occ = occupiedSharesByAccount(activeConfigs, "anthropic");
    expect(occ.get(15)).toBe(4);
  });

  it("a cancelled subscription (absent from the active set) frees its seat", () => {
    // Callers pass only ACTIVE subscriptions; cancelled ones are simply omitted.
    // An empty active set means no seat is occupied.
    const occ = occupiedSharesByAccount([], "anthropic");
    expect(occ.get(15)).toBeUndefined();
  });

  it("excludeId param skips a specific subscription (used during resync)", () => {
    const configs = [
      { id: "sub-1", line: "bind", bindings: { anthropic: 15 }, weight: 2 },
      { id: "sub-2", line: "bind", bindings: { anthropic: 15 }, weight: 3 },
    ];
    // Without exclusion: both contribute → 5
    expect(occupiedSharesByAccount(configs, "anthropic").get(15)).toBe(5);
    // Excluding sub-1: only sub-2 contributes → 3
    expect(occupiedSharesByAccount(configs, "anthropic", "sub-1").get(15)).toBe(3);
  });

  it("pool subscriptions (line !== 'bind') never occupy a seat even with bindings", () => {
    const configs = [
      { id: "p1", line: "pool", bindings: { anthropic: 15 }, weight: 8 },
    ];
    const occ = occupiedSharesByAccount(configs, "anthropic");
    expect(occ.get(15)).toBeUndefined();
  });

  it("weight defaults to 1 when omitted or invalid", () => {
    const configs = [
      { id: "b1", line: "bind", bindings: { anthropic: 7 } },
    ];
    const occ = occupiedSharesByAccount(configs, "anthropic");
    expect(occ.get(7)).toBe(1);
  });
});
