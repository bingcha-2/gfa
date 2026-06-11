import { afterEach, describe, expect, it, vi } from "vitest";

// Anthropic egress is fail-closed (proxyRequiredFetch refuses without a proxy),
// and a real proxy URL would route through undici — neither is stubbable via the
// global fetch. So mock the egress module: every refresh/probe network call lands
// on `egressFetch`, which we drive per-test. (The fail-closed behavior itself is
// covered separately in egress.spec.ts.)
const { egressFetch } = vi.hoisted(() => ({ egressFetch: vi.fn() }));
vi.mock("../../lease-core/egress", () => ({
  proxyRequiredFetch: (_proxyUrl: unknown, url: string, init: any) => egressFetch(url, init),
  proxyAwareFetch: (_proxyUrl: unknown, url: string, init: any) => egressFetch(url, init),
}));

import { isInvalidGrant, refreshClaudeAccessToken } from "../auth/claude-token-provider";

function tokenResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("refreshClaudeAccessToken", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns the cached access token when it is still well within its lifetime", async () => {
    const account: any = {
      id: 1,
      email: "a@b.c",
      refreshToken: "rt",
      accessToken: "cached-access-token",
      accessTokenExpiresAt: Date.now() + 60 * 60 * 1000, // 1h out, beyond the refresh buffer
    };
    // No network needed; if it tried to refresh the test would not resolve to the cache.
    await expect(refreshClaudeAccessToken(account)).resolves.toBe("cached-access-token");
    expect(egressFetch).not.toHaveBeenCalled();
  });

  it("throws when there is no refresh token and no usable cached access token", async () => {
    const account: any = { id: 1, email: "a@b.c", refreshToken: "" };
    await expect(refreshClaudeAccessToken(account)).rejects.toThrow(/refresh_token/);
  });

  it("rotates the refresh_token and stores the new access token on the account", async () => {
    egressFetch.mockResolvedValue(tokenResponse({ access_token: "new-at", refresh_token: "rotated-rt", expires_in: 3600 }));
    const account: any = { id: 2, email: "rot@b.c", refreshToken: "old-rt" };
    const token = await refreshClaudeAccessToken(account);
    expect(token).toBe("new-at");
    expect(account.refreshToken).toBe("rotated-rt");
    expect(account.accessToken).toBe("new-at");
    expect(account.accessTokenExpiresAt).toBeGreaterThan(Date.now());
  });

  it("single-flights concurrent refreshes for the same account into ONE grant", async () => {
    // The whole point of the fix: a multi-user pool leases one account from many
    // cards at once; without dedup each fires a grant and the losers replay a
    // now-consumed single-use refresh_token, tripping family revocation.
    egressFetch.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return tokenResponse({ access_token: "shared-at", refresh_token: "shared-rt", expires_in: 3600 });
    });
    // Distinct account objects, same identity (email) — mirrors lease account vs
    // quota probe arriving concurrently.
    const a1: any = { id: 3, email: "same@b.c", refreshToken: "rt" };
    const a2: any = { id: 3, email: "same@b.c", refreshToken: "rt" };
    const [t1, t2] = await Promise.all([
      refreshClaudeAccessToken(a1),
      refreshClaudeAccessToken(a2),
    ]);
    expect(t1).toBe("shared-at");
    expect(t2).toBe("shared-at");
    expect(egressFetch).toHaveBeenCalledTimes(1); // ONE grant, not two
    expect(a1.refreshToken).toBe("shared-rt");
    expect(a2.refreshToken).toBe("shared-rt");
  });

  it("adopts a freshly-rotated disk token instead of firing a duplicate grant", async () => {
    egressFetch.mockResolvedValue(tokenResponse({ access_token: "should-not-be-used", expires_in: 3600 }));
    const account: any = { id: 4, email: "reload@b.c", refreshToken: "stale-rt" }; // no cached AT
    const token = await refreshClaudeAccessToken(account, {
      reload: () => ({
        id: 4,
        email: "reload@b.c",
        refreshToken: "disk-rt",
        accessToken: "disk-at",
        accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
      }),
    });
    expect(token).toBe("disk-at"); // adopted from disk
    expect(egressFetch).not.toHaveBeenCalled(); // no grant burned
    expect(account.refreshToken).toBe("disk-rt");
  });

  it("recovers from invalid_grant by adopting a token another writer persisted", async () => {
    egressFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "Refresh token not found or invalid" }), {
        status: 400,
      }),
    );
    const account: any = { id: 5, email: "dead@b.c", refreshToken: "consumed-rt" };
    let reloads = 0;
    const token = await refreshClaudeAccessToken(account, {
      reload: () => {
        reloads++;
        // First call (pre-grant) still shows the stale token → grant proceeds and
        // 400s. Second call (post-invalid_grant) shows what another writer rotated.
        if (reloads === 1) return { id: 5, email: "dead@b.c", refreshToken: "consumed-rt" };
        return {
          id: 5,
          email: "dead@b.c",
          refreshToken: "fresh-rt",
          accessToken: "fresh-at",
          accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
        };
      },
    });
    expect(token).toBe("fresh-at");
    expect(egressFetch).toHaveBeenCalledTimes(1);
  });

  it("surfaces a genuinely dead account (invalid_grant, no recovery) as an error", async () => {
    egressFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "Refresh token not found or invalid" }), {
        status: 400,
      }),
    );
    const account: any = { id: 6, email: "gone@b.c", refreshToken: "consumed-rt" };
    // reload keeps returning the same consumed token → no recovery possible.
    await expect(
      refreshClaudeAccessToken(account, { reload: () => ({ id: 6, email: "gone@b.c", refreshToken: "consumed-rt" }) }),
    ).rejects.toThrow(/invalid_grant/i);
  });
});

describe("isInvalidGrant", () => {
  it("classifies invalid_grant / 'refresh token not found' as a dead-account signal", () => {
    expect(isInvalidGrant(new Error("400 {\"error\": \"invalid_grant\"}"))).toBe(true);
    expect(isInvalidGrant(new Error("Refresh token not found or invalid"))).toBe(true);
  });
  it("does not flag transient/network errors", () => {
    expect(isInvalidGrant(new Error("getaddrinfo ENOTFOUND"))).toBe(false);
    expect(isInvalidGrant(new Error("503 upstream busy"))).toBe(false);
  });
});
