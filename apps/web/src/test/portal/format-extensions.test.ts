import { describe, it, expect } from "vitest";
import { formatPriceCents, formatCountdown } from "@/lib/format-extensions";

describe("formatPriceCents", () => {
  it("formats whole yuan without decimals", () => {
    expect(formatPriceCents(9900)).toBe("¥99");
    expect(formatPriceCents(100)).toBe("¥1");
    expect(formatPriceCents(0)).toBe("¥0");
  });

  it("formats fractional yuan with two decimals", () => {
    expect(formatPriceCents(9990)).toBe("¥99.90");
    expect(formatPriceCents(1)).toBe("¥0.01");
    expect(formatPriceCents(12345)).toBe("¥123.45");
  });
});

describe("formatCountdown", () => {
  it("formats milliseconds as mm:ss", () => {
    expect(formatCountdown(0)).toBe("00:00");
    expect(formatCountdown(1000)).toBe("00:01");
    expect(formatCountdown(61_000)).toBe("01:01");
    expect(formatCountdown(15 * 60_000)).toBe("15:00");
  });

  it("clamps negative values to 00:00", () => {
    expect(formatCountdown(-5000)).toBe("00:00");
  });

  it("floors partial seconds", () => {
    expect(formatCountdown(2999)).toBe("00:02");
  });
});
