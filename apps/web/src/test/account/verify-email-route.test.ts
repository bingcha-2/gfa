/**
 * Tests for the verify-email route handler:
 *   src/app/api/web-session/verify-email/route.ts
 *
 * Focus: a malformed JSON body must return 400 BAD_REQUEST (not a 500 that the
 * page would surface as "invalid token").
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return actual;
});

import { POST } from "@/app/api/web-session/verify-email/route";

function rawRequest(body: string) {
  return new Request("http://localhost/api/web-session/verify-email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  }) as unknown as import("next/server").NextRequest;
}

describe("api/web-session/verify-email", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 400 BAD_REQUEST for a malformed JSON body and never calls fetch", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const resp = await POST(rawRequest("{not json"));

    expect(resp.status).toBe(400);
    expect(await resp.json()).toEqual({ error: "BAD_REQUEST" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 400 BAD_REQUEST for an empty body and never calls fetch", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const resp = await POST(rawRequest(""));

    expect(resp.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("forwards a valid token body to the backend and returns {ok:true}", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", mockFetch);

    const resp = await POST(rawRequest(JSON.stringify({ token: "abc" })));

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/web/auth/verify-email");
    expect(JSON.parse(init.body as string)).toEqual({ token: "abc" });
  });

  it("passes a backend INVALID_TOKEN 400 through unchanged", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "INVALID_TOKEN" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", mockFetch);

    const resp = await POST(rawRequest(JSON.stringify({ token: "bad" })));

    expect(resp.status).toBe(400);
    expect(await resp.json()).toEqual({ error: "INVALID_TOKEN" });
  });
});
