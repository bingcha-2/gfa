import { describe, expect, it } from "vitest";

import { msUntilNextBeijingHour } from "../beijing-daily-schedule";

const HOUR_MS = 60 * 60 * 1000;

describe("msUntilNextBeijingHour", () => {
  it("calculates 03:00 from an absolute UTC timestamp", () => {
    const now = Date.parse("2026-07-14T17:00:00.000Z"); // Beijing 01:00
    expect(msUntilNextBeijingHour(now, 3)).toBe(2 * HOUR_MS);
  });

  it("moves an exact scheduled time to the next Beijing day", () => {
    const now = Date.parse("2026-07-14T19:00:00.000Z"); // Beijing 03:00
    expect(msUntilNextBeijingHour(now, 3)).toBe(24 * HOUR_MS);
  });

  it("crosses the UTC date boundary using Beijing time", () => {
    const now = Date.parse("2026-07-15T15:30:00.000Z"); // Beijing 23:30
    expect(msUntilNextBeijingHour(now, 4)).toBe(4.5 * HOUR_MS);
  });
});
