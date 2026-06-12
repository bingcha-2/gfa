/**
 * Tests for the portal register route handler:
 *   src/app/api/account-session/register/route.ts
 *
 * Near-copy of the login suite — register must also set the user cookie.
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

import { POST } from "@/app/api/account-session/register/route";

function makeRegisterRequest(body: Record<string, string>) {
  const req = new Request("http://localhost/api/account-session/register", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  Object.defineProperty(req, "nextUrl", {
    value: new URL("http://localhost/api/account-session/register"),
    writable: false,
  });
  return req as unknown as import("next/server").NextRequest;
}

describe("api/account-session/register", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets the gfa.user.token cookie and returns customer on 201", async () => {
    const customer = {
      id: "cust-2",
      email: "new@example.com",
      displayName: "New User",
      emailVerified: false,
      referralCode: "REF456",
      creditCents: 0,
      status: "ACTIVE",
      createdAt: "2026-06-01T00:00:00.000Z",
    };

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ accessToken: "fresh-jwt", customer }),
        { status: 201, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", mockFetch);

    const resp = await POST(
      makeRegisterRequest({
        email: "new@example.com",
        password: "secret123",
        displayName: "New User",
      })
    );

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.customer).toEqual(customer);

    expect(mockCookieSet).toHaveBeenCalledOnce();
    const [name, value, options] = mockCookieSet.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe("gfa.user.token");
    expect(value).toBe("fresh-jwt");
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.maxAge).toBe(60 * 60 * 24 * 30);
  });

  it("passes through backend error without setting cookie", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ message: "Email already registered" }),
        { status: 409, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", mockFetch);

    const resp = await POST(
      makeRegisterRequest({ email: "taken@example.com", password: "pw123456" })
    );

    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.message).toBe("Email already registered");
    expect(mockCookieSet).not.toHaveBeenCalled();
  });

  it("forwards the payload to the backend /account/auth/register endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          accessToken: "tok",
          customer: { id: "c1", email: "a@b.com", displayName: "", emailVerified: false, referralCode: "", creditCents: 0, status: "ACTIVE", createdAt: "" },
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", mockFetch);

    await POST(
      makeRegisterRequest({
        email: "a@b.com",
        password: "pw",
        displayName: "Alice",
        referralCode: "FRIEND1",
      })
    );

    const [calledUrl, calledInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toContain("/account/auth/register");
    expect(calledInit.method).toBe("POST");

    const sentBody = JSON.parse(calledInit.body as string);
    expect(sentBody).toEqual({
      email: "a@b.com",
      password: "pw",
      displayName: "Alice",
      referralCode: "FRIEND1",
    });
  });

  it("returns 502 SERVICE_UNAVAILABLE when the backend is unreachable", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", mockFetch);

    const resp = await POST(
      makeRegisterRequest({ email: "a@b.com", password: "pw" })
    );

    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.error).toBe("SERVICE_UNAVAILABLE");
    expect(mockCookieSet).not.toHaveBeenCalled();
  });
});
