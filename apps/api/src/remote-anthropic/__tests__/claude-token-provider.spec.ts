import { describe, expect, it } from "vitest";

import { refreshClaudeAccessToken } from "../auth/claude-token-provider";

describe("refreshClaudeAccessToken", () => {
  it("returns the cached access token when it is still well within its lifetime", async () => {
    const account: any = {
      id: 1,
      email: "a@b.c",
      refreshToken: "rt",
      accessToken: "cached-access-token",
      accessTokenExpiresAt: Date.now() + 60 * 60 * 1000, // 1h out, beyond the refresh buffer
    };
    // No fetch should be needed; if it tried to hit the network the test would
    // not resolve to the cached value.
    await expect(refreshClaudeAccessToken(account)).resolves.toBe("cached-access-token");
  });

  it("throws when there is no refresh token and no usable cached access token", async () => {
    const account: any = { id: 1, email: "a@b.c", refreshToken: "" };
    await expect(refreshClaudeAccessToken(account)).rejects.toThrow(/refresh_token/);
  });
});
