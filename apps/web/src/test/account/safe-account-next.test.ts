import { describe, expect, it } from "vitest";

import { safeAccountNext } from "@/lib/account/safe-account-next";

describe("safeAccountNext", () => {
  it("keeps internal account paths", () => {
    expect(safeAccountNext("/account/support")).toBe("/account/support");
    expect(safeAccountNext("/account?tab=billing")).toBe("/account?tab=billing");
  });

  it("rejects unsafe or non-account targets", () => {
    expect(safeAccountNext(null)).toBe("/account");
    expect(safeAccountNext("https://evil.example/account/support")).toBe("/account");
    expect(safeAccountNext("//evil.example/account/support")).toBe("/account");
    expect(safeAccountNext("/console/support-insights")).toBe("/account");
    expect(safeAccountNext("/accounting")).toBe("/account");
  });
});
