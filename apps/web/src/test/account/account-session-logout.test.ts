/**
 * Tests for the portal logout route handler:
 *   src/app/api/account-session/logout/route.ts
 *
 * Cookie identity is (name, domain, path) — a Domain-scoped cookie
 * (ACCOUNT_COOKIE_DOMAIN set, split-domain deploys) can only be cleared by a
 * delete that carries the same Domain. These tests pin both shapes.
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

import { POST } from "@/app/api/account-session/logout/route";

describe("api/account-session/logout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("deletes the host-only cookie by name when ACCOUNT_COOKIE_DOMAIN is unset", async () => {
    const resp = await POST();

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
    expect(mockCookieDelete).toHaveBeenCalledOnce();
    expect(mockCookieDelete).toHaveBeenCalledWith("gfa.user.token");
  });

  it("deletes the Domain-scoped cookie when ACCOUNT_COOKIE_DOMAIN is set", async () => {
    vi.stubEnv("ACCOUNT_COOKIE_DOMAIN", "my.bcai.lol");

    const resp = await POST();

    expect(resp.status).toBe(200);
    expect(mockCookieDelete).toHaveBeenCalledOnce();
    expect(mockCookieDelete).toHaveBeenCalledWith({
      name: "gfa.user.token",
      path: "/",
      domain: "my.bcai.lol",
    });
  });
});
