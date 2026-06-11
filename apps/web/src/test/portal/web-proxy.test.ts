/**
 * Tests for the generic authenticated portal proxy:
 *   src/app/api/web/[...path]/route.ts
 *
 * We import the handler functions directly after mocking next/headers and global fetch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock next/headers ─────────────────────────────────────────────────────────
let mockCookieValue: string | undefined = undefined;

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: vi.fn((name: string) =>
      name === "gfa.user.token" && mockCookieValue
        ? { value: mockCookieValue }
        : undefined
    ),
  })),
}));

// ── Mock next/server (minimal NextRequest/NextResponse) ───────────────────────
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return actual;
});

// We import AFTER mocks are set up
// eslint-disable-next-line import/first
import { GET, POST, PATCH, DELETE } from "@/app/api/web/[...path]/route";

function makeRequest(
  method: string,
  path: string[],
  body?: unknown,
  searchParams?: Record<string, string>
) {
  const url = new URL(`http://localhost/api/web/${path.join("/")}`);
  if (searchParams) {
    for (const [k, v] of Object.entries(searchParams)) {
      url.searchParams.set(k, v);
    }
  }
  const req = new Request(url.toString(), {
    method,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  // Attach nextUrl stub for any Next.js internals that need it
  Object.defineProperty(req, "nextUrl", {
    value: url,
    writable: false,
  });
  return req as unknown as import("next/server").NextRequest;
}

describe("api/web/[...path] proxy", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockCookieValue = undefined;
  });

  it("returns 401 when no user cookie is present", async () => {
    mockCookieValue = undefined;

    const handler = GET;
    const resp = await handler(makeRequest("GET", ["me"]), {
      params: Promise.resolve({ path: ["me"] }),
    });
    expect(resp.status).toBe(401);
    const body = await resp.json();
    expect(body).toEqual({ error: "UNAUTHORIZED" });
  });

  it("forwards GET with Bearer and returns backend status", async () => {
    mockCookieValue = "test-token-abc";

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "1", email: "a@b.com" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", mockFetch);

    const resp = await GET(makeRequest("GET", ["me"]), {
      params: Promise.resolve({ path: ["me"] }),
    });

    expect(resp.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();

    const [calledUrl, calledInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toContain("/web/me");
    expect((calledInit.headers as Headers).get("authorization")).toBe(
      "Bearer test-token-abc"
    );
    expect(calledInit.method).toBe("GET");
  });

  it("forwards POST with body and Bearer", async () => {
    mockCookieValue = "user-token-xyz";

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", mockFetch);

    const resp = await POST(
      makeRequest("POST", ["auth", "change-password"], {
        currentPassword: "old",
        newPassword: "new",
      }),
      { params: Promise.resolve({ path: ["auth", "change-password"] }) }
    );

    expect(resp.status).toBe(200);
    const [calledUrl, calledInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toContain("/web/auth/change-password");
    expect((calledInit.headers as Headers).get("authorization")).toBe(
      "Bearer user-token-xyz"
    );
    expect(calledInit.method).toBe("POST");
  });

  it("maps backend error status through unchanged", async () => {
    mockCookieValue = "valid-token";

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "Not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", mockFetch);

    const resp = await GET(makeRequest("GET", ["nonexistent"]), {
      params: Promise.resolve({ path: ["nonexistent"] }),
    });

    expect(resp.status).toBe(404);
  });

  it("supports PATCH and DELETE methods", async () => {
    mockCookieValue = "token";

    for (const [handler, method] of [
      [PATCH, "PATCH"],
      [DELETE, "DELETE"],
    ] as const) {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
      );
      vi.stubGlobal("fetch", mockFetch);

      await handler(makeRequest(method, ["some", "path"]), {
        params: Promise.resolve({ path: ["some", "path"] }),
      });

      const [, calledInit] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(calledInit.method).toBe(method);
    }
  });
});
