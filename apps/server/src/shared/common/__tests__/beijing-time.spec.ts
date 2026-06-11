import { describe, it, expect } from "vitest";

import { beijingDayKey, beijingDayStart, beijingDayKeysSince } from "../beijing-time";

describe("beijing-time (UTC+8)", () => {
  it("maps an instant to its Beijing calendar date", () => {
    // 2026-05-31T23:30:00Z → Beijing 2026-06-01 07:30 → key 2026-06-01
    expect(beijingDayKey(new Date("2026-05-31T23:30:00Z"))).toBe("2026-06-01");
    // 2026-05-31T15:59:00Z → Beijing 2026-05-31 23:59 → still 2026-05-31
    expect(beijingDayKey(new Date("2026-05-31T15:59:00Z"))).toBe("2026-05-31");
    // 2026-05-31T16:00:00Z → Beijing 2026-06-01 00:00 → rolls to next day
    expect(beijingDayKey(new Date("2026-05-31T16:00:00Z"))).toBe("2026-06-01");
  });

  it("beijingDayStart(0) is the UTC instant of Beijing midnight today", () => {
    const now = new Date("2026-06-01T03:00:00Z"); // Beijing 11:00
    const start = beijingDayStart(0, now);
    // Beijing 2026-06-01 00:00 == 2026-05-31T16:00:00Z
    expect(start.toISOString()).toBe("2026-05-31T16:00:00.000Z");
  });

  it("beijingDayStart(n) goes back n Beijing days", () => {
    const now = new Date("2026-06-01T03:00:00Z");
    expect(beijingDayStart(3, now).toISOString()).toBe("2026-05-28T16:00:00.000Z");
  });

  it("beijingDayKeysSince fills a continuous inclusive range", () => {
    const now = new Date("2026-06-01T03:00:00Z"); // Beijing 2026-06-01
    expect(beijingDayKeysSince(2, now)).toEqual(["2026-05-30", "2026-05-31", "2026-06-01"]);
    expect(beijingDayKeysSince(0, now)).toEqual(["2026-06-01"]);
  });
});
