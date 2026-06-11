/**
 * Generic authenticated proxy for portal data endpoints.
 *
 * Forwards GET/POST/PATCH/DELETE requests to the backend /web/<path>
 * using the user's httpOnly cookie as a Bearer token.
 *
 * Security: ONLY proxies to /web/* paths — never to other backend routes.
 *
 * NOTE: Do NOT add /api/web or /api/web-session to next.config.ts rewrites —
 * that would bypass these route handlers and break authentication entirely.
 */

import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import { USER_AUTH_COOKIE } from "../../../../lib/user-auth-cookie";

const BACKEND_BASE_URL =
  process.env.API_BASE_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  "http://localhost:3001/api";

const ALLOWED_METHODS = new Set(["GET", "POST", "PATCH", "DELETE"]);

async function handler(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;

  // Enforce that path segments are present
  if (!path || path.length === 0) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
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

  // Build the backend URL — ONLY /web/* is permitted
  const pathStr = path.join("/");
  const backendUrl = new URL(`${BACKEND_BASE_URL}/web/${pathStr}`);

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

  // Forward request body for non-GET methods
  let body: BodyInit | undefined;
  if (method !== "GET" && method !== "DELETE") {
    body = await request.text();
    if (!body) body = undefined;
  }

  const backendResponse = await fetch(backendUrl.toString(), {
    method,
    headers: forwardHeaders,
    body,
    cache: "no-store",
  });

  const responseText = await backendResponse.text();

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
