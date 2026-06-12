/**
 * Cookie-scoping tests for the console session route handlers:
 *   src/app/api/console-session/login/route.ts
 *   src/app/api/console-session/logout/route.ts
 *
 * CONSOLE_COOKIE_DOMAIN unset → host-only cookie (no Domain attribute) —
 * single-domain dev behavior. Set → the cookie is scoped to that subdomain,
 * and logout must delete with the same Domain (cookie identity is
 * name+domain+path).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCookieSet = vi.fn();
const mockCookieDelete = vi.fn();

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    set: mockCookieSet,
    delete: mockCookieDelete,
    get: vi.fn(),
  })),
}));

import { POST as loginPOST } from "@/app/api/console-session/login/route";
import { POST as logoutPOST } from "@/app/api/console-session/logout/route";

function makeLoginRequest(body: Record<string, string>) {
  const req = new Request("http://localhost/api/console-session/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  Object.defineProperty(req, "nextUrl", {
    value: new URL("http://localhost/api/console-session/login"),
    writable: false,
  });
  return req as unknown as import("next/server").NextRequest;
}

function stubLoginBackend() {
  const mockFetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ accessToken: "admin-jwt", user: { id: "u1", username: "admin" } }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  );
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

describe("api/console-session login/logout cookie scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("login sets a host-only cookie (no Domain) when CONSOLE_COOKIE_DOMAIN is unset", async () => {
    stubLoginBackend();

    const resp = await loginPOST(makeLoginRequest({ username: "admin", password: "pw" }));

    expect(resp.status).toBe(200);
    expect(mockCookieSet).toHaveBeenCalledOnce();
    const [name, value, options] = mockCookieSet.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe("gfa.console.token");
    expect(value).toBe("admin-jwt");
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.maxAge).toBe(60 * 60 * 12);
    expect("domain" in options).toBe(false);
  });

  it("login scopes the cookie to CONSOLE_COOKIE_DOMAIN when set", async () => {
    vi.stubEnv("CONSOLE_COOKIE_DOMAIN", "console.bcai.lol");
    stubLoginBackend();

    await loginPOST(makeLoginRequest({ username: "admin", password: "pw" }));

    expect(mockCookieSet).toHaveBeenCalledOnce();
    const [, , options] = mockCookieSet.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(options.domain).toBe("console.bcai.lol");
  });

  it("logout deletes the host-only cookie by name when CONSOLE_COOKIE_DOMAIN is unset", async () => {
    const resp = await logoutPOST();

    expect(resp.status).toBe(200);
    expect(mockCookieDelete).toHaveBeenCalledOnce();
    expect(mockCookieDelete).toHaveBeenCalledWith("gfa.console.token");
  });

  it("logout deletes the Domain-scoped cookie when CONSOLE_COOKIE_DOMAIN is set", async () => {
    vi.stubEnv("CONSOLE_COOKIE_DOMAIN", "console.bcai.lol");

    const resp = await logoutPOST();

    expect(resp.status).toBe(200);
    expect(mockCookieDelete).toHaveBeenCalledOnce();
    expect(mockCookieDelete).toHaveBeenCalledWith({
      name: "gfa.console.token",
      path: "/",
      domain: "console.bcai.lol",
    });
  });
});
