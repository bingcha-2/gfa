import { describe, expect, it } from "vitest";
import { upstreamWindowTransition } from "./upstream-window";

const account = "test@example.test";
const now = 1_793_590_800_000;
function usage(resetAt: number, extra = {}) {
  return [{ boundAccount: account, pool: "private", share: { windows: { "7d": { resetAt, readingAt: now - 1000, freshness: "fresh", ...extra } } } }];
}
describe("upstream period evidence", () => {
  it("does not erase charges when the real upstream adjusts the boundary by 514ms", () => {
    expect(upstreamWindowTransition(usage(now + 3600000 - 514), account, now + 3600000, now)).toEqual({ reset: false, resetAt: null });
  });
  it("initializes a fresh boundary without clearing usage", () => {
    expect(upstreamWindowTransition(usage(now + 3600000), account, null, now)).toEqual({ reset: false, resetAt: now + 3600000 });
  });
  it("resets only after a fresh observation of a subsequent period", () => {
    expect(upstreamWindowTransition(usage(now + 604800000), account, now - 2000, now).reset).toBe(true);
  });
  it.each(["stale", "unknown", "expired", "inactive"])("rejects %s readings", freshness => {
    expect(upstreamWindowTransition(usage(now + 604800000, { freshness }), account, now - 2000, now).reset).toBe(false);
  });
  it("rejects missing, ambiguous, uncertain and old observations", () => {
    const one = usage(now + 604800000);
    for (const rows of [[], [...one, ...one], usage(now + 604800000, { uncertain: true }), usage(now + 604800000, { readingAt: now - 3000 })]) {
      expect(upstreamWindowTransition(rows, account, now - 2000, now).reset).toBe(false);
    }
  });
});
