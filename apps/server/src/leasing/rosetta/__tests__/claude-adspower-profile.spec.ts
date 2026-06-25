import { describe, expect, it } from "vitest";

import { resolveAnthropicAdspowerProfileId } from "../claude-account.service";

describe("resolveAnthropicAdspowerProfileId", () => {
  it("prefers the requested profile over the stored profile", () => {
    expect(resolveAnthropicAdspowerProfileId("requested-profile", "stored-profile")).toBe("requested-profile");
  });

  it("uses the stored profile when the request omits one", () => {
    expect(resolveAnthropicAdspowerProfileId("", "stored-profile")).toBe("stored-profile");
  });

  it("returns empty when neither source provides a profile, so onboarding provisions a per-account sticky profile", () => {
    expect(resolveAnthropicAdspowerProfileId(undefined, undefined)).toBe("");
  });
});
