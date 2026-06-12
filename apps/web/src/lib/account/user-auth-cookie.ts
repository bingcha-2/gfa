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

/**
 * Optional Domain attribute for the portal session cookie.
 *
 * Split-domain deploys set ACCOUNT_COOKIE_DOMAIN to the account host itself
 * (e.g. "my.bcai.lol") so the cookie is scoped to that one subdomain. Never
 * set it to the registrable parent domain (".bcai.lol") — that would share
 * the cookie across every subdomain and defeat the per-surface isolation.
 *
 * Unset/empty → undefined → host-only cookie (no Domain attribute), which is
 * the single-domain dev behavior, unchanged.
 *
 * Cookie identity is (name, domain, path): a Domain-scoped cookie is a
 * DIFFERENT cookie than a host-only one, so deletes (logout) must pass the
 * same domain — use this helper at every set AND delete site.
 */
export function getUserCookieDomain(): string | undefined {
  const raw = process.env.ACCOUNT_COOKIE_DOMAIN?.trim();
  return raw ? raw : undefined;
}

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
