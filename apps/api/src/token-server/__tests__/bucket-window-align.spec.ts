import { describe, expect, it } from "vitest";

import { bucketWindowStart } from "../token-billing";

const B = "anthropic-claude";

describe("bucketWindowStart — per-bucket window with optional account alignment", () => {
  it("falls back to fixed-period tumbling when no aligned reset (pool-style)", () => {
    const rec: any = {};
    // first use anchors the window
    expect(bucketWindowStart(rec, B, 1000, 0, 100)).toBe(1000);
    // within window → unchanged
    expect(bucketWindowStart(rec, B, 1050, 0, 100)).toBe(1000);
    // window length elapsed → rolls to now
    expect(bucketWindowStart(rec, B, 1100, 0, 100)).toBe(1100);
  });

  it("aligns the window boundary to the account's upstream reset time", () => {
    const rec: any = {};
    // first use before the reset → anchors at now, window runs until resetAt
    expect(bucketWindowStart(rec, B, 1000, 2000, 100)).toBe(1000);
    expect(bucketWindowStart(rec, B, 1500, 2000, 100)).toBe(1000); // still before reset, no tumbling
    // now crosses the account reset → window rolls to the reset boundary
    expect(bucketWindowStart(rec, B, 2000, 2000, 100)).toBe(2000);
  });

  it("does NOT re-roll every call while the account reset is still in the past (pre-snapshot)", () => {
    const rec: any = {};
    bucketWindowStart(rec, B, 1000, 2000, 100); // anchor at 1000
    expect(bucketWindowStart(rec, B, 2000, 2000, 100)).toBe(2000); // roll once
    // resetAt still 2000 (snapshot not refreshed yet) and now past it → must stay put
    expect(bucketWindowStart(rec, B, 2500, 2000, 100)).toBe(2000);
    expect(bucketWindowStart(rec, B, 3000, 2000, 100)).toBe(2000);
  });

  it("rolls again only when the account publishes a NEW (later) reset time", () => {
    const rec: any = {};
    bucketWindowStart(rec, B, 1000, 2000, 100);
    bucketWindowStart(rec, B, 2000, 2000, 100); // start = 2000
    // account refreshed: next reset is 4000; not there yet
    expect(bucketWindowStart(rec, B, 2600, 4000, 100)).toBe(2000);
    // now crosses the new reset → roll to 4000
    expect(bucketWindowStart(rec, B, 4000, 4000, 100)).toBe(4000);
  });

  it("tracks each bucket independently", () => {
    const rec: any = {};
    expect(bucketWindowStart(rec, "anthropic-claude", 1000, 0, 100)).toBe(1000);
    // codex is a different bucket → its own first-use anchor, doesn't touch claude
    expect(bucketWindowStart(rec, "codex-gpt", 1050, 0, 100)).toBe(1050);
    // claude re-checked within its 100ms window → still 1000, unaffected by codex
    expect(bucketWindowStart(rec, "anthropic-claude", 1080, 0, 100)).toBe(1000);
  });
});
