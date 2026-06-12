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
// Three host envs — one per Next-served audience surface (hostname only:
// scheme is ignored, a :port suffix is stripped, case-insensitive):
//
//   MARKETING_HOST  e.g. "bcai.lol"          官网 marketing pages
//   ACCOUNT_HOST    e.g. "my.bcai.lol"       toC 用户中心 (/account/*)
//   CONSOLE_HOST    e.g. "console.bcai.lol"  toB 管理后台 (/console/*)
//
// CONSOLE_HOST is canonical; ADMIN_HOST is honored as a legacy alias (the
// M12c single-subdomain deploy set it). When both are set, CONSOLE_HOST wins.
//
// The fourth subdomain of the split, api.<domain> (machine clients: desktop
// app, epay callbacks), is proxied by Caddy DIRECTLY to NestJS and never
// reaches Next.js — so this middleware deliberately knows nothing about it.
//
// Modes:
//
//   ALL UNSET (default — local dev and the single-domain deploy):
//     No host checks at all. One domain serves marketing + /account +
//     /console exactly as before. applyHostIsolation() is a no-op.
//
//   ANY SET (split-domain deploy; see Caddyfile.migration):
//     The gate is active. Each configured host serves ONLY its surface
//     (matching order: console → account → marketing, so the envs must point
//     at distinct hostnames):
//       · CONSOLE_HOST  → /console/* (or the ADMIN_PATH_PREFIX alias), the
//         root /login page, /api/console-session/*, /api/console/*, plus the
//         console-consumed ops APIs (/api/app/lease/*, /api/remote-stats/*,
//         /api/faq-images/*). The ADMIN_IP_ALLOWLIST applies to this WHOLE
//         host. Everything else → 404.
//       · ACCOUNT_HOST  → /account/*, /api/account/*, /api/account-session/*.
//         The bare root redirects to /account. Everything else (marketing
//         pages, console surface, machine APIs) → 404.
//       · MARKETING_HOST→ marketing pages and static assets; the only /api/*
//         namespace is /api/faq-images/* (FAQ pages embed those images —
//         the FAQ text itself is fetched server-side from the backend
//         origin, not through /api/*). /account/*, the console surface and
//         every other /api/* → 404.
//     Requests on a host that matches NONE of the configured hosts (fallback
//     domains, raw IPs, localhost smoke tests) get the legacy combined
//     CUSTOMER surface: marketing + /account + customer APIs, with the
//     console surface 404'd. The console therefore fails CLOSED: once any
//     host env is set, it is served only on CONSOLE_HOST (set it — or the
//     ADMIN_HOST alias — whenever the gate is active).
//
//     404 (not redirect) is deliberate everywhere: "not here" reveals
//     nothing about which surface lives on which hostname.
//
// The reverse proxy must forward the original Host header unchanged —
// Caddy's reverse_proxy does this by default. Host gating is routing-level
// isolation; authentication remains the cookie/Bearer guards plus the IP
// allowlist. Per-subdomain cookie scoping is configured separately via
// ACCOUNT_COOKIE_DOMAIN / CONSOLE_COOKIE_DOMAIN (see lib/account/
// user-auth-cookie.ts and lib/console/auth-cookie.ts).

/** Normalize a host env value: trim, lowercase, strip a :port suffix. */
function parseHostEnv(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/:\d+$/, "");
}

const MARKETING_HOST = parseHostEnv(process.env.MARKETING_HOST);
const ACCOUNT_HOST = parseHostEnv(process.env.ACCOUNT_HOST);
const CONSOLE_HOST =
  parseHostEnv(process.env.CONSOLE_HOST) || parseHostEnv(process.env.ADMIN_HOST);

const HOST_GATE_ACTIVE = Boolean(MARKETING_HOST || ACCOUNT_HOST || CONSOLE_HOST);

// Customer-facing API namespaces that must NOT exist on the console host:
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

/** The console page surface: /console/*, the ADMIN_PATH_PREFIX alias and the
 *  root /login console login page. */
function isConsoleSurfacePath(pathname: string): boolean {
  return (
    matchesPathPrefix(pathname, "/console") ||
    matchesPathPrefix(pathname, `/${ADMIN_PREFIX}`) ||
    matchesPathPrefix(pathname, "/login")
  );
}

/** Assets every Next-served host needs: /bcai-icon.png (the icon the root
 *  layout declares on every surface) and /_next/* (only the non-static
 *  /_next paths reach the middleware — _next/static, _next/image and
 *  favicon.ico are excluded by config.matcher, as is /updates/*). */
function isSharedAssetPath(pathname: string): boolean {
  return pathname === "/bcai-icon.png" || matchesPathPrefix(pathname, "/_next");
}

// ─── Per-host gates (only run when HOST_GATE_ACTIVE) ──────────────────────────

/** CONSOLE_HOST: only the console surface exists here. */
function gateConsoleHost(request: NextRequest, pathname: string): NextResponse | null {
  // The IP allowlist covers the WHOLE host (login page, session API, static
  // assets and backend-proxied admin APIs included), not just console pages.
  if (IP_ALLOWLIST.length > 0 && !isIpAllowed(getClientIp(request))) {
    return notFound();
  }

  // Convenience: the bare console domain lands on the console (whose auth
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

  if (isSharedAssetPath(pathname)) {
    return null;
  }

  if (matchesPathPrefix(pathname, "/api")) {
    // Lease-pool ops (status / announcement / reload-access-keys) live
    // under the desktop-client surface /api/app/lease/* but are consumed
    // by the console lease pages — keep them reachable on the console host
    // (they were never host-gated when they lived at /api/remote-*).
    if (matchesPathPrefix(pathname, "/api/app/lease")) {
      return null;
    }
    // Customer API namespaces do not exist on the console host; every other
    // /api/* path is console surface (console session routes handled by
    // Next, admin Bearer APIs proxied to the backend by next.config.ts,
    // plus /api/remote-stats/* and /api/faq-images/* used by console pages).
    const isCustomerApi = CUSTOMER_API_PREFIXES.some((prefix) =>
      matchesPathPrefix(pathname, prefix)
    );
    return isCustomerApi ? notFound() : null;
  }

  if (isConsoleSurfacePath(pathname)) {
    // Continue into the normal console pipeline below (custom-prefix
    // rewrite, the /console-404 rule when a custom prefix is configured,
    // and the console cookie auth guard).
    return null;
  }

  // Marketing pages, /account/*, and anything else: "not here".
  return notFound();
}

/** ACCOUNT_HOST: only the toC portal surface exists here. */
function gateAccountHost(request: NextRequest, pathname: string): NextResponse | null {
  // Convenience: the bare account domain lands on the portal (whose cookie
  // guard below then bounces to /account/login). Unlike a custom
  // ADMIN_PATH_PREFIX, /account is not a secret, so this never leaks.
  if (pathname === "/") {
    const accountUrl = request.nextUrl.clone();
    accountUrl.pathname = "/account";
    return NextResponse.redirect(accountUrl);
  }

  if (isSharedAssetPath(pathname)) {
    return null;
  }

  if (
    matchesPathPrefix(pathname, "/account") ||
    matchesPathPrefix(pathname, "/api/account") ||
    matchesPathPrefix(pathname, "/api/account-session")
  ) {
    // Continue into the portal pipeline below (auth-page exemptions and the
    // cookie redirect).
    return null;
  }

  // Marketing pages, the console surface, machine APIs (and /api/faq-images,
  // which no account page uses): "not here".
  return notFound();
}

/** MARKETING_HOST: only the marketing surface exists here. */
function gateMarketingHost(pathname: string): NextResponse | null {
  if (matchesPathPrefix(pathname, "/account")) {
    return notFound();
  }
  if (isConsoleSurfacePath(pathname)) {
    return notFound();
  }
  if (matchesPathPrefix(pathname, "/api")) {
    // The FAQ images embedded in marketing FAQ content are the only /api/*
    // namespace the marketing pages load from the browser (the FAQ text is
    // fetched server-side from the backend origin, not via /api/*).
    return matchesPathPrefix(pathname, "/api/faq-images") ? null : notFound();
  }
  // Marketing pages, /_next/*, public/ static assets: pass through.
  return null;
}

/** Any host that matches none of the configured hosts (fallback domains, raw
 *  IPs, localhost): the legacy combined customer surface — marketing +
 *  /account + customer APIs — with the console surface 404'd. */
function gateUnmatchedHost(pathname: string): NextResponse | null {
  if (
    isConsoleSurfacePath(pathname) ||
    matchesPathPrefix(pathname, "/api/console-session") ||
    matchesPathPrefix(pathname, "/api/console")
  ) {
    return notFound();
  }
  return null;
}

/**
 * Host-isolation gate. Returns a terminal response (404 / redirect) when the
 * requested path does not belong on the requested host, or null to let the
 * request continue into the normal pipeline below.
 *
 * Inactive (always null) when no host env is set — single-domain behavior
 * is byte-for-byte the pre-split behavior in that case.
 */
function applyHostIsolation(request: NextRequest, pathname: string): NextResponse | null {
  if (!HOST_GATE_ACTIVE) return null; // single-domain mode — gate disabled

  const host = getRequestHost(request);
  if (CONSOLE_HOST && host === CONSOLE_HOST) return gateConsoleHost(request, pathname);
  if (ACCOUNT_HOST && host === ACCOUNT_HOST) return gateAccountHost(request, pathname);
  if (MARKETING_HOST && host === MARKETING_HOST) return gateMarketingHost(pathname);
  return gateUnmatchedHost(pathname);
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

  // ── 0. Host isolation (no-op unless a host env is set) ────────────────────
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
