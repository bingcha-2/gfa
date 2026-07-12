import { describe, expect, it } from "vitest";
import { fairShareDenialMessage } from "./fair-share-message";

describe("fair-share denial messages", () => {
  it("turns stable reason codes into user-facing Chinese messages", () => {
    expect(fairShareDenialMessage("primary_exhausted")).toBe("5 小时额度已用完，请等待额度恢复");
    expect(fairShareDenialMessage("weekly_exhausted")).toBe("周额度已用完，请等待额度恢复");
  });

  it("keeps a safe fallback for unknown or missing reasons", () => {
    expect(fairShareDenialMessage("future_reason")).toBe("公平限额已用完，请等待额度恢复");
    expect(fairShareDenialMessage()).toBe("公平限额已用完，请等待额度恢复");
  });
});
