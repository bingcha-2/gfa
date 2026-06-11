import { describe, expect, it } from "vitest";

import { AntigravityProvider } from "../antigravity.provider";

describe("AntigravityProvider.egressPolicy", () => {
  it("is optional — antigravity uses a bound proxy when present, else local direct (fail-open)", () => {
    expect(new AntigravityProvider().egressPolicy).toBe("optional");
  });
});
