import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import {
  CONSOLE_AUTH_COOKIE,
  CONSOLE_AUTH_MAX_AGE,
  shouldUseSecureConsoleCookie
} from "@/lib/console/auth-cookie";
import { AuthSession } from "@/lib/console/types";

const BACKEND_BASE_URL =
  process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001/api";

export async function POST(request: NextRequest) {
  const payload = await request.json();

  // Admin auth lives ONLY under the console surface: /api/console/auth/login.
  const response = await fetch(`${BACKEND_BASE_URL}/console/auth/login`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify(payload),
    cache: "no-store"
  });

  const raw = await response.text();
  const data = raw ? JSON.parse(raw) : null;

  if (!response.ok) {
    return NextResponse.json(data ?? { message: "Login failed" }, { status: response.status });
  }

  const session = data as AuthSession;
  const cookieStore = await cookies();

  cookieStore.set(CONSOLE_AUTH_COOKIE, session.accessToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureConsoleCookie(request),
    path: "/",
    maxAge: CONSOLE_AUTH_MAX_AGE
  });

  return NextResponse.json({
    user: session.user
  });
}
