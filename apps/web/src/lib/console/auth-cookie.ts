export const CONSOLE_AUTH_COOKIE = "gfa.console.token";
export const CONSOLE_AUTH_MAX_AGE = 60 * 60 * 12;

type CookieRequestLike = {
  headers: Headers;
  nextUrl: {
    protocol: string;
  };
};

const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);

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
