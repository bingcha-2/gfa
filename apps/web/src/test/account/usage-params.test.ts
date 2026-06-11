/**
 * Tests that getUsage builds the exact proxy URL with page/pageSize/days
 * query params (contract B).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { getUsage } from "@/lib/account/user-api";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("getUsage param building", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends page, pageSize and days as query params to the proxy", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ records: [], total: 0, page: 2, pageSize: 20 })
      );
    vi.stubGlobal("fetch", mockFetch);

    await getUsage(2, 20, 30);

    const url = String(mockFetch.mock.calls[0][0]);
    expect(url.startsWith("/api/web/usage?")).toBe(true);

    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("page")).toBe("2");
    expect(params.get("pageSize")).toBe("20");
    expect(params.get("days")).toBe("30");
  });

  it("supports each allowed days window", async () => {
    for (const days of [1, 7, 30] as const) {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ records: [], total: 0, page: 1, pageSize: 10 })
        );
      vi.stubGlobal("fetch", mockFetch);

      await getUsage(1, 10, days);

      const params = new URLSearchParams(
        String(mockFetch.mock.calls[0][0]).split("?")[1]
      );
      expect(params.get("days")).toBe(String(days));
    }
  });
});
