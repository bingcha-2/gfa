/**
 * Generic authenticated proxy for portal data endpoints.
 *
 * Forwards GET/POST/PATCH/DELETE requests to the backend /account/<path>
 * using the user's httpOnly cookie as a Bearer token.
 *
 * Security: ONLY proxies to /account/* paths — never to other backend routes.
 *
 * NOTE: Do NOT add /api/account or /api/account-session to next.config.ts
 * rewrites — that would bypass these route handlers and break authentication
 * entirely.
 */

import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import { USER_AUTH_COOKIE } from "@/lib/account/user-auth-cookie";
import { getBackendBaseUrl } from "@/lib/backend-url";

const ALLOWED_METHODS = new Set(["GET", "POST", "PATCH", "DELETE"]);

/**
 * Layer 1 of path traversal protection.
 *
 * new URL() resolves dot segments — including percent-encoded ones ("%2e%2e"
 * is treated as ".." by the WHATWG URL parser) — so a crafted segment could
 * escape the /account/ prefix and reach e.g. /api/console. Reject any segment
 * that is empty, contains "..", "/" or "\", or decodes to any of those.
 */
function isUnsafeSegment(segment: string): boolean {
  const containsBad = (s: string) =>
    s.includes("..") || s.includes("/") || s.includes("\\");

  if (!segment) return true; // empty segment
  if (containsBad(segment)) return true;

  try {
    const decoded = decodeURIComponent(segment);
    if (!decoded || containsBad(decoded)) return true;
  } catch {
    return true; // malformed percent-encoding — reject
  }

  return false;
}

async function handler(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;

  // Enforce that path segments are present
  if (!path || path.length === 0) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  // Layer 1: reject traversal / separator / empty segments outright
  if (path.some(isUnsafeSegment)) {
    return NextResponse.json({ error: "BAD_REQUEST" }, { status: 400 });
  }

  // Only allow supported methods
  const method = request.method.toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return NextResponse.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405 });
  }

  // Read the user token from the httpOnly cookie
  const cookieStore = await cookies();
  const token = cookieStore.get(USER_AUTH_COOKIE)?.value;

  if (!token) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  // Build the backend URL — ONLY /account/* is permitted
  const backendBaseUrl = getBackendBaseUrl();
  const pathStr = path.join("/");
  const backendUrl = new URL(`${backendBaseUrl}/account/${pathStr}`);

  // Layer 2: assert the resolved pathname is still under <base>/account/.
  // Defense in depth in case Layer 1 ever misses an encoding the URL parser
  // normalizes into a traversal.
  const expectedPrefix = `${new URL(backendBaseUrl).pathname.replace(/\/+$/, "")}/account/`;
  if (!backendUrl.pathname.startsWith(expectedPrefix)) {
    return NextResponse.json({ error: "BAD_REQUEST" }, { status: 400 });
  }

  // Forward query string from the incoming request URL
  const incomingUrl = new URL(request.url);
  incomingUrl.searchParams.forEach((value, key) => {
    backendUrl.searchParams.set(key, value);
  });

  // Build headers
  const forwardHeaders = new Headers({
    accept: "application/json",
    authorization: `Bearer ${token}`,
  });

  // Forward content-type for body methods
  const contentType = request.headers.get("content-type");
  if (contentType) {
    forwardHeaders.set("content-type", contentType);
  }

  // Forward request body for POST/PATCH/DELETE (GET stays body-less)
  let body: BodyInit | undefined;
  if (method !== "GET") {
    body = await request.text();
    if (!body) body = undefined;
  }

  let backendResponse: Response;
  let responseText: string;
  try {
    backendResponse = await fetch(backendUrl.toString(), {
      method,
      headers: forwardHeaders,
      body,
      cache: "no-store",
    });
    responseText = await backendResponse.text();
  } catch (err) {
    // Backend down (ECONNREFUSED etc.) — return a structured 502, not a stack trace.
    return NextResponse.json(
      {
        error: "SERVICE_UNAVAILABLE",
        message: err instanceof Error ? err.message : "Backend unreachable",
      },
      { status: 502 }
    );
  }

  return new NextResponse(responseText || null, {
    status: backendResponse.status,
    headers: {
      "content-type":
        backendResponse.headers.get("content-type") ?? "application/json",
    },
  });
}

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;
