/**
 * Auth layout guard — src/app/(account)/account/(auth)/layout.tsx
 *
 * Regression guard for the /account ↔ /account/login 307 redirect loop.
 *
 * Three guards decide "is this request logged in?":
 *   - middleware         → cookie presence only (fast edge gate)
 *   - (main)/layout.tsx  → backend /me check (authoritative)
 *   - (auth)/layout.tsx  → THIS layout (pushes a logged-in user OFF the login page)
 *
 * The (auth) push must use the SAME authority as (main): a backend check. If it
 * redirects on cookie *presence* alone, a stale-but-present cookie makes (auth)
 * bounce /account/login → /account while (main) bounces /account → /account/login
 * — an infinite 307 loop. A 30-day cookie WILL outlive its session (expiry,
 * backend restart, revoked token), so the loop is inevitable, not a corner case.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getUserTokenFromCookie, getCustomerFromCookie, redirectMock } = vi.hoisted(() => ({
  getUserTokenFromCookie: vi.fn(),
  getCustomerFromCookie: vi.fn(),
  // Mirror next/navigation: redirect() throws to abort rendering.
  redirectMock: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

vi.mock("@/lib/account/user-server-api", () => ({
  getUserTokenFromCookie,
  getCustomerFromCookie,
}));

import AuthLayout from "@/app/(account)/account/(auth)/layout";

const LOGIN_CHILDREN = "login-form";

describe("(auth)/layout — login-page redirect guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the login page (no redirect) when a cookie is present but the backend session is invalid — the /account ↔ /account/login loop", async () => {
    // Stale cookie: present on the request, but the backend /me check rejects it.
    getUserTokenFromCookie.mockResolvedValue("stale-cookie-token");
    getCustomerFromCookie.mockResolvedValue(null);

    const result = await AuthLayout({ children: LOGIN_CHILDREN });

    expect(redirectMock).not.toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it("renders the login page (no redirect) when there is no session at all", async () => {
    getUserTokenFromCookie.mockResolvedValue(null);
    getCustomerFromCookie.mockResolvedValue(null);

    const result = await AuthLayout({ children: LOGIN_CHILDREN });

    expect(redirectMock).not.toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it("redirects to /account when the backend confirms a valid session", async () => {
    getUserTokenFromCookie.mockResolvedValue("valid-token");
    getCustomerFromCookie.mockResolvedValue({ id: "u1", email: "member@example.com" });

    await expect(AuthLayout({ children: LOGIN_CHILDREN })).rejects.toThrow("NEXT_REDIRECT:/account");
    expect(redirectMock).toHaveBeenCalledWith("/account");
  });
});
