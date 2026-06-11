import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import {
  USER_AUTH_COOKIE,
  USER_AUTH_MAX_AGE,
  shouldUseSecureUserCookie,
} from "../../../../lib/user-auth-cookie";
import type { PortalSession } from "../../../../lib/user-types";

const BACKEND_BASE_URL =
  process.env.API_BASE_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  "http://localhost:3001/api";

export async function POST(request: NextRequest) {
  const payload = await request.json();

  const response = await fetch(`${BACKEND_BASE_URL}/web/auth/login`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  const raw = await response.text();
  const data = raw ? JSON.parse(raw) : null;

  if (!response.ok) {
    return NextResponse.json(data ?? { message: "Login failed" }, {
      status: response.status,
    });
  }

  const session = data as PortalSession;
  const cookieStore = await cookies();

  cookieStore.set(USER_AUTH_COOKIE, session.accessToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureUserCookie(request),
    path: "/",
    maxAge: USER_AUTH_MAX_AGE,
  });

  return NextResponse.json({ customer: session.customer });
}
