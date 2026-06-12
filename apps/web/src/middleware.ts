import { NextRequest, NextResponse } from "next/server";
import { CONSOLE_AUTH_COOKIE } from "./lib/console/auth-cookie";
import { USER_AUTH_COOKIE } from "./lib/account/user-auth-cookie";

// ─── Config ───────────────────────────────────────────────────────────────────

// The URL prefix for the admin console (without leading slash).
// Default: "console" → /console/login
// Production: set to any random string, e.g. "manage-x7k2p"
const ADMIN_PREFIX = (process.env.ADMIN_PATH_PREFIX ?? "console").replace(/^\/|\/$/g, "");
const PROTECTED_STATIC_PAGES = new Set<string>();

// Comma-separated list of allowed client IPs for admin routes.
// Leave empty to allow all IPs (useful when client IP is dynamic).
// Example: "1.2.3.4,10.0.0.0/8"
const RAW_ALLOWLIST = process.env.ADMIN_IP_ALLOWLIST ?? "";

const IP_ALLOWLIST: string[] = RAW_ALLOWLIST
  ? RAW_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

// ─── Host-based isolation (split-domain deploys) ──────────────────────────────
//
// ADMIN_HOST: hostname of the dedicated admin/console subdomain, e.g.
// "admin.example.com" (hostname only — scheme is ignored, a :port suffix is
// stripped). Drives two mutually exclusive serving modes:
//
//   UNSET (default — local dev and the current single-domain deploy):
//     No host checks at all. One domain serves marketing + /account +
//     /console exactly as before. Nothing below this comment runs.
//
//   SET (split-domain deploy; see Caddyfile.migration):
//     · Requests whose Host equals ADMIN_HOST get ONLY the admin surface:
//       /console/* (or the ADMIN_PATH_PREFIX alias), the root /login page,
//       /api/console-session/* (console cookie login/logout, Next route
//       handlers) and the admin backend API (/api/console/* — proxied to
//       NestJS by next.config.ts rewrites). Marketing pages, /account/* and
//       customer APIs return 404 there — a deliberate
//       "not here": the middleware only knows the admin hostname, so it
//       cannot redirect to the customer domain, and a bare 404 reveals
//       nothing about what lives where.
//     · Requests on ANY other host (customer domain, fallback domains, raw
//       IP) get everything EXCEPT the console surface: /console/*, the
//       ADMIN_PATH_PREFIX alias, /login, /api/console-session/* and
//       /api/console/* return 404. Marketing, /account/* and customer APIs
//       are untouched.
//
// The reverse proxy must forward the original Host header unchanged —
// Caddy's reverse_proxy does this by default. Host gating is routing-level
// isolation; authentication remains the cookie/Bearer guards plus the IP
// allowlist (which, on the admin host, applies to the whole host).
const ADMIN_HOST = (process.env.ADMIN_HOST ?? "")
  .trim()
  .toLowerCase()
  .replace(/:\d+$/, "");

// Customer-facing API namespaces that must NOT exist on the admin host:
// /api/account (portal cookie→Bearer proxy), /api/account-session (portal
// cookie login), /api/app (desktop client), /api/epay (payment callbacks).
const CUSTOMER_API_PREFIXES = ["/api/account", "/api/account-session", "/api/app", "/api/epay"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract the real client IP from the request. */
function getClientIp(request: NextRequest): string {
  // Trust X-Forwarded-For when behind a reverse proxy / Docker network
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  // Some proxies set X-Real-IP
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "unknown";
}

/** Simple prefix/exact match (no CIDR parsing — keep it zero-dependency). */
function isIpAllowed(ip: string): boolean {
  if (IP_ALLOWLIST.length === 0) return true;   // no whitelist = allow all
  return IP_ALLOWLIST.some((allowed) => ip === allowed || ip.startsWith(allowed));
}

/** Return a convincing 404 to hide the existence of admin routes. */
function notFound() {
  return new NextResponse(null, { status: 404 });
}

/** Hostname of the request: Host header without port, lowercased.
 *  Falls back to the parsed request URL when the header is missing. */
function getRequestHost(request: NextRequest): string {
  const host = request.headers.get("host") ?? request.nextUrl.host;
  return host.split(":")[0].trim().toLowerCase();
}

/** Exact-segment prefix match: matches `prefix` itself and `prefix/...`,
 *  but not sibling paths (e.g. "/api/account" must not match
 *  "/api/account-session"). */
function matchesPathPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

/**
 * Host-isolation gate. Returns a terminal response (404 / redirect) when the
 * requested path does not belong on the requested host, or null to let the
 * request continue into the normal pipeline below.
 *
 * Inactive (always null) when ADMIN_HOST is unset — single-domain behavior
 * is byte-for-byte the pre-ADMIN_HOST behavior in that case.
 */
function applyHostIsolation(request: NextRequest, pathname: string): NextResponse | null {
  if (!ADMIN_HOST) return null; // single-domain mode — gate disabled

  const isConsolePath = matchesPathPrefix(pathname, "/console");
  const isAdminPrefixPath = matchesPathPrefix(pathname, `/${ADMIN_PREFIX}`);
  const isConsoleLoginPath = matchesPathPrefix(pathname, "/login");
  const isConsoleSessionApi = matchesPathPrefix(pathname, "/api/console-session");
  const isApiPath = matchesPathPrefix(pathname, "/api");

  if (getRequestHost(request) === ADMIN_HOST) {
    // ── Admin host: only the console surface exists here. ──────────────────
    // The IP allowlist covers the WHOLE host (login page, session API and
    // backend-proxied admin APIs included), not just the console page paths.
    if (IP_ALLOWLIST.length > 0 && !isIpAllowed(getClientIp(request))) {
      return notFound();
    }

    // Convenience: the bare admin domain lands on the console (whose auth
    // guard then bounces to its login page). Only safe with the default
    // prefix — a custom ADMIN_PATH_PREFIX is a secret and must not leak via
    // a redirect, so the root stays a 404 in that case.
    if (pathname === "/") {
      if (ADMIN_PREFIX === "console") {
        const consoleUrl = request.nextUrl.clone();
        consoleUrl.pathname = "/console";
        return NextResponse.redirect(consoleUrl);
      }
      return notFound();
    }

    if (isApiPath) {
      // Lease-pool ops (status / announcement / reload-access-keys) live
      // under the desktop-client surface /api/app/lease/* but are consumed
      // by the console lease pages — keep them reachable on the admin host
      // (they were never host-gated when they lived at /api/remote-*).
      if (matchesPathPrefix(pathname, "/api/app/lease")) {
        return null;
      }
      // Customer API namespaces do not exist on the admin host; every other
      // /api/* path is admin surface (console session routes handled by
      // Next, admin Bearer APIs proxied to the backend by next.config.ts).
      const isCustomerApi = CUSTOMER_API_PREFIXES.some((prefix) =>
        matchesPathPrefix(pathname, prefix)
      );
      return isCustomerApi ? notFound() : null;
    }

    if (isConsolePath || isAdminPrefixPath || isConsoleLoginPath) {
      // Continue into the normal console pipeline below (custom-prefix
      // rewrite, the /console-404 rule when a custom prefix is configured,
      // and the console cookie auth guard).
      return null;
    }

    // Marketing pages, /account/*, and anything else: "not here".
    return notFound();
  }

  // ── Customer host(s): the console surface does not exist here. ───────────
  // This includes the canonical /console paths, the ADMIN_PATH_PREFIX alias,
  // the root /login page, the console cookie session API, and the
  // console-namespaced backend API.
  if (
    isConsolePath ||
    isAdminPrefixPath ||
    isConsoleLoginPath ||
    isConsoleSessionApi ||
    matchesPathPrefix(pathname, "/api/console")
  ) {
    return notFound();
  }

  // Marketing + /account/* + customer APIs — continue unchanged.
  return null;
}

// ─── Middleware ───────────────────────────────────────────────────────────────

// ─── Portal auth pages (no redirect when already logged in — handled by layout) ─
// /account/verify-email is exempt too: the user clicks it from an email and may
// not be logged in; it must render with or without a session cookie.
const PORTAL_AUTH_PAGES = [
  "/account/login",
  "/account/register",
  "/account/forgot",
  "/account/reset",
  "/account/verify-email",
];

function isPortalAuthPage(pathname: string): boolean {
  return PORTAL_AUTH_PAGES.some(
    (p) => pathname === p || pathname.startsWith(p + "/")
  );
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── 0. Host isolation (no-op unless ADMIN_HOST is set) ────────────────────
  const hostGateResponse = applyHostIsolation(request, pathname);
  if (hostGateResponse) {
    return hostGateResponse;
  }

  // ── Portal branch (independent of console) ────────────────────────────────
  // Protect /account/* routes (but not auth pages themselves).
  const isPortalPath = pathname === "/account" || pathname.startsWith("/account/");

  if (isPortalPath && !isPortalAuthPage(pathname)) {
    const hasUserToken = request.cookies.has(USER_AUTH_COOKIE);
    if (!hasUserToken) {
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = "/account/login";
      return NextResponse.redirect(loginUrl);
    }
    // Has token — pass through; backend validation happens in the layout.
    return NextResponse.next();
  }

  // The canonical path that Next.js file system uses is always /console/*
  const isConsolePath = pathname === "/console" || pathname.startsWith("/console/");

  // ── 1. Determine what kind of request this is ─────────────────────────────

  // Admin API routes: /api/console-session/* (login / logout) — always protected
  const isAdminApiRoute = pathname.startsWith("/api/console-session/");

  // Admin page routes: /{prefix}/* (the public-facing URL)
  const isAdminPageRoute =
    pathname === `/${ADMIN_PREFIX}` || pathname.startsWith(`/${ADMIN_PREFIX}/`);

  // When a custom prefix is configured, block direct access to the old /console path.
  // Return 404 (not 403) so the path doesn't appear to exist.
  if (ADMIN_PREFIX !== "console" && isConsolePath) {
    return notFound();
  }

  const isAdminRequest = isAdminPageRoute || isAdminApiRoute;
  const isProtectedStaticPage = PROTECTED_STATIC_PAGES.has(pathname);

  if (!isAdminRequest && !isProtectedStaticPage) {
    // Public routes — pass through unconditionally.
    return NextResponse.next();
  }

  // ── 2. IP allowlist check ─────────────────────────────────────────────────
  if (IP_ALLOWLIST.length > 0) {
    const clientIp = getClientIp(request);
    if (!isIpAllowed(clientIp)) {
      return notFound();
    }
  }

  // ── 3. Hidden-path rewrite ────────────────────────────────────────────────
  // Transparently rewrite /{custom-prefix}/* → /console/* for Next.js routing.
  if (ADMIN_PREFIX !== "console" && isAdminPageRoute) {
    const rewrittenPath = pathname.replace(`/${ADMIN_PREFIX}`, "/console");
    const rewrittenUrl = request.nextUrl.clone();
    rewrittenUrl.pathname = rewrittenPath;
    return NextResponse.rewrite(rewrittenUrl);
  }

  // ── 4. Auth guard ─────────────────────────────────────────────────────────
  if (isAdminPageRoute || isProtectedStaticPage) {
    const loginPath = `/${ADMIN_PREFIX}/login`;
    const isLoginPage = pathname === loginPath || pathname.startsWith(`${loginPath}/`);

    if (!isLoginPage) {
      const hasToken = request.cookies.has(CONSOLE_AUTH_COOKIE);
      if (!hasToken) {
        const loginUrl = request.nextUrl.clone();
        loginUrl.pathname = loginPath;
        if (isProtectedStaticPage) {
          loginUrl.searchParams.set("next", pathname);
        }
        return NextResponse.redirect(loginUrl);
      }
    }
  }

  return NextResponse.next();
}

export const config = {
  // Run on all paths except Next.js internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|updates/).*)"]
};
