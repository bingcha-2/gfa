/**
 * Regression: GET /account/me wraps the customer as { customer }, matching the
 * login/register contract. The portal server helper must UNWRAP it to a flat
 * Customer — otherwise the topnav reads customer.email / customer.displayName
 * off the wrapper, gets undefined, and renders a blank name/email with a "·"
 * avatar fallback. (Caught in the account-system branch.)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// `server-only` (imported by user-server-api.ts) is aliased to a no-op stub in
// vitest.config.ts, so the server helper can be exercised directly here.

const mockCookieGet = vi.fn();
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: mockCookieGet })),
}));

import { getCustomerFromCookie } from "@/lib/account/user-server-api";

const CUSTOMER = {
  id: "cust-1",
  email: "member@example.com",
  displayName: "Member One",
  emailVerified: true,
  referralCode: "REF123",
  creditCents: 0,
  status: "ACTIVE",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("getCustomerFromCookie — /account/me { customer } unwrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCookieGet.mockReturnValue({ value: "jwt-token" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("unwraps { customer } into a flat Customer (email/displayName present)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ customer: CUSTOMER }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getCustomerFromCookie();

    // The bug returned the wrapper, so result.email was undefined.
    expect(result).toEqual(CUSTOMER);
    expect(result?.email).toBe("member@example.com");
    expect(result?.displayName).toBe("Member One");

    // Sanity: it hit /account/me with the bearer token.
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/account\/me$/);
    expect((init as RequestInit).headers).toMatchObject({
      authorization: "Bearer jwt-token",
    });
  });

  it("returns null when there is no auth cookie", async () => {
    mockCookieGet.mockReturnValue(undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await getCustomerFromCookie();

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when the backend rejects (e.g. expired token)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "UNAUTHORIZED" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getCustomerFromCookie();

    expect(result).toBeNull();
  });
});
