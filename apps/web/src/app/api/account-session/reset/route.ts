import { NextRequest, NextResponse } from "next/server";

import { getBackendBaseUrl, safeParseJson } from "@/lib/backend-url";

export async function POST(request: NextRequest) {
  const payload = await request.json();

  let response: Response;
  let raw: string;
  try {
    response = await fetch(`${getBackendBaseUrl()}/account/auth/reset-password`, {
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
      data && typeof data === "object" ? data : { message: "Reset failed" };
    return NextResponse.json(errorBody, { status: response.status });
  }

  return NextResponse.json({ ok: true });
}
