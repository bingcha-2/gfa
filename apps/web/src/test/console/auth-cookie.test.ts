import { describe, it, expect, vi, afterEach } from "vitest";
import {
  CONSOLE_AUTH_COOKIE,
  CONSOLE_AUTH_MAX_AGE,
  getConsoleCookieDomain,
  shouldUseSecureConsoleCookie,
} from "@/lib/console/auth-cookie";

describe("console auth-cookie", () => {
  it("cookie name is gfa.console.token", () => {
    expect(CONSOLE_AUTH_COOKIE).toBe("gfa.console.token");
  });

  it("max age is 12 hours in seconds", () => {
    expect(CONSOLE_AUTH_MAX_AGE).toBe(60 * 60 * 12);
  });

  it("shouldUseSecureConsoleCookie follows the protocol / x-forwarded-proto", () => {
    expect(
      shouldUseSecureConsoleCookie({ headers: new Headers(), nextUrl: { protocol: "http:" } })
    ).toBe(false);
    expect(
      shouldUseSecureConsoleCookie({ headers: new Headers(), nextUrl: { protocol: "https:" } })
    ).toBe(true);
    expect(
      shouldUseSecureConsoleCookie({
        headers: new Headers({ "x-forwarded-proto": "https" }),
        nextUrl: { protocol: "http:" },
      })
    ).toBe(true);
  });

  describe("getConsoleCookieDomain (CONSOLE_COOKIE_DOMAIN)", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("returns undefined when the env is unset (host-only cookie — dev behavior)", () => {
      vi.stubEnv("CONSOLE_COOKIE_DOMAIN", undefined);
      expect(getConsoleCookieDomain()).toBeUndefined();
    });

    it("returns undefined when the env is empty/whitespace", () => {
      vi.stubEnv("CONSOLE_COOKIE_DOMAIN", "   ");
      expect(getConsoleCookieDomain()).toBeUndefined();
    });

    it("returns the env value when set (split-domain deploys)", () => {
      vi.stubEnv("CONSOLE_COOKIE_DOMAIN", "console.bcai.lol");
      expect(getConsoleCookieDomain()).toBe("console.bcai.lol");
    });
  });
});
