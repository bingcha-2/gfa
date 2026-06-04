import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchClaudeQuotaUpstream } from "../auth/claude-usage";

function mockFetchOnce(status: number, headers: Record<string, string>, body = "{}") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status, headers })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchClaudeQuotaUpstream", () => {
  it("parses 5h + weekly remaining% from limit/remaining headers and resets to ISO", async () => {
    mockFetchOnce(200, {
      "anthropic-ratelimit-unified-5h-limit": "100",
      "anthropic-ratelimit-unified-5h-remaining": "73",
      "anthropic-ratelimit-unified-5h-reset": "1893456000", // unix seconds
      "anthropic-ratelimit-unified-7d-limit": "1000",
      "anthropic-ratelimit-unified-7d-remaining": "410",
    });
    const snap = await fetchClaudeQuotaUpstream("token");
    expect(snap.httpStatus).toBe(200);
    expect(snap.claudeQuota).toMatchObject({ hourlyPercent: 73, weeklyPercent: 41 });
    expect(snap.claudeQuota?.hourlyResetTime).toBe(new Date(1893456000 * 1000).toISOString());
  });

  it("honors a direct remaining-percent header when present", async () => {
    mockFetchOnce(200, {
      "anthropic-ratelimit-unified-5h-remaining-percent": "12.5",
      "anthropic-ratelimit-unified-week-remaining-percent": "80",
    });
    const snap = await fetchClaudeQuotaUpstream("token");
    expect(snap.claudeQuota).toMatchObject({ hourlyPercent: 12.5, weeklyPercent: 80 });
  });

  it("captures every anthropic-ratelimit-* header but returns no quota when windows are absent", async () => {
    mockFetchOnce(200, {
      "anthropic-ratelimit-requests-limit": "5",
      "anthropic-ratelimit-requests-remaining": "4",
      "content-type": "application/json",
    });
    const snap = await fetchClaudeQuotaUpstream("token");
    expect(snap.claudeQuota).toBeUndefined();
    expect(snap.rawHeaders).toMatchObject({
      "anthropic-ratelimit-requests-limit": "5",
      "anthropic-ratelimit-requests-remaining": "4",
    });
    expect(snap.rawHeaders["content-type"]).toBeUndefined();
  });

  it("surfaces an error (and any captured headers) on a non-ok response", async () => {
    mockFetchOnce(401, { "anthropic-ratelimit-unified-status": "rejected" }, "unauthorized");
    const snap = await fetchClaudeQuotaUpstream("token");
    expect(snap.httpStatus).toBe(401);
    expect(snap.error).toContain("401");
    expect(snap.rawHeaders["anthropic-ratelimit-unified-status"]).toBe("rejected");
  });

  it("returns an error without calling fetch when no token is given", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const snap = await fetchClaudeQuotaUpstream("");
    expect(snap.error).toMatch(/access token/);
    expect(spy).not.toHaveBeenCalled();
  });
});
