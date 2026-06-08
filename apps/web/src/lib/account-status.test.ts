import { describe, expect, it } from "vitest";

import { accountHealthSummary, accountStatusLabel } from "./account-status";

describe("accountHealthSummary", () => {
  it("counts error AND cooling/exhausted as not-ok, not healthy", () => {
    const { okCount, reasons } = accountHealthSummary([
      { quotaStatus: "ok" },
      { quotaStatus: "error", quotaStatusReason: "invalid_grant" },
      { quotaStatus: "exhausted", quotaStatusReason: "quota" },
      { quotaStatus: "cooling", quotaStatusReason: "capacity" },
      {}, // no status → healthy
    ]);
    expect(okCount).toBe(2);
    expect(reasons.invalid_grant).toBe(1);
    expect(reasons.quota).toBe(1);
    expect(reasons.capacity).toBe(1);
  });
});

describe("accountStatusLabel", () => {
  it("marks invalid_grant as a red dead badge", () => {
    expect(accountStatusLabel("error", "invalid_grant")).toEqual({
      tone: "red",
      label: "已失效·鉴权失效",
    });
  });

  it("marks consecutive_errors as a red dead badge", () => {
    const badge = accountStatusLabel("error", "consecutive_errors");
    expect(badge.tone).toBe("red");
    expect(badge.label).toContain("已失效");
  });

  it("marks exhausted/cooling as yellow recovering", () => {
    expect(accountStatusLabel("exhausted", "quota").tone).toBe("yellow");
    expect(accountStatusLabel("cooling", "").tone).toBe("yellow");
  });

  it("marks ok/empty as green", () => {
    expect(accountStatusLabel("ok", "").tone).toBe("green");
    expect(accountStatusLabel("", "").tone).toBe("green");
  });
});
