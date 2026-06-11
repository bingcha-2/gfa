/**
 * Portal user auth cookie — independent of the admin console cookie.
 * Cookie name: gfa.user.token  (httpOnly, lax, secure when behind HTTPS, 30 days)
 */

export const USER_AUTH_COOKIE = "gfa.user.token";

// 30 days in seconds
export const USER_AUTH_MAX_AGE = 60 * 60 * 24 * 30;

type CookieRequestLike = {
  headers: Headers;
  nextUrl: {
    protocol: string;
  };
};

const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);

export function shouldUseSecureUserCookie(request: CookieRequestLike) {
  const rawOverride = process.env.USER_COOKIE_SECURE?.trim();

  if (rawOverride) {
    return TRUTHY_VALUES.has(rawOverride.toLowerCase());
  }

  const forwardedProto = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();

  return request.nextUrl.protocol === "https:" || forwardedProto === "https";
}
