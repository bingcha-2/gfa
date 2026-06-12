import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import {
  USER_AUTH_COOKIE,
  USER_AUTH_MAX_AGE,
  getUserCookieDomain,
  shouldUseSecureUserCookie,
} from "@/lib/account/user-auth-cookie";
import { getBackendBaseUrl, safeParseJson } from "@/lib/backend-url";
import type { AccountSession } from "@/lib/account/user-types";

export async function POST(request: NextRequest) {
  const payload = await request.json();

  let response: Response;
  let raw: string;
  try {
    response = await fetch(`${getBackendBaseUrl()}/account/auth/register`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    raw = await response.text();
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

  const data = raw ? safeParseJson(raw) : null;

  if (!response.ok) {
    // Non-JSON bodies (HTML error pages) become a structured fallback.
    const errorBody =
      data && typeof data === "object" ? data : { message: "Registration failed" };
    return NextResponse.json(errorBody, { status: response.status });
  }

  const session = data as AccountSession | null;
  if (!session?.accessToken || !session.customer) {
    return NextResponse.json(
      { error: "SERVICE_UNAVAILABLE", message: "Malformed backend response" },
      { status: 502 }
    );
  }

  const cookieStore = await cookies();
  const cookieDomain = getUserCookieDomain();
  cookieStore.set(USER_AUTH_COOKIE, session.accessToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureUserCookie(request),
    path: "/",
    maxAge: USER_AUTH_MAX_AGE,
    // Unset env → no Domain attribute (host-only cookie, dev behavior).
    ...(cookieDomain ? { domain: cookieDomain } : {}),
  });

  return NextResponse.json({ customer: session.customer });
}
