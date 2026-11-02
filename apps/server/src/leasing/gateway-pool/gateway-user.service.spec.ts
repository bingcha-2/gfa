import { describe, expect, it } from "vitest";

import { costUsd, hashKey } from "./gateway-user.service";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

describe("gateway costUsd", () => {
  it("charges nothing for zero tokens", () => {
    expect(costUsd("claude-sonnet-4-6", zero)).toBe(0);
  });

  it("scales linearly with tokens", () => {
    const one = costUsd("claude-sonnet-4-6", { ...zero, input: 1_000, output: 1_000 });
    const two = costUsd("claude-sonnet-4-6", { ...zero, input: 2_000, output: 2_000 });
    expect(one).toBeGreaterThan(0);
    expect(two).toBeCloseTo(one * 2, 9);
  });

  it("prices output higher than input and cache reads below input", () => {
    const m = "claude-sonnet-4-6";
    const input = costUsd(m, { ...zero, input: 1_000_000 });
    const output = costUsd(m, { ...zero, output: 1_000_000 });
    const cacheRead = costUsd(m, { ...zero, cacheRead: 1_000_000 });
    expect(output).toBeGreaterThan(input);
    expect(cacheRead).toBeLessThan(input);
  });

  it("prices opus above haiku for the same usage", () => {
    const u = { ...zero, input: 100_000, output: 50_000 };
    expect(costUsd("claude-opus-4-8", u)).toBeGreaterThan(costUsd("claude-haiku-4-5-20251001", u));
  });

  it("never returns a negative or NaN value for an unknown model", () => {
    const v = costUsd("claude-unknown-model", { ...zero, input: 1_000, output: 1_000 });
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThan(0);
  });
});

describe("hashKey", () => {
  it("is deterministic and does not contain the key", () => {
    expect(hashKey("gfa-abc")).toBe(hashKey("gfa-abc"));
    expect(hashKey("gfa-abc")).not.toContain("abc");
    expect(hashKey("gfa-abc")).not.toBe(hashKey("gfa-abd"));
  });
});
