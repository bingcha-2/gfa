import { describe, it, expect } from "vitest";
import {
  USER_AUTH_COOKIE,
  USER_AUTH_MAX_AGE,
  shouldUseSecureUserCookie,
} from "@/lib/user-auth-cookie";

describe("user-auth-cookie", () => {
  it("cookie name is gfa.user.token", () => {
    expect(USER_AUTH_COOKIE).toBe("gfa.user.token");
  });

  it("max age is 30 days in seconds", () => {
    const thirtyDays = 60 * 60 * 24 * 30;
    expect(USER_AUTH_MAX_AGE).toBe(thirtyDays);
  });

  it("shouldUseSecureUserCookie returns false for http:", () => {
    const request = {
      headers: new Headers(),
      nextUrl: { protocol: "http:" },
    };
    expect(shouldUseSecureUserCookie(request)).toBe(false);
  });

  it("shouldUseSecureUserCookie returns true for https:", () => {
    const request = {
      headers: new Headers(),
      nextUrl: { protocol: "https:" },
    };
    expect(shouldUseSecureUserCookie(request)).toBe(true);
  });

  it("shouldUseSecureUserCookie returns true when x-forwarded-proto is https", () => {
    const headers = new Headers({ "x-forwarded-proto": "https" });
    const request = {
      headers,
      nextUrl: { protocol: "http:" },
    };
    expect(shouldUseSecureUserCookie(request)).toBe(true);
  });

  it("shouldUseSecureUserCookie uses env override when set to '1'", () => {
    const original = process.env.USER_COOKIE_SECURE;
    process.env.USER_COOKIE_SECURE = "1";
    const request = {
      headers: new Headers(),
      nextUrl: { protocol: "http:" },
    };
    expect(shouldUseSecureUserCookie(request)).toBe(true);
    process.env.USER_COOKIE_SECURE = original;
  });

  it("shouldUseSecureUserCookie env override false overrides https", () => {
    const original = process.env.USER_COOKIE_SECURE;
    process.env.USER_COOKIE_SECURE = "false";
    const request = {
      headers: new Headers(),
      nextUrl: { protocol: "https:" },
    };
    expect(shouldUseSecureUserCookie(request)).toBe(false);
    process.env.USER_COOKIE_SECURE = original;
  });
});
