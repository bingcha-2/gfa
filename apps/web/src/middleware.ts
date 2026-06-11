import { NextRequest, NextResponse } from "next/server";
import { CONSOLE_AUTH_COOKIE } from "./lib/auth-cookie";
import { USER_AUTH_COOKIE } from "./lib/user-auth-cookie";

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

  // Admin API routes: /api/session/* (login / logout) — always protected
  const isAdminApiRoute = pathname.startsWith("/api/session/");

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
