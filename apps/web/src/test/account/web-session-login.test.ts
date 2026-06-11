/**
 * Tests for the portal login route handler:
 *   src/app/api/web-session/login/route.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Track cookie.set calls ────────────────────────────────────────────────────
const mockCookieSet = vi.fn();
const mockCookieDelete = vi.fn();

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    set: mockCookieSet,
    delete: mockCookieDelete,
    get: vi.fn(),
  })),
}));

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return actual;
});

import { POST } from "@/app/api/web-session/login/route";

function makeLoginRequest(body: Record<string, string>) {
  // Use http:// URL so isSecureRequest returns false (no HTTPS)
  const req = new Request("http://localhost/api/web-session/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  // Attach minimal nextUrl stub so any nextUrl access in Next.js internals works
  Object.defineProperty(req, "nextUrl", {
    value: new URL("http://localhost/api/web-session/login"),
    writable: false,
  });
  return req as unknown as import("next/server").NextRequest;
}

describe("api/web-session/login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets the gfa.user.token cookie and returns customer on 200", async () => {
    const customer = {
      id: "cust-1",
      email: "user@example.com",
      displayName: "Test User",
      emailVerified: true,
      referralCode: "REF123",
      creditCents: 0,
      status: "ACTIVE",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ accessToken: "jwt-token-here", customer }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", mockFetch);

    const resp = await POST(
      makeLoginRequest({ email: "user@example.com", password: "secret123" })
    );

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.customer).toEqual(customer);

    // Cookie must be set
    expect(mockCookieSet).toHaveBeenCalledOnce();
    const [name, value, options] = mockCookieSet.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe("gfa.user.token");
    expect(value).toBe("jwt-token-here");
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    // 30 days
    expect(options.maxAge).toBe(60 * 60 * 24 * 30);
  });

  it("passes through 401 error without setting cookie", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ message: "Invalid credentials" }),
        { status: 401, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", mockFetch);

    const resp = await POST(
      makeLoginRequest({ email: "wrong@example.com", password: "bad" })
    );

    expect(resp.status).toBe(401);
    const body = await resp.json();
    expect(body.message).toBe("Invalid credentials");

    // Cookie must NOT be set on failure
    expect(mockCookieSet).not.toHaveBeenCalled();
  });

  it("forwards the payload to the backend /web/auth/login endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          accessToken: "tok",
          customer: { id: "c1", email: "a@b.com", displayName: "", emailVerified: false, referralCode: "", creditCents: 0, status: "ACTIVE", createdAt: "" },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", mockFetch);

    await POST(makeLoginRequest({ email: "a@b.com", password: "pw" }));

    const [calledUrl, calledInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toContain("/web/auth/login");
    expect(calledInit.method).toBe("POST");

    const sentBody = JSON.parse(calledInit.body as string);
    expect(sentBody).toEqual({ email: "a@b.com", password: "pw" });
  });

  it("returns 502 SERVICE_UNAVAILABLE when the backend is unreachable", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", mockFetch);

    const resp = await POST(
      makeLoginRequest({ email: "a@b.com", password: "pw" })
    );

    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.error).toBe("SERVICE_UNAVAILABLE");
    expect(typeof body.message).toBe("string");
    expect(mockCookieSet).not.toHaveBeenCalled();
  });

  it("returns structured error (not 500) when backend responds with an HTML error page", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      })
    );
    vi.stubGlobal("fetch", mockFetch);

    const resp = await POST(
      makeLoginRequest({ email: "a@b.com", password: "pw" })
    );

    // Status passes through; body must be structured JSON, not a thrown 500
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body).toEqual({ message: "Login failed" });
    expect(mockCookieSet).not.toHaveBeenCalled();
  });
});
