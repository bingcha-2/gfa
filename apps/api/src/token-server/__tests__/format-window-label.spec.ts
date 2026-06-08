import { describe, expect, it } from "vitest";

import { formatWindowLabel } from "../token-billing";

describe("formatWindowLabel", () => {
  it("renders whole hours as Nh", () => {
    expect(formatWindowLabel(5 * 60 * 60 * 1000)).toBe("5h");
    expect(formatWindowLabel(3 * 60 * 60 * 1000)).toBe("3h");
  });

  it("renders whole days as Nd", () => {
    expect(formatWindowLabel(24 * 60 * 60 * 1000)).toBe("1d");
    expect(formatWindowLabel(48 * 60 * 60 * 1000)).toBe("2d");
  });

  it("falls back to the 5h default for missing/zero input", () => {
    expect(formatWindowLabel(0)).toBe("5h");
    expect(formatWindowLabel(undefined as any)).toBe("5h");
  });

  it("keeps one decimal for fractional hours", () => {
    expect(formatWindowLabel(1.5 * 60 * 60 * 1000)).toBe("1.5h");
  });
});
