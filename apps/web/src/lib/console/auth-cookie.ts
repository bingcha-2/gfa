export const CONSOLE_AUTH_COOKIE = "gfa.console.token";
export const CONSOLE_AUTH_MAX_AGE = 60 * 60 * 12;

type CookieRequestLike = {
  headers: Headers;
  nextUrl: {
    protocol: string;
  };
};

const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * Optional Domain attribute for the console session cookie.
 *
 * Split-domain deploys set CONSOLE_COOKIE_DOMAIN to the console host itself
 * (e.g. "console.bcai.lol") so the cookie is scoped to that one subdomain.
 * Never set it to the registrable parent domain (".bcai.lol") — that would
 * share the cookie across every subdomain and defeat the isolation.
 *
 * Unset/empty → undefined → host-only cookie (no Domain attribute), which is
 * the single-domain dev behavior, unchanged.
 *
 * Cookie identity is (name, domain, path): a Domain-scoped cookie is a
 * DIFFERENT cookie than a host-only one, so deletes (logout) must pass the
 * same domain — use this helper at every set AND delete site.
 */
export function getConsoleCookieDomain(): string | undefined {
  const raw = process.env.CONSOLE_COOKIE_DOMAIN?.trim();
  return raw ? raw : undefined;
}

export function shouldUseSecureConsoleCookie(request: CookieRequestLike) {
  const rawOverride = process.env.CONSOLE_COOKIE_SECURE?.trim();

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
