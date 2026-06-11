import { NextRequest, NextResponse } from "next/server";

import { getBackendBaseUrl, safeParseJson } from "../../../../lib/backend-url";

/**
 * Email verification — unauthenticated by design: the user clicks the link
 * from their inbox and may not have a session cookie yet. No cookie is read
 * or written here; the page links to /app afterwards.
 */
export async function POST(request: NextRequest) {
  // Guard the body parse — a malformed JSON body must not throw a 500 that
  // the page would surface as "invalid token".
  const rawBody = await request.text();
  const payload = rawBody ? safeParseJson(rawBody) : null;
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "BAD_REQUEST" }, { status: 400 });
  }

  let response: Response;
  let raw: string;
  try {
    response = await fetch(`${getBackendBaseUrl()}/web/auth/verify-email`, {
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

  if (!response.ok) {
    const data = raw ? safeParseJson(raw) : null;
    // Non-JSON bodies (HTML error pages) become a structured fallback.
    const errorBody =
      data && typeof data === "object" ? data : { error: "INVALID_TOKEN" };
    return NextResponse.json(errorBody, { status: response.status });
  }

  return NextResponse.json({ ok: true });
}
